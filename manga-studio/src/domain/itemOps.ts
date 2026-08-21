/**
 * Mutations for panel items (instances, bubbles, effects). These are the
 * shared command core: the manual editor UI and the Manga Agent both go
 * through these functions — there is no second write path.
 */

import { cloneDoc, insertIndexForBand, itemBand, panelPxRect, touch } from "./docHelpers";
import { newId } from "./factory";
import { cropModeTransform, fitTransform } from "./geometry";
import { normalizeEffectParams } from "./effects";
import { bubbleHasTail, defaultBubbleStyle, resolvedBubbleStyle, updateBubbleStyle } from "./bubbleStyles";
import { stateFromAsset } from "@/characters/state";
import { syncPanelScene } from "./sceneOps";
import type {
  AssetInstance,
  BubbleStyle,
  BubbleType,
  CropMode,
  EffectItem,
  EffectKind,
  ID,
  PanelItem,
  ProjectDocument,
  SpeechBubbleItem,
} from "./types";

// ─── Placement ──────────────────────────────────────────────────────────────

export interface PlaceAssetOptions {
  /** Drop point in panel-local pixels; defaults to the crop-mode transform position. */
  at?: { x: number; y: number };
  cropMode?: CropMode;
}

/**
 * Place a source asset into a panel as a new independent instance.
 * Backgrounds default to Fill (they should cover the panel); everything else
 * defaults to Fit. The source asset itself is never touched.
 */
export function placeAsset(
  doc: ProjectDocument,
  panelId: ID,
  sourceAssetId: ID,
  options: PlaceAssetOptions = {},
): { doc: ProjectDocument; itemId: ID } {
  const asset = doc.assets[sourceAssetId];
  if (!asset) throw new Error(`Unknown asset: ${sourceAssetId}`);
  if (!doc.panels[panelId]) throw new Error(`Unknown panel: ${panelId}`);

  const next = cloneDoc(doc);
  const panelRect = panelPxRect(next, panelId);
  const cropMode = options.cropMode ?? (asset.category === "background" ? "fill" : "fit");
  const transform =
    cropModeTransform(cropMode, asset, panelRect.width, panelRect.height) ??
    fitTransform(asset.width, asset.height, panelRect.width, panelRect.height);

  const item: AssetInstance = {
    id: newId(),
    kind: "asset",
    panelId,
    sourceAssetId,
    cx: options.at?.x ?? transform.cx,
    cy: options.at?.y ?? transform.cy,
    width: transform.width,
    height: transform.height,
    rotation: 0,
    opacity: 1,
    flipX: false,
    cropMode,
    characterState: stateFromAsset(asset) ?? undefined,
  };
  insertItem(next, item);
  syncPanelScene(next, panelId);
  touch(next);
  return { doc: next, itemId: item.id };
}

export function addBubble(
  doc: ProjectDocument,
  panelId: ID,
  bubbleType: BubbleType,
  text = "...",
  at?: { x: number; y: number },
): { doc: ProjectDocument; itemId: ID } {
  if (!doc.panels[panelId]) throw new Error(`Unknown panel: ${panelId}`);
  const next = cloneDoc(doc);
  const panelRect = panelPxRect(next, panelId);
  const width = Math.min(280, panelRect.width * 0.6);
  const height = Math.min(140, panelRect.height * 0.35);
  const cx = at?.x ?? panelRect.width * 0.5;
  const cy = at?.y ?? panelRect.height * 0.22;
  const item: SpeechBubbleItem = {
    id: newId(),
    kind: "bubble",
    panelId,
    bubbleType,
    text,
    fontSize: 22,
    style: defaultBubbleStyle(bubbleType),
    cx,
    cy,
    width,
    height,
    rotation: 0,
    opacity: 1,
    // Narration boxes, internal monologue and SFX carry no tail by design.
    tail: bubbleHasTail(bubbleType, defaultBubbleStyle(bubbleType)) ? { x: cx, y: cy + height } : undefined,
  };
  insertItem(next, item);
  syncPanelScene(next, panelId);
  touch(next);
  return { doc: next, itemId: item.id };
}

export function addEffect(
  doc: ProjectDocument,
  panelId: ID,
  effectKind: EffectKind,
  params: Record<string, unknown> = {},
): { doc: ProjectDocument; itemId: ID } {
  if (!doc.panels[panelId]) throw new Error(`Unknown panel: ${panelId}`);
  const next = cloneDoc(doc);
  const panelRect = panelPxRect(next, panelId);
  const item: EffectItem = {
    id: newId(),
    kind: "effect",
    panelId,
    effectKind,
    params: normalizeEffectParams(effectKind, params),
    cx: panelRect.width / 2,
    cy: panelRect.height / 2,
    width: panelRect.width,
    height: panelRect.height,
    rotation: 0,
    opacity: 1,
  };
  insertItem(next, item);
  touch(next);
  return { doc: next, itemId: item.id };
}

// ─── Editing ────────────────────────────────────────────────────────────────

export interface TransformPatch {
  cx?: number;
  cy?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

/**
 * Manual transforms move an asset instance into "custom" crop mode — the
 * framing modes compute a starting transform, after which the user owns it.
 */
export function updateItemTransform(doc: ProjectDocument, itemId: ID, patch: TransformPatch): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  Object.assign(item, patch);
  if (item.kind === "asset") item.cropMode = "custom";
  touch(next);
  return next;
}

export function setCropMode(doc: ProjectDocument, itemId: ID, mode: CropMode): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  if (item.kind !== "asset") throw new Error("Crop modes only apply to asset instances");
  const asset = next.assets[item.sourceAssetId];
  if (!asset) throw new Error(`Unknown asset: ${item.sourceAssetId}`);
  const panelRect = panelPxRect(next, item.panelId);
  const transform = cropModeTransform(mode, asset, panelRect.width, panelRect.height);
  // "face" without region metadata returns null — the mode is unavailable, not faked.
  if (transform === null && mode !== "custom") return doc;
  item.cropMode = mode;
  if (transform) {
    Object.assign(item, transform);
    item.rotation = 0;
  }
  touch(next);
  return next;
}

/**
 * Semantic asset switching: replace which source asset an instance shows
 * ("Pose: Standing → Running") while preserving the composition — position,
 * panel membership, z-order, rotation, flip. Non-custom crop modes recompute
 * for the new asset's dimensions; custom keeps the height and follows the
 * new aspect ratio. The panel is never recreated.
 */
export function swapInstanceAsset(doc: ProjectDocument, itemId: ID, newSourceAssetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  if (item.kind !== "asset") throw new Error("Only asset instances can swap sources");
  const asset = next.assets[newSourceAssetId];
  if (!asset) throw new Error(`Unknown asset: ${newSourceAssetId}`);

  item.sourceAssetId = newSourceAssetId;
  const nextState = stateFromAsset(asset);
  if (nextState) item.characterState = nextState;
  else delete item.characterState;
  syncPanelScene(next, item.panelId);
  // Semantic changes replace only the visual source. Composition belongs to
  // the instance and stays untouched: panel, center, size, crop, rotation,
  // flip, opacity, and z-order all survive the swap.
  touch(next);
  return next;
}

export function updateBubble(
  doc: ProjectDocument,
  itemId: ID,
  patch: Partial<Pick<SpeechBubbleItem, "text" | "fontSize" | "bubbleType" | "tail">> & {
    style?: Partial<BubbleStyle>;
  },
): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  if (item.kind !== "bubble") throw new Error("Not a bubble");
  const { style, ...rest } = patch;
  Object.assign(item, rest);
  /**
   * Changing the semantic type re-bases appearance on that type's default,
   * then re-applies whatever the creator explicitly customized — so switching
   * speech → horror actually looks like horror, without discarding a hand-set
   * border weight.
   */
  if (rest.bubbleType && rest.bubbleType !== doc.items[itemId]?.["bubbleType" as never]) {
    item.style = updateBubbleStyle(item.bubbleType, defaultBubbleStyle(item.bubbleType), style ?? {});
  } else if (style) {
    item.style = updateBubbleStyle(item.bubbleType, item.style, style);
  }
  if (!bubbleHasTail(item.bubbleType, resolvedBubbleStyle(item))) item.tail = undefined;
  touch(next);
  return next;
}

export function updateItemProps(
  doc: ProjectDocument,
  itemId: ID,
  patch: Partial<Pick<AssetInstance, "opacity" | "flipX" | "visible" | "locked">> &
    Partial<Pick<EffectItem, "params">>,
): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  const { params, ...rest } = patch;
  Object.assign(item, rest);
  if (params && item.kind === "effect") item.params = { ...item.params, ...params };
  touch(next);
  return next;
}

export function removeItem(doc: ProjectDocument, itemId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.items[itemId];
  if (!item) return next;
  delete next.items[itemId];
  const panel = next.panels[item.panelId];
  if (panel) panel.itemIds = panel.itemIds.filter((id) => id !== itemId);
  if (panel) syncPanelScene(next, item.panelId);
  touch(next);
  return next;
}

export function duplicateItem(doc: ProjectDocument, itemId: ID): { doc: ProjectDocument; itemId: ID } {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  const copy: PanelItem = { ...structuredClone(item), id: newId(), cx: item.cx + 24, cy: item.cy + 24 };
  next.items[copy.id] = copy;
  const panel = next.panels[item.panelId];
  const sourceIndex = panel.itemIds.indexOf(itemId);
  panel.itemIds.splice(sourceIndex + 1, 0, copy.id);
  touch(next);
  return { doc: next, itemId: copy.id };
}

// ─── Layer order ────────────────────────────────────────────────────────────

export type ReorderDirection = "forward" | "backward" | "front" | "back";

export function reorderItem(doc: ProjectDocument, itemId: ID, direction: ReorderDirection): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  const ids = next.panels[item.panelId].itemIds;
  const from = ids.indexOf(itemId);
  if (from === -1) return doc;
  const to = {
    forward: Math.min(from + 1, ids.length - 1),
    backward: Math.max(from - 1, 0),
    front: ids.length - 1,
    back: 0,
  }[direction];
  ids.splice(from, 1);
  ids.splice(to, 0, itemId);
  touch(next);
  return next;
}

/**
 * Move an item to an absolute position in the panel's draw order.
 *
 * The Layers panel needs this: dragging a row to a position is an absolute
 * move, and expressing it as repeated relative steps would fire one document
 * mutation per hop. Index 0 is the back of the panel, matching `itemIds`.
 */
export function moveItemToIndex(doc: ProjectDocument, itemId: ID, index: number): ProjectDocument {
  const next = cloneDoc(doc);
  const item = requireItem(next, itemId);
  const ids = next.panels[item.panelId].itemIds;
  const from = ids.indexOf(itemId);
  if (from === -1) return doc;
  const to = Math.max(0, Math.min(ids.length - 1, Math.round(index)));
  if (to === from) return doc;
  ids.splice(from, 1);
  ids.splice(to, 0, itemId);
  touch(next);
  return next;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function requireItem(doc: ProjectDocument, itemId: ID): PanelItem {
  const item = doc.items[itemId];
  if (!item) throw new Error(`Unknown item: ${itemId}`);
  return item;
}

function insertItem(doc: ProjectDocument, item: PanelItem): void {
  doc.items[item.id] = item;
  const panel = doc.panels[item.panelId];
  const index = insertIndexForBand(doc, panel.itemIds, itemBand(doc, item));
  panel.itemIds.splice(index, 0, item.id);
}
