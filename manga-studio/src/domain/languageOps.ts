/**
 * Manga Language Library operations: pure `doc → doc` transforms, like every
 * other domain module. Built-ins are never written here — only what the
 * creator uploads, generates, or customizes.
 */

import { newId, now } from "./factory";
import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import { addBubble, addEffect, placeAsset } from "./itemOps";
import { defaultBubbleStyle, normalizeBubbleStyle } from "./bubbleStyles";
import { findLanguageAsset, languageSourceAsset } from "@/language/library";
import type {
  ID,
  ItemAttachment,
  MangaLanguageAsset,
  MangaLanguageCategory,
  MangaLanguageFormat,
  MangaLanguageGenerationMetadata,
  MangaLanguageSource,
  Point,
  ProjectDocument,
  StructuredLanguageDefinition,
} from "./types";

export interface NewLanguageAssetInput {
  category: MangaLanguageCategory;
  name: string;
  source: MangaLanguageSource;
  format: MangaLanguageFormat;
  tags?: string[];
  structuredDefinition?: StructuredLanguageDefinition;
  assetId?: ID;
  thumbnailUrl?: string;
  generationMetadata?: MangaLanguageGenerationMetadata;
}

export function addLanguageAsset(
  doc: ProjectDocument,
  input: NewLanguageAssetInput,
): { doc: ProjectDocument; languageAssetId: ID } {
  if (input.format === "visual" && !input.assetId) {
    throw new Error("A visual language asset needs an image");
  }
  if (input.format === "structured" && !input.structuredDefinition) {
    throw new Error("A structured language asset needs a definition");
  }
  const next = cloneDoc(doc);
  const asset: MangaLanguageAsset = {
    id: newId(),
    projectId: next.project.id,
    category: input.category,
    name: input.name.trim() || "Untitled",
    source: input.source,
    format: input.format,
    tags: normalizeTags(input.tags),
    structuredDefinition: input.structuredDefinition,
    assetId: input.assetId,
    thumbnailUrl: input.thumbnailUrl,
    generationMetadata: input.generationMetadata,
    createdAt: now(),
  };
  next.language[asset.id] = asset;
  touch(next);
  return { doc: next, languageAssetId: asset.id };
}

/**
 * Edits apply only to owned assets. A built-in is code; renaming or deleting
 * one would be editing the application, not the project.
 */
export function updateLanguageAsset(
  doc: ProjectDocument,
  languageAssetId: ID,
  patch: { name?: string; tags?: string[]; category?: MangaLanguageCategory },
): ProjectDocument {
  const next = cloneDoc(doc);
  const asset = requireOwned(next, languageAssetId);
  if (patch.name !== undefined && patch.name.trim()) asset.name = patch.name.trim();
  if (patch.tags !== undefined) asset.tags = normalizeTags(patch.tags);
  if (patch.category !== undefined) asset.category = patch.category;
  asset.updatedAt = now();
  touch(next);
  return next;
}

export function duplicateLanguageAsset(
  doc: ProjectDocument,
  languageAssetId: ID,
): { doc: ProjectDocument; languageAssetId: ID } {
  const source = findLanguageAsset(doc, languageAssetId);
  if (!source) throw new Error(`Unknown language asset: ${languageAssetId}`);
  const next = cloneDoc(doc);
  const copy: MangaLanguageAsset = {
    ...structuredClone(source),
    id: newId(),
    projectId: next.project.id,
    // A duplicate of a built-in becomes the creator's own editable asset.
    source: source.source === "builtin" ? "builtin" : source.source,
    builtinId: undefined,
    name: `${source.name} copy`,
    createdAt: now(),
    updatedAt: undefined,
  };
  next.language[copy.id] = copy;
  touch(next);
  return { doc: next, languageAssetId: copy.id };
}

/**
 * Remove an owned language asset.
 *
 * Items already placed from it are left alone: they carry their own definition
 * or source asset, so deleting the library entry must not silently gut pages
 * the creator already composed.
 */
export function deleteLanguageAsset(doc: ProjectDocument, languageAssetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  requireOwned(next, languageAssetId);
  delete next.language[languageAssetId];
  touch(next);
  return next;
}

// ─── Placement (§10) ────────────────────────────────────────────────────────

export interface PlaceLanguageAssetInput {
  panelId: ID;
  languageAssetId: ID;
  /** Panel-local center. Defaults per kind: bubbles near the top, effects fill. */
  at?: Point;
  /** Text for a bubble or SFX placement; the preset's own text otherwise. */
  text?: string;
  /** Attach to this item so the effect follows it (§11). */
  attachToItemId?: ID;
}

/**
 * One entry point for placing any language asset — structured or visual.
 *
 * Structured assets become the editable items they already were (bubbles,
 * effects); visual assets become ordinary AssetInstances, so they inherit
 * transforms, z-order, camera staging and export with no new machinery.
 */
export function placeLanguageAsset(
  doc: ProjectDocument,
  input: PlaceLanguageAssetInput,
): { doc: ProjectDocument; itemId: ID } {
  const asset = findLanguageAsset(doc, input.languageAssetId);
  if (!asset) throw new Error(`Unknown language asset: ${input.languageAssetId}`);
  if (!doc.panels[input.panelId]) throw new Error(`Unknown panel: ${input.panelId}`);

  const placed = instantiate(doc, asset, input);
  let next = placed.doc;
  const item = next.items[placed.itemId];
  if (item) {
    if (item.kind === "bubble" || item.kind === "effect") item.languageAssetId = asset.id;
  }
  if (input.attachToItemId) {
    next = attachItem(next, placed.itemId, input.attachToItemId);
  }
  touch(next);
  return { doc: next, itemId: placed.itemId };
}

function instantiate(
  doc: ProjectDocument,
  asset: MangaLanguageAsset,
  input: PlaceLanguageAssetInput,
): { doc: ProjectDocument; itemId: ID } {
  if (asset.format === "visual") {
    const source = languageSourceAsset(doc, asset);
    if (!source) throw new Error(`"${asset.name}" has no usable image yet`);
    const result = placeAsset(doc, input.panelId, source.id, { cropMode: "fit" });
    const item = result.doc.items[result.itemId];
    if (item && input.at) {
      item.cx = input.at.x;
      item.cy = input.at.y;
    }
    return result;
  }

  const definition = asset.structuredDefinition!;
  switch (definition.kind) {
    case "bubble":
    case "sfx": {
      const bubbleType = definition.kind === "sfx" ? ("sfx" as const) : definition.bubbleType;
      const text = input.text ?? (definition.kind === "sfx" ? definition.text : "…");
      const result = addBubble(doc, input.panelId, bubbleType, text, input.at);
      const item = result.doc.items[result.itemId];
      if (item?.kind === "bubble") {
        item.style = normalizeBubbleStyle(bubbleType, definition.style ?? defaultBubbleStyle(bubbleType));
        if (bubbleType === "sfx") {
          // Lettering is sized to read as impact, and carries no tail.
          const rect = panelPxRect(result.doc, input.panelId);
          item.fontSize = Math.round(Math.min(rect.width, rect.height) * 0.16);
          item.height = item.fontSize * 1.6;
          item.width = Math.max(item.width, item.fontSize * Math.max(2, text.length));
          item.tail = undefined;
        }
      }
      return result;
    }
    case "effect": {
      const result = addEffect(doc, input.panelId, definition.effectKind, definition.params ?? {});
      const item = result.doc.items[result.itemId];
      if (item?.kind === "effect" && input.at) {
        // An emotion mark or a localized burst is placed where it was dropped;
        // a full-panel tone keeps covering the panel.
        const localized = definition.effectKind === "emotion";
        if (localized) {
          const rect = panelPxRect(result.doc, input.panelId);
          item.width = rect.width * 0.3;
          item.height = rect.height * 0.3;
          item.cx = input.at.x;
          item.cy = input.at.y;
        }
      }
      return result;
    }
  }
}

// ─── Attachment (§11) ───────────────────────────────────────────────────────

/**
 * Attach one item to another so it travels with it.
 *
 * The offset is captured in the target's own frame at attach time, so later
 * moves, resizes and camera restaging all carry the effect correctly instead
 * of drifting away from the subject.
 */
export function attachItem(
  doc: ProjectDocument,
  itemId: ID,
  targetItemId: ID,
  anchor: Point = { x: 0.5, y: 0.5 },
): ProjectDocument {
  if (itemId === targetItemId) throw new Error("An item cannot attach to itself");
  const next = cloneDoc(doc);
  const item = next.items[itemId];
  const target = next.items[targetItemId];
  if (!item || !target) throw new Error("Unknown item");
  if (item.panelId !== target.panelId) throw new Error("Items must be in the same panel to attach");

  const anchorPoint = anchorPosition(target, anchor);
  const height = Math.max(1, target.height);
  const attachment: ItemAttachment = {
    targetItemId,
    anchor,
    offset: { x: (item.cx - anchorPoint.x) / height, y: (item.cy - anchorPoint.y) / height },
    scaleWithTarget: true,
    baseTargetHeight: height,
  };
  item.attachment = attachment;
  touch(next);
  return next;
}

/** Detach: the item keeps exactly where it is and returns to panel space. */
export function detachItem(doc: ProjectDocument, itemId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.items[itemId];
  if (!item?.attachment) return doc;
  delete item.attachment;
  touch(next);
  return next;
}

/**
 * Recompute every attached item's position in a panel.
 *
 * Called after anything that can move a subject — a drag, a depth change, a
 * camera restage — so "sweat drop follows Yuri" is a property of the document
 * rather than something the UI has to remember to maintain.
 */
export function applyAttachments(doc: ProjectDocument, panelId: ID): ProjectDocument {
  const panel = doc.panels[panelId];
  if (!panel) return doc;
  const next = cloneDoc(doc);
  for (const itemId of next.panels[panelId].itemIds) {
    const item = next.items[itemId];
    const attachment = item?.attachment;
    if (!item || !attachment) continue;
    const target = next.items[attachment.targetItemId];
    // A target that was deleted leaves the item where it is, in panel space,
    // rather than snapping it to the origin.
    if (!target || target.panelId !== panelId) {
      delete item.attachment;
      continue;
    }
    const height = Math.max(1, target.height);
    const anchorPoint = anchorPosition(target, attachment.anchor);
    item.cx = anchorPoint.x + attachment.offset.x * height;
    item.cy = anchorPoint.y + attachment.offset.y * height;
    if (attachment.scaleWithTarget && attachment.baseTargetHeight) {
      const ratio = height / attachment.baseTargetHeight;
      if (Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.001) {
        item.width *= ratio;
        item.height *= ratio;
        attachment.baseTargetHeight = height;
      }
    }
  }
  touch(next);
  return next;
}

/** Items attached to a given target, e.g. everything that follows Yuri. */
export function attachedItems(doc: ProjectDocument, targetItemId: ID): ID[] {
  return Object.values(doc.items)
    .filter((item) => item.attachment?.targetItemId === targetItemId)
    .map((item) => item.id);
}

function anchorPosition(target: { cx: number; cy: number; width: number; height: number }, anchor: Point): Point {
  return {
    x: target.cx + (anchor.x - 0.5) * target.width,
    y: target.cy + (anchor.y - 0.5) * target.height,
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? [])
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length <= 32),
    ),
  ].slice(0, 16);
}

function requireOwned(doc: ProjectDocument, languageAssetId: ID): MangaLanguageAsset {
  const asset = doc.language[languageAssetId];
  if (!asset) {
    throw new Error(
      findLanguageAsset(doc, languageAssetId)
        ? "Built-in manga language assets cannot be edited or deleted. Duplicate it first."
        : `Unknown language asset: ${languageAssetId}`,
    );
  }
  return asset;
}
