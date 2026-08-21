/**
 * The HitStack: one answer to "what is under the pointer".
 *
 * ## What this replaces
 *
 * Selection used to be Konva's own picking: every node wired its own
 * `onMouseDown={onSelect}` and whichever node Konva's hit graph reported first
 * won. That had three consequences the creator felt directly. An image node's
 * hit region is its full rectangle, so a character cutout's transparent corners
 * swallowed everything beneath them. `locked` only disabled dragging, never
 * listening, so a locked background still intercepted every click. And there
 * was no way to reach the second item under the pointer at all — no cycling, no
 * menu, no layer list.
 *
 * ## The rule
 *
 * Order is `panel.itemIds`, and nothing else. The last id is drawn last, so it
 * is visually topmost, so it is selected first. There is deliberately no
 * category ranking: if a creator puts a prop above a character, clicking the
 * visible prop selects the prop.
 *
 * This module is pure and has no Konva or DOM dependency, so the canvas, the
 * right-click menu, the Layers panel and the tests all consume the identical
 * resolver rather than three drifting approximations of it.
 */

import { resolvedBubbleStyle } from "@/domain/bubbleStyles";
import { assetRenderUrl } from "@/assets/renderSource";
import { characterIdOfInstance } from "@/characters/identity";
import type { AssetInstance, ID, PanelItem, Point, ProjectDocument, SpeechBubbleItem } from "@/domain/types";
import { resolvePartTransforms, resolveVisibleParts } from "@/puppet/transforms";

/**
 * Alpha lookup for a raster asset, in normalized image coordinates.
 *
 * Returns null when the image is not decoded yet — callers then fall back to
 * bounds, because refusing to select something the creator can see would be a
 * worse failure than a slightly generous hit region.
 */
export type AlphaSampler = (url: string, u: number, v: number) => number | null;

/** Below this the pixel reads as empty and must not capture the click. */
export const ALPHA_HIT_THRESHOLD = 24;

export type HitPrecision = "alpha" | "shape" | "bounds";

export interface HitStackEntry {
  itemId: ID;
  item: PanelItem;
  /** 0 is visually topmost. */
  depth: number;
  /** Index in `panel.itemIds`; higher is drawn later. */
  zIndex: number;
  /** Human-readable name, e.g. the character's name or the bubble's text. */
  label: string;
  /** What kind of thing it is, e.g. "Character" or "Background". */
  kind: string;
  locked: boolean;
  hidden: boolean;
  /** How precisely this item was hit-tested, for diagnostics and tests. */
  precision: HitPrecision;
}

export interface HitStackOptions {
  /**
   * Include locked items. False for canvas selection — a locked background must
   * let clicks pass through to what is above it — and true for the Layers
   * panel, which is the surface that can unlock them again.
   */
  includeLocked?: boolean;
  /** Hidden items are never hit-testable anywhere; this exists for tests only. */
  includeHidden?: boolean;
  alpha?: AlphaSampler;
}

/**
 * Every selectable item under a panel-local point, visually topmost first.
 */
export function hitStack(
  doc: ProjectDocument,
  panelId: ID,
  point: Point,
  options: HitStackOptions = {},
): HitStackEntry[] {
  const panel = doc.panels[panelId];
  if (!panel) return [];

  const entries: HitStackEntry[] = [];
  // Walk back to front so that reversing at the end yields top-first.
  panel.itemIds.forEach((itemId, zIndex) => {
    const item = doc.items[itemId];
    if (!item) return;
    const hidden = item.visible === false;
    if (hidden && !options.includeHidden) return;
    const locked = item.locked === true;
    if (locked && !options.includeLocked) return;

    const test = hitTestItem(doc, item, point, options.alpha);
    if (!test.hit) return;
    entries.push({
      itemId,
      item,
      depth: 0,
      zIndex,
      label: itemLabel(doc, item),
      kind: itemKind(doc, item),
      locked,
      hidden,
      precision: test.precision,
    });
  });

  return entries.reverse().map((entry, depth) => ({ ...entry, depth }));
}

/** Just the topmost item, which is what a plain click selects. */
export function topHit(
  doc: ProjectDocument,
  panelId: ID,
  point: Point,
  options: HitStackOptions = {},
): HitStackEntry | null {
  return hitStack(doc, panelId, point, options)[0] ?? null;
}

/**
 * Advance through a stack from the currently selected item.
 *
 * Wraps, so repeated clicking at one position walks every overlapping layer and
 * returns to the top. An item that is no longer in the stack restarts at the
 * top rather than losing the creator's place silently.
 */
export function cycleHit(stack: HitStackEntry[], selectedItemId: ID | undefined): HitStackEntry | null {
  if (stack.length === 0) return null;
  const current = stack.findIndex((entry) => entry.itemId === selectedItemId);
  if (current === -1) return stack[0];
  return stack[(current + 1) % stack.length];
}

// ─── Per-item hit tests ─────────────────────────────────────────────────────

interface HitResult {
  hit: boolean;
  precision: HitPrecision;
}

const MISS: HitResult = { hit: false, precision: "bounds" };

/**
 * Is a panel-local point inside this item?
 *
 * Exported because the Konva nodes use it as their `hitFunc` too: one predicate
 * means the pointer cannot pick one item while the resolver reports another.
 */
export function hitTestItem(
  doc: ProjectDocument,
  item: PanelItem,
  point: Point,
  alpha?: AlphaSampler,
): HitResult {
  const local = toItemLocal(item, point);
  // Bounds are the cheap rejection every other test builds on.
  if (local.x < 0 || local.y < 0 || local.x > item.width || local.y > item.height) return MISS;

  switch (item.kind) {
    case "asset":
      return hitTestAsset(doc, item, local, alpha);
    case "bubble":
      return hitTestBubble(item, local);
    case "effect":
      /**
       * Effects are procedurally drawn line work with no texture to sample, so
       * they hit-test by bounds. A full-panel screentone therefore does capture
       * clicks across the panel — which is z-order behaving correctly, and why
       * cycling, locking and the Layers panel exist.
       */
      return { hit: true, precision: "bounds" };
  }
}

function hitTestAsset(
  doc: ProjectDocument,
  item: AssetInstance,
  local: Point,
  alpha?: AlphaSampler,
): HitResult {
  /**
   * A puppet is ONE actor (V3 §12). The point is tested against its visible
   * parts, so clicking between an arm and the torso does not select the actor
   * off empty space — but the hit still resolves to the INSTANCE. Internal
   * parts never enter the stack, so the panel's layer list stays a list of
   * actors rather than a pile of eyelids.
   */
  const puppet = item.puppet ? doc.puppets[item.puppet.puppetId] : undefined;
  if (puppet && item.puppet) {
    return hitTestPuppetParts(doc, item, puppet.id, local);
  }

  const url = assetRenderUrl(doc.assets[item.sourceAssetId]);
  if (!url || !alpha) return { hit: true, precision: "bounds" };

  // Flip is a mirror about the item's centre, so undo it before sampling.
  const u = (item.flipX ? item.width - local.x : local.x) / item.width;
  const v = local.y / item.height;
  const sampled = alpha(url, u, v);
  if (sampled === null) return { hit: true, precision: "bounds" };
  return sampled >= ALPHA_HIT_THRESHOLD ? { hit: true, precision: "alpha" } : MISS;
}

function hitTestPuppetParts(
  doc: ProjectDocument,
  item: AssetInstance,
  puppetId: ID,
  local: Point,
): HitResult {
  const puppet = doc.puppets[puppetId];
  const state = item.puppet;
  if (!puppet || !state) return { hit: true, precision: "bounds" };

  const visible = new Set(resolveVisibleParts(puppet, state.expressionId, state.partOverrides));
  const transforms = resolvePartTransforms(puppet, state.pose, state.partOverrides);
  // Puppet space is normalized to the instance height, mirroring PuppetNode.
  const unit = item.height;
  const px = item.flipX ? item.width - local.x : local.x;

  for (const partId of puppet.partOrder) {
    if (!visible.has(partId)) continue;
    const transform = transforms.get(partId);
    if (!transform || !transform.visible) continue;

    const centreX = (transform.x + (0.5 - transform.pivot.x) * transform.size.x) * unit;
    const centreY = (transform.y + (0.5 - transform.pivot.y) * transform.size.y) * unit;
    const rotated = rotatePoint({ x: px - centreX, y: local.y - centreY }, -transform.rotation);
    if (
      Math.abs(rotated.x) <= (transform.size.x * unit) / 2 &&
      Math.abs(rotated.y) <= (transform.size.y * unit) / 2
    ) {
      return { hit: true, precision: "shape" };
    }
  }
  return MISS;
}

function hitTestBubble(item: SpeechBubbleItem, local: Point): HitResult {
  const style = resolvedBubbleStyle(item);
  switch (style.shape) {
    case "rect":
    case "rounded-rect":
      return { hit: true, precision: "shape" };
    case "none":
      // Bare lettering: the text box is the only thing drawn.
      return { hit: true, precision: "bounds" };
    default: {
      // Every balloon shape is a perturbed ellipse; testing the ellipse keeps a
      // speech bubble's empty corners from swallowing the art behind them.
      const nx = (local.x - item.width / 2) / (item.width / 2);
      const ny = (local.y - item.height / 2) / (item.height / 2);
      return nx * nx + ny * ny <= 1 ? { hit: true, precision: "shape" } : MISS;
    }
  }
}

/** Panel-local point → the item's own unrotated space, origin at its top-left. */
export function toItemLocal(item: PanelItem, point: Point): Point {
  const rotated = rotatePoint({ x: point.x - item.cx, y: point.y - item.cy }, -item.rotation);
  return { x: rotated.x + item.width / 2, y: rotated.y + item.height / 2 };
}

function rotatePoint(point: Point, degrees: number): Point {
  if (!degrees) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** What kind of thing this is, in the creator's vocabulary. */
export function itemKind(doc: ProjectDocument, item: PanelItem): string {
  if (item.kind === "bubble") return item.bubbleType === "sfx" ? "SFX" : "Speech Bubble";
  if (item.kind === "effect") return "Effect";
  if (item.puppet) return "Character (Puppet)";
  const asset = doc.assets[item.sourceAssetId];
  const characterId = characterIdOfInstance(doc, item);
  if (characterId && doc.characters[characterId]) return "Character";
  switch (asset?.category) {
    case "background":
      return "Background";
    case "prop":
      return "Prop";
    case "character":
      return "Character";
    default:
      return "Image";
  }
}

/**
 * The name a creator would recognise: a character's name, a bubble's own words,
 * an asset's title. Never an internal id.
 */
export function itemLabel(doc: ProjectDocument, item: PanelItem): string {
  if (item.kind === "bubble") {
    const text = item.text.trim().replace(/\s+/g, " ");
    return text.length > 0 ? `“${truncate(text, 18)}”` : "Empty bubble";
  }
  if (item.kind === "effect") return effectLabel(item.effectKind);

  const asset = doc.assets[item.sourceAssetId];
  const characterId = characterIdOfInstance(doc, item);
  const character = characterId ? doc.characters[characterId] : undefined;
  if (character) return character.name;
  return asset?.name ?? "Untitled";
}

function effectLabel(kind: string): string {
  return kind.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * The panel's layer list, topmost first — the same projection the HitStack
 * produces, without a point filter. The Layers panel renders this rather than
 * keeping a second tree that could disagree with what is drawn.
 */
export function panelLayers(doc: ProjectDocument, panelId: ID): HitStackEntry[] {
  const panel = doc.panels[panelId];
  if (!panel) return [];
  return panel.itemIds
    .map((itemId, zIndex) => {
      const item = doc.items[itemId];
      if (!item) return null;
      return {
        itemId,
        item,
        depth: 0,
        zIndex,
        label: itemLabel(doc, item),
        kind: itemKind(doc, item),
        locked: item.locked === true,
        hidden: item.visible === false,
        precision: "bounds" as HitPrecision,
      };
    })
    .filter((entry): entry is HitStackEntry => entry !== null)
    .reverse()
    .map((entry, depth) => ({ ...entry, depth }));
}
