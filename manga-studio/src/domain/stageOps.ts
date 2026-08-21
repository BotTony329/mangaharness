/**
 * Mutations for the virtual manga stage: panel camera, panel perspective,
 * instance depth, semantic character state, effect params, and bubble targets.
 *
 * Pure `doc → doc` like every other Ops module, so all of it flows through the
 * one command layer and inherits undo/redo without a second history system.
 */

import { applyCameraPatch, createPanelCamera, type CameraPatch } from "./camera";
import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import { normalizeEffectParams, updateEffectParams } from "./effects";
import { applyPerspectivePatch, createPanelPerspective, moveVanishingPoint, type PerspectivePatch } from "./perspective";
import { applyStageToInstance, createStage, DEFAULT_STAGE, inferBaseHeight } from "./stage";
import type {
  AssetInstance,
  CharacterState,
  EffectItem,
  ID,
  InstanceStage,
  Point,
  ProjectDocument,
  SpeechBubbleItem,
} from "./types";

// ─── Camera ─────────────────────────────────────────────────────────────────

export function setPanelCamera(doc: ProjectDocument, panelId: ID, patch: CameraPatch): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  panel.camera = applyCameraPatch(panel.camera ?? createPanelCamera(), patch);
  touch(next);
  return next;
}

// ─── Perspective ────────────────────────────────────────────────────────────

export function setPanelPerspective(doc: ProjectDocument, panelId: ID, patch: PerspectivePatch): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  panel.perspective = applyPerspectivePatch(panel.perspective ?? createPanelPerspective(), patch);
  touch(next);
  return next;
}

export function movePanelVanishingPoint(
  doc: ProjectDocument,
  panelId: ID,
  index: number,
  point: Point,
): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  panel.perspective = moveVanishingPoint(panel.perspective ?? createPanelPerspective(), index, point);
  touch(next);
  return next;
}

// ─── Instance depth ─────────────────────────────────────────────────────────

function requireAssetInstance(doc: ProjectDocument, instanceId: ID): AssetInstance {
  const item = doc.items[instanceId];
  if (!item) throw new Error(`Unknown item: ${instanceId}`);
  if (item.kind !== "asset") throw new Error("Only asset instances have stage depth");
  return item;
}

/**
 * Set or update an instance's stage state.
 *
 * The instance's current size is treated as its size at the previous depth
 * (mid-stage the first time depth is enabled), so turning depth on at the
 * default value leaves the character exactly where it was, while any actual
 * depth change scales relative to that.
 */
export function setInstanceStage(
  doc: ProjectDocument,
  instanceId: ID,
  patch: Partial<InstanceStage>,
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requireAssetInstance(next, instanceId);
  const existing = instance.stage;
  const stage = existing ? createStage({ ...existing, ...patch }) : createStage(patch);
  // Base height is read at the instance's PREVIOUS depth, so a depth change
  // scales relative to where the character already was. Inferring it at the new
  // depth instead would make every depth change a no-op: the inferred base
  // would exactly cancel the new scale.
  const baseHeight = inferBaseHeight(instance, existing?.depth ?? DEFAULT_STAGE.depth);

  instance.stage = stage;
  if (!stage.scaleLocked) {
    const panel = panelPxRect(next, instance.panelId);
    const transform = applyStageToInstance(instance, stage, panel, baseHeight);
    instance.cx = transform.cx;
    instance.cy = transform.cy;
    instance.width = transform.width;
    instance.height = transform.height;
    // Depth now owns the size, so the framing mode no longer describes it.
    instance.cropMode = "custom";
  }
  touch(next);
  return next;
}

/** Turn depth off, leaving the instance exactly where it currently sits. */
export function clearInstanceStage(doc: ProjectDocument, instanceId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requireAssetInstance(next, instanceId);
  delete instance.stage;
  touch(next);
  return next;
}

// ─── Semantic character state ───────────────────────────────────────────────

/**
 * Record a semantic state change on an instance without touching its artwork.
 *
 * The asset swap is a separate step performed by the resolver once a render
 * exists. Keeping them separate is what allows a state to be requested before
 * its image has been generated.
 */
export function setInstanceCharacterState(
  doc: ProjectDocument,
  instanceId: ID,
  state: CharacterState,
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requireAssetInstance(next, instanceId);
  instance.characterState = { ...state };
  touch(next);
  return next;
}

// ─── Effects ────────────────────────────────────────────────────────────────

function requireEffect(doc: ProjectDocument, itemId: ID): EffectItem {
  const item = doc.items[itemId];
  if (!item) throw new Error(`Unknown item: ${itemId}`);
  if (item.kind !== "effect") throw new Error("Not an effect");
  return item;
}

export function setEffectParams(
  doc: ProjectDocument,
  itemId: ID,
  patch: Record<string, unknown>,
): ProjectDocument {
  const next = cloneDoc(doc);
  const effect = requireEffect(next, itemId);
  // Re-normalize first: a document written before effects were typed can still
  // be holding a loose param bag here.
  const current = normalizeEffectParams(effect.effectKind, effect.params as unknown as Record<string, unknown>);
  effect.params = updateEffectParams(current, patch);
  touch(next);
  return next;
}

/** Attach an effect to the subject it describes, or detach with `undefined`. */
export function setEffectTarget(doc: ProjectDocument, itemId: ID, targetItemId: ID | undefined): ProjectDocument {
  const next = cloneDoc(doc);
  const effect = requireEffect(next, itemId);
  if (targetItemId && !next.items[targetItemId]) throw new Error(`Unknown target item: ${targetItemId}`);
  if (targetItemId === itemId) throw new Error("An effect cannot target itself");
  effect.targetItemId = targetItemId;
  touch(next);
  return next;
}

// ─── Bubbles ────────────────────────────────────────────────────────────────

function requireBubble(doc: ProjectDocument, itemId: ID): SpeechBubbleItem {
  const item = doc.items[itemId];
  if (!item) throw new Error(`Unknown item: ${itemId}`);
  if (item.kind !== "bubble") throw new Error("Not a bubble");
  return item;
}

/**
 * Point a bubble at a speaker.
 *
 * Storing the relationship rather than a baked tail coordinate is what lets the
 * tail keep pointing at the character after the character moves (§17).
 */
export function setBubbleTarget(
  doc: ProjectDocument,
  itemId: ID,
  target: { characterId?: ID; instanceId?: ID },
): ProjectDocument {
  const next = cloneDoc(doc);
  const bubble = requireBubble(next, itemId);
  if (target.instanceId) {
    const instance = next.items[target.instanceId];
    if (!instance || instance.kind !== "asset") throw new Error("Bubble target must be a placed asset");
    if (instance.panelId !== bubble.panelId) throw new Error("Bubble and speaker must share a panel");
  }
  bubble.targetCharacterId = target.characterId;
  bubble.targetInstanceId = target.instanceId;
  if (target.instanceId) retargetBubbleTail(next, bubble);
  touch(next);
  return next;
}

/**
 * Recompute every targeted bubble tail in a panel.
 *
 * Called after a speaker moves. Untargeted bubbles are left alone — a manually
 * placed tail is the creator's decision and must not be overwritten.
 */
export function refreshBubbleTails(doc: ProjectDocument, panelId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) return next;
  let changed = false;
  for (const itemId of panel.itemIds) {
    const item = next.items[itemId];
    if (item?.kind !== "bubble" || !item.targetInstanceId) continue;
    if (retargetBubbleTail(next, item)) changed = true;
  }
  if (changed) touch(next);
  return next;
}

/** Aim the tail at the speaker's head, returning true when it moved. */
function retargetBubbleTail(doc: ProjectDocument, bubble: SpeechBubbleItem): boolean {
  if (bubble.bubbleType === "narration") return false;
  const target = bubble.targetInstanceId ? doc.items[bubble.targetInstanceId] : undefined;
  if (!target || target.kind !== "asset") return false;
  // Aim at the upper region of the subject, which is where a head sits in a
  // full-body render and still lands on the face in a close-up.
  const head = { x: target.cx, y: target.cy - target.height * 0.32 };
  if (bubble.tail && bubble.tail.x === head.x && bubble.tail.y === head.y) return false;
  bubble.tail = head;
  return true;
}
