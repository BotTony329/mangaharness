/**
 * A deterministic test puppet (§19).
 *
 * The automatic compiler is explicitly out of scope for this phase, so the
 * first vertical slice uses explicitly supplied parts — exactly the escape
 * hatch §10 allows. Geometry is hand-authored in puppet unit space (1 = puppet
 * height) and is stable, so tests can assert exact transforms.
 *
 * This is a fixture, not a fake: it produces a real MangaPuppet that the real
 * renderer, capability checker and commands consume unchanged.
 */

import type { ID } from "@/domain/types";
import {
  READY,
  type ExpressionDefinition,
  type MangaPuppet,
  type PuppetAttachment,
  type PuppetPart,
  type PuppetPartType,
  type Vec2,
} from "./model";

interface PartSpec {
  type: PuppetPartType;
  parent?: PuppetPartType;
  anchor: Vec2;
  pivot: Vec2;
  size: Vec2;
  zIndex: number;
  hiddenRegionComplete?: boolean;
}

/**
 * Layout of the slice puppet. Arms hang from the shoulders and chain
 * upper → lower → hand, so a shoulder rotation carries the whole limb.
 */
const LAYOUT: PartSpec[] = [
  { type: "torso", anchor: { x: 0.5, y: 0.52 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.30, y: 0.42 }, zIndex: 10 },

  { type: "hairBack", parent: "headBase", anchor: { x: 0, y: 0 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.30, y: 0.30 }, zIndex: 5 },
  { type: "headBase", parent: "torso", anchor: { x: 0, y: -0.26 }, pivot: { x: 0.5, y: 0.78 }, size: { x: 0.24, y: 0.26 }, zIndex: 20 },
  { type: "faceBase", parent: "headBase", anchor: { x: 0, y: -0.01 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.20, y: 0.20 }, zIndex: 22 },
  { type: "eyeLeft", parent: "headBase", anchor: { x: -0.045, y: -0.02 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.05, y: 0.035 }, zIndex: 26 },
  { type: "eyeRight", parent: "headBase", anchor: { x: 0.045, y: -0.02 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.05, y: 0.035 }, zIndex: 26 },
  { type: "browLeft", parent: "headBase", anchor: { x: -0.045, y: -0.055 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.05, y: 0.014 }, zIndex: 27 },
  { type: "browRight", parent: "headBase", anchor: { x: 0.045, y: -0.055 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.05, y: 0.014 }, zIndex: 27 },
  { type: "mouth", parent: "headBase", anchor: { x: 0, y: 0.045 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.05, y: 0.025 }, zIndex: 26 },
  { type: "hairFront", parent: "headBase", anchor: { x: 0, y: -0.055 }, pivot: { x: 0.5, y: 0.5 }, size: { x: 0.26, y: 0.14 }, zIndex: 30 },

  // Arms. hiddenRegionComplete is false on the upper arms because the fixture
  // parts were cut from a flat drawing and the torso behind them was never
  // reconstructed — the capability checker reports this honestly.
  { type: "upperArmLeft", parent: "torso", anchor: { x: -0.14, y: -0.16 }, pivot: { x: 0.5, y: 0.1 }, size: { x: 0.07, y: 0.17 }, zIndex: 8, hiddenRegionComplete: false },
  { type: "lowerArmLeft", parent: "upperArmLeft", anchor: { x: 0, y: 0.15 }, pivot: { x: 0.5, y: 0.1 }, size: { x: 0.06, y: 0.16 }, zIndex: 7 },
  { type: "handLeft", parent: "lowerArmLeft", anchor: { x: 0, y: 0.14 }, pivot: { x: 0.5, y: 0.2 }, size: { x: 0.06, y: 0.07 }, zIndex: 6 },

  { type: "upperArmRight", parent: "torso", anchor: { x: 0.14, y: -0.16 }, pivot: { x: 0.5, y: 0.1 }, size: { x: 0.07, y: 0.17 }, zIndex: 8, hiddenRegionComplete: false },
  { type: "lowerArmRight", parent: "upperArmRight", anchor: { x: 0, y: 0.15 }, pivot: { x: 0.5, y: 0.1 }, size: { x: 0.06, y: 0.16 }, zIndex: 7 },
  { type: "handRight", parent: "lowerArmRight", anchor: { x: 0, y: 0.14 }, pivot: { x: 0.5, y: 0.2 }, size: { x: 0.06, y: 0.07 }, zIndex: 6 },
];

/** Facial slots that get a second variant, so expressions have something to swap. */
const SHOCK_VARIANTS: PuppetPartType[] = ["eyeLeft", "eyeRight", "browLeft", "browRight", "mouth"];

export interface PuppetFixtureOptions {
  characterId: ID;
  puppetId?: ID;
  /** Texture id for a part; defaults to a stable synthetic id per part. */
  textureFor?: (type: PuppetPartType, variant: string) => ID;
}

/**
 * Build the slice puppet: a full body plus neutral and shocked facial variants.
 *
 * Part ids are deterministic (`type` or `type:variant`) so a test can assert
 * that body texture ids are untouched by an expression change without holding
 * onto references.
 */
export function createFixturePuppet(options: PuppetFixtureOptions): MangaPuppet {
  const texture = options.textureFor ?? ((type, variant) => `tex:${type}:${variant}`);
  const parts: Record<ID, PuppetPart> = {};
  const partOrder: ID[] = [];

  const add = (spec: PartSpec, variant: string) => {
    const id = variant === "base" ? spec.type : `${spec.type}:${variant}`;
    parts[id] = {
      id,
      type: spec.type,
      textureAssetId: texture(spec.type, variant),
      parentPartId: spec.parent,
      anchor: spec.anchor,
      pivot: spec.pivot,
      size: spec.size,
      zIndex: spec.zIndex,
      visible: true,
      readiness: { ...READY, hiddenRegionComplete: spec.hiddenRegionComplete ?? true },
    };
    partOrder.push(id);
    return id;
  };

  for (const spec of LAYOUT) add(spec, "base");
  const shockParts: Partial<Record<PuppetPartType, ID>> = {};
  for (const type of SHOCK_VARIANTS) {
    const spec = LAYOUT.find((candidate) => candidate.type === type)!;
    shockParts[type] = add(spec, "shocked");
  }

  const neutral: ExpressionDefinition = {
    id: "neutral",
    name: "Neutral",
    parts: {
      eyeLeft: "eyeLeft",
      eyeRight: "eyeRight",
      browLeft: "browLeft",
      browRight: "browRight",
      mouth: "mouth",
    },
  };
  const shocked: ExpressionDefinition = { id: "shocked", name: "Shocked", parts: shockParts };

  const phone: PuppetAttachment = {
    id: "phone",
    partType: "handRight",
    textureAssetId: texture("handRight", "phone"),
    offset: { x: 0, y: 0.02 },
    size: { x: 0.04, y: 0.06 },
    rotation: 0,
    label: "Phone",
  };

  // Sort once so the renderer can walk partOrder directly.
  partOrder.sort((a, b) => parts[a].zIndex - parts[b].zIndex);

  return {
    id: options.puppetId ?? `puppet:${options.characterId}`,
    characterId: options.characterId,
    version: 1,
    aspect: 0.5,
    parts,
    partOrder,
    expressions: { neutral, shocked },
    attachments: { phone },
    defaultExpressionId: "neutral",
    compilerMetadata: {
      source: "fixture",
      notes:
        "Hand-authored slice puppet. Upper-arm hidden regions are not reconstructed, so large shoulder swings report approximate quality.",
    },
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

/** Body parts — everything an expression change must leave untouched. */
export function bodyPartTypes(): PuppetPartType[] {
  return [
    "torso",
    "headBase",
    "faceBase",
    "hairBack",
    "hairFront",
    "upperArmLeft",
    "lowerArmLeft",
    "handLeft",
    "upperArmRight",
    "lowerArmRight",
    "handRight",
  ];
}
