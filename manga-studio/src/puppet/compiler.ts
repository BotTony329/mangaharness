/**
 * Puppet Compiler v1 — a semi-assisted on-ramp (V3.2 §6/§7).
 *
 * **Automatic segmentation is not solved here, and this module does not pretend
 * it is.** What it does:
 *
 *   1. proposes part regions from standard manga proportions,
 *   2. lets the creator confirm or adjust each rectangle,
 *   3. builds a real `MangaPuppet` whose parts are CROPS of the canonical
 *      render (`PuppetPart.sourceRect`) rather than invented cutout assets.
 *
 * Cropping a confirmed rectangle out of one image is honest: no pixels are
 * fabricated, the source asset is never modified, and every part's provenance
 * is a rectangle a human agreed to. What it cannot do is recover the material
 * *behind* a part — see `hiddenRegionComplete`, which stays false until the
 * reconstruction step in §9 actually produces an underlayer.
 */

import { newId, now } from "@/domain/factory";
import type { ID } from "@/domain/types";
import {
  READY,
  type ExpressionDefinition,
  type MangaPuppet,
  type PuppetPart,
  type PuppetPartType,
  type SourceRect,
  type Vec2,
} from "./model";

/** One proposed or confirmed part region on the canonical render. */
export interface PartRegion {
  type: PuppetPartType;
  /** Region in normalized SOURCE-IMAGE coordinates (0..1). */
  rect: SourceRect;
  /**
   * Confirmed by a human. An unconfirmed region is a guess from proportions,
   * and the compiler records that distinction rather than burying it.
   */
  confirmed: boolean;
  /** Reconstructed underlayer for what this part covers, when one exists. */
  hiddenRegionAssetId?: ID;
}

interface PartTemplate {
  type: PuppetPartType;
  parent?: PuppetPartType;
  /** Proposed region, in fractions of the source image. */
  rect: SourceRect;
  /** Pivot inside the part's own rect (0..1). */
  pivot: Vec2;
  zIndex: number;
  /** Parts whose material sits on top of something else. */
  occludes?: boolean;
}

/**
 * Standard manga proportions for a full-body front-view render.
 *
 * These are a STARTING PROPOSAL, not a detection result. Real drawings vary;
 * step 2 of the workflow exists precisely because these rectangles will be
 * wrong for any given character until a human moves them.
 */
const PROPOSAL: PartTemplate[] = [
  { type: "hairBack", parent: "headBase", rect: { x: 0.30, y: 0.02, width: 0.40, height: 0.22 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 5 },
  { type: "torso", rect: { x: 0.30, y: 0.22, width: 0.40, height: 0.42 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 10 },
  { type: "headBase", parent: "torso", rect: { x: 0.34, y: 0.03, width: 0.32, height: 0.19 }, pivot: { x: 0.5, y: 0.9 }, zIndex: 20 },
  { type: "faceBase", parent: "headBase", rect: { x: 0.37, y: 0.07, width: 0.26, height: 0.14 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 22 },
  { type: "eyeLeft", parent: "headBase", rect: { x: 0.39, y: 0.115, width: 0.09, height: 0.035 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 26 },
  { type: "eyeRight", parent: "headBase", rect: { x: 0.52, y: 0.115, width: 0.09, height: 0.035 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 26 },
  { type: "browLeft", parent: "headBase", rect: { x: 0.39, y: 0.095, width: 0.09, height: 0.016 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 27 },
  { type: "browRight", parent: "headBase", rect: { x: 0.52, y: 0.095, width: 0.09, height: 0.016 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 27 },
  { type: "mouth", parent: "headBase", rect: { x: 0.46, y: 0.165, width: 0.08, height: 0.025 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 26 },
  { type: "hairFront", parent: "headBase", rect: { x: 0.32, y: 0.03, width: 0.36, height: 0.09 }, pivot: { x: 0.5, y: 0.5 }, zIndex: 30 },

  // Arms occlude the torso, so their hidden regions start incomplete.
  { type: "upperArmLeft", parent: "torso", rect: { x: 0.20, y: 0.25, width: 0.11, height: 0.18 }, pivot: { x: 0.5, y: 0.08 }, zIndex: 8, occludes: true },
  { type: "lowerArmLeft", parent: "upperArmLeft", rect: { x: 0.19, y: 0.42, width: 0.10, height: 0.17 }, pivot: { x: 0.5, y: 0.08 }, zIndex: 7, occludes: true },
  { type: "handLeft", parent: "lowerArmLeft", rect: { x: 0.19, y: 0.58, width: 0.10, height: 0.08 }, pivot: { x: 0.5, y: 0.2 }, zIndex: 6 },

  { type: "upperArmRight", parent: "torso", rect: { x: 0.69, y: 0.25, width: 0.11, height: 0.18 }, pivot: { x: 0.5, y: 0.08 }, zIndex: 8, occludes: true },
  { type: "lowerArmRight", parent: "upperArmRight", rect: { x: 0.71, y: 0.42, width: 0.10, height: 0.17 }, pivot: { x: 0.5, y: 0.08 }, zIndex: 7, occludes: true },
  { type: "handRight", parent: "lowerArmRight", rect: { x: 0.71, y: 0.58, width: 0.10, height: 0.08 }, pivot: { x: 0.5, y: 0.2 }, zIndex: 6 },
];

/** The parts Compiler v1 targets, in workflow order. */
export const COMPILER_PART_TYPES: PuppetPartType[] = PROPOSAL.map((template) => template.type);

/** Step 1: auto-proposed parts. Every region starts UNCONFIRMED. */
export function proposePartRegions(): PartRegion[] {
  return PROPOSAL.map((template) => ({ type: template.type, rect: { ...template.rect }, confirmed: false }));
}

export interface CompilerIssue {
  partType?: PuppetPartType;
  severity: "blocking" | "warning";
  message: string;
}

/**
 * Step 2/3 validation. Warnings are honest, not decorative: a puppet built from
 * unconfirmed proportions will not line up with the artwork, and one whose arms
 * still cover unreconstructed torso cannot claim large swings are safe.
 */
export function compilerIssues(regions: PartRegion[]): CompilerIssue[] {
  const issues: CompilerIssue[] = [];
  const byType = new Map(regions.map((region) => [region.type, region]));

  for (const type of COMPILER_PART_TYPES) {
    const region = byType.get(type);
    if (!region) {
      issues.push({ partType: type, severity: "blocking", message: `${type} has no region.` });
      continue;
    }
    const { rect } = region;
    if (rect.width <= 0 || rect.height <= 0) {
      issues.push({ partType: type, severity: "blocking", message: `${type} has an empty region.` });
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      issues.push({ partType: type, severity: "blocking", message: `${type} extends outside the image.` });
    }
    if (!region.confirmed) {
      issues.push({
        partType: type,
        severity: "warning",
        message: `${type} is still the proposed proportion, not a confirmed region.`,
      });
    }
  }

  const occluders = PROPOSAL.filter((template) => template.occludes).map((template) => template.type);
  const missingHidden = occluders.filter((type) => !byType.get(type)?.hiddenRegionAssetId);
  if (missingHidden.length > 0) {
    issues.push({
      severity: "warning",
      message: `Hidden material behind ${missingHidden.join(", ")} was not reconstructed — large movements will be reported as approximate.`,
    });
  }
  return issues;
}

export function isCompilable(regions: PartRegion[]): boolean {
  return !compilerIssues(regions).some((issue) => issue.severity === "blocking");
}

export interface CompilePuppetInput {
  characterId: ID;
  /** The canonical transparent render the parts are cut from. */
  canonicalAssetId: ID;
  regions: PartRegion[];
  /** width / height of the source render, used to size parts in unit space. */
  sourceAspect: number;
  puppetId?: ID;
  /** Facial variants for other expressions, keyed expressionId → slot → region. */
  expressionRegions?: Record<string, { name: string; parts: Partial<Record<PuppetPartType, SourceRect>> }>;
}

/**
 * Step 4: build the puppet.
 *
 * Geometry is derived from the confirmed rectangles rather than hand-authored,
 * so the puppet lands on the artwork it was cut from. Anchors are computed as
 * the offset between a part's pivot and its parent's pivot, which is what makes
 * a shoulder rotate around the shoulder instead of around the image centre.
 */
export function compilePuppet(input: CompilePuppetInput): MangaPuppet {
  if (!isCompilable(input.regions)) {
    throw new Error("Cannot compile: some part regions are missing or invalid.");
  }
  const byType = new Map(input.regions.map((region) => [region.type, region]));
  const parts: Record<ID, PuppetPart> = {};
  const partOrder: ID[] = [];

  /**
   * Source rects are fractions of the image; puppet space is 1 = puppet height.
   * The image IS the puppet's height, so y fractions map through unchanged and
   * x fractions scale by the source aspect.
   */
  const toUnit = (rect: SourceRect) => ({
    size: { x: rect.width * input.sourceAspect, y: rect.height },
    center: { x: (rect.x + rect.width / 2) * input.sourceAspect, y: rect.y + rect.height / 2 },
  });

  const pivotPoint = (template: PartTemplate, rect: SourceRect) => {
    const unit = toUnit(rect);
    return {
      x: unit.center.x + (template.pivot.x - 0.5) * unit.size.x,
      y: unit.center.y + (template.pivot.y - 0.5) * unit.size.y,
    };
  };

  const pivots = new Map<PuppetPartType, Vec2>();
  for (const template of PROPOSAL) {
    pivots.set(template.type, pivotPoint(template, byType.get(template.type)!.rect));
  }

  const addPart = (template: PartTemplate, rect: SourceRect, variant: string, hiddenAssetId?: ID): ID => {
    const id = variant === "base" ? template.type : `${template.type}:${variant}`;
    const unit = toUnit(rect);
    const pivot = pivots.get(template.type)!;
    const parentPivot = template.parent ? pivots.get(template.parent) : undefined;
    parts[id] = {
      id,
      type: template.type,
      // Parts draw a crop of the canonical render — or of the reconstructed
      // underlayer, when §9 produced one for what this part covers.
      textureAssetId: input.canonicalAssetId,
      sourceRect: { ...rect },
      parentPartId: template.parent,
      anchor: parentPivot ? { x: pivot.x - parentPivot.x, y: pivot.y - parentPivot.y } : pivot,
      pivot: template.pivot,
      size: unit.size,
      zIndex: template.zIndex,
      visible: true,
      readiness: {
        ...READY,
        // The honest bit: a rectangle cut from a flat drawing has no material
        // behind it unless reconstruction actually produced some.
        hiddenRegionComplete: template.occludes ? Boolean(hiddenAssetId) : true,
      },
    };
    partOrder.push(id);
    return id;
  };

  for (const template of PROPOSAL) {
    const region = byType.get(template.type)!;
    addPart(template, region.rect, "base", region.hiddenRegionAssetId);
  }

  // ── Expressions ──
  const neutralParts: Partial<Record<PuppetPartType, ID>> = {};
  for (const type of FACE_SLOTS) neutralParts[type] = type;
  const expressions: Record<string, ExpressionDefinition> = {
    neutral: { id: "neutral", name: "Neutral", parts: neutralParts },
  };

  for (const [expressionId, definition] of Object.entries(input.expressionRegions ?? {})) {
    const slots: Partial<Record<PuppetPartType, ID>> = {};
    for (const [type, rect] of Object.entries(definition.parts)) {
      const template = PROPOSAL.find((candidate) => candidate.type === type);
      if (!template || !rect) continue;
      slots[type as PuppetPartType] = addPart(template, rect, expressionId);
    }
    if (Object.keys(slots).length > 0) {
      expressions[expressionId] = { id: expressionId, name: definition.name, parts: slots };
    }
  }

  partOrder.sort((a, b) => parts[a].zIndex - parts[b].zIndex);

  const unconfirmed = input.regions.filter((region) => !region.confirmed).length;
  return {
    id: input.puppetId ?? newId(),
    characterId: input.characterId,
    version: 1,
    aspect: input.sourceAspect,
    parts,
    partOrder,
    expressions,
    attachments: {},
    defaultExpressionId: "neutral",
    canonicalAssetId: input.canonicalAssetId,
    compilerMetadata: {
      source: "compiled",
      compiledAt: now(),
      notes: [
        "Compiler v1: parts are confirmed rectangular crops of the canonical render. No automatic segmentation was performed.",
        unconfirmed > 0 ? `${unconfirmed} region(s) were left at the proposed proportion.` : null,
      ]
        .filter(Boolean)
        .join(" "),
    },
    createdAt: now(),
  };
}

/** Facial slots an expression may replace. */
const FACE_SLOTS: PuppetPartType[] = ["eyeLeft", "eyeRight", "browLeft", "browRight", "mouth"];

/**
 * The instruction sent to the image-edit provider for hidden-region
 * reconstruction (§9).
 *
 * Deliberately narrow: this is a material-reconstruction task, not a redraw.
 * Naming what must be preserved is what keeps the provider from returning a
 * differently-designed character that happens to have a complete torso.
 */
export function hiddenRegionInstruction(partType: PuppetPartType): string {
  return [
    `This is a manga character drawing. The ${humanPart(partType)} currently covers part of the body behind it.`,
    `Redraw ONLY the area hidden behind the ${humanPart(partType)}, as if that limb were not there, so the body underneath is complete.`,
    "Keep the character's identity, face, hairstyle, proportions, outfit, line weight and art style exactly the same.",
    "Do not change colour, do not change the pose, do not restyle the drawing, and do not alter any pixel outside the hidden area.",
    "Keep the background completely transparent.",
  ].join(" ");
}

function humanPart(partType: PuppetPartType): string {
  return partType
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .replace(/\s+(left|right)$/, (match) => match)
    .trim();
}
