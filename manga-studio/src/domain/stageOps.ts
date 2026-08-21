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
import { createStage, DEFAULT_STAGE, depthSortKey } from "./stage";
import { depthFromGroundPoint, frameSubject, inferBaseHeight, isAirborne, projectInstance } from "./staging";
import type {
  AssetInstance,
  CharacterState,
  PanelCamera,
  EffectItem,
  ID,
  InstanceStage,
  Point,
  ProjectDocument,
  SpeechBubbleItem,
} from "./types";

// ─── Camera ─────────────────────────────────────────────────────────────────

/**
 * Change the panel camera AND restage the panel to match (§5/§24).
 *
 * A camera control that only writes metadata is worse than no control: this is
 * the step that makes Shot, Angle and Lens visibly change the composition.
 * Shot reframes the focal subject; angle and lens re-project every depth-staged
 * character, because they change where the ground sits and how fast size falls
 * off with distance.
 */
export function setPanelCamera(doc: ProjectDocument, panelId: ID, patch: CameraPatch): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  const before = panel.camera ?? createPanelCamera();
  panel.camera = applyCameraPatch(before, patch);

  // Angle shifts where the subject sits in frame, so it reframes as well as
  // re-projects. Base heights are captured under the OLD camera first: inferring
  // them under the new one would cancel the very change being applied.
  const baseHeights = captureBaseHeights(next, panelId, before);
  if (
    (patch.shot !== undefined && patch.shot !== before.shot) ||
    (patch.angle !== undefined && patch.angle !== before.angle)
  ) {
    applyShotFraming(next, panelId);
  }
  restagePanel(next, panelId, baseHeights);
  touch(next);
  return next;
}

/** Reframe the focal subject for the panel's current shot type. */
function applyShotFraming(doc: ProjectDocument, panelId: ID): void {
  const panel = doc.panels[panelId];
  const camera = panel.camera;
  if (!camera) return;
  const focal = focalInstance(doc, panelId);
  if (!focal) return;
  const rect = panelPxRect(doc, panelId);
  const framed = frameSubject({ instance: focal, panel: rect, shot: camera.shot, angle: camera.angle, yaw: camera.yaw });
  focal.cx = framed.cx;
  focal.cy = framed.cy;
  focal.width = framed.width;
  focal.height = framed.height;
  // Framing is now the camera's, not a crop preset's.
  focal.cropMode = "custom";
  // Depth would immediately undo the framing, so a framed subject holds its size.
  if (focal.stage) focal.stage = { ...focal.stage, scaleLocked: true };
}

/**
 * The subject camera operations act on.
 *
 * Explicit focal item first; otherwise the topmost character in the panel, so
 * a single-character panel needs no setup at all.
 */
/** The horizon a panel's floor recedes toward, or undefined when flat. */
function activeHorizon(doc: ProjectDocument, panelId: ID): number | undefined {
  const perspective = doc.panels[panelId]?.perspective;
  return perspective && perspective.type !== "none" ? perspective.horizonY : undefined;
}

export function focalInstance(doc: ProjectDocument, panelId: ID): AssetInstance | undefined {
  const panel = doc.panels[panelId];
  if (!panel) return undefined;
  if (panel.focalItemId) {
    const explicit = doc.items[panel.focalItemId];
    if (explicit?.kind === "asset") return explicit;
  }
  const characters = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .filter((item) => Boolean(item.characterState ?? doc.assets[item.sourceAssetId]?.metadata?.characterId));
  return characters[characters.length - 1];
}

export function setPanelFocalItem(doc: ProjectDocument, panelId: ID, itemId: ID | undefined): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  if (itemId && next.items[itemId]?.panelId !== panelId) {
    throw new Error("The focal subject must be in this panel");
  }
  panel.focalItemId = itemId;
  touch(next);
  return next;
}

export function setPanelAutoDepthOrder(doc: ProjectDocument, panelId: ID, enabled: boolean): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  panel.autoDepthOrder = enabled;
  if (enabled) sortPanelByDepth(next, panelId);
  touch(next);
  return next;
}

/**
 * Near-plane heights for every staged instance, measured under a given camera.
 *
 * Taken before a camera change so the re-projection has a stable reference.
 * Without it, inferring the base height under the new camera reproduces the
 * current size exactly and the lens or perspective change does nothing.
 */
export function captureBaseHeights(
  doc: ProjectDocument,
  panelId: ID,
  camera: PanelCamera | undefined,
): Map<ID, number> {
  const heights = new Map<ID, number>();
  const panel = doc.panels[panelId];
  if (!panel) return heights;
  for (const itemId of panel.itemIds) {
    const item = doc.items[itemId];
    if (item?.kind !== "asset" || !item.stage) continue;
    heights.set(itemId, inferBaseHeight(item, item.stage.depth, camera));
  }
  return heights;
}

/**
 * Re-project every depth-staged instance in a panel.
 *
 * Called whenever something panel-wide changes — the camera, the ground line —
 * so a shared stage stays coherent instead of each character drifting to
 * whatever geometry it last happened to have.
 */
export function restagePanel(doc: ProjectDocument, panelId: ID, baseHeights?: Map<ID, number>): void {
  const panel = doc.panels[panelId];
  if (!panel) return;
  const rect = panelPxRect(doc, panelId);
  const camera = panel.camera;
  for (const itemId of panel.itemIds) {
    const item = doc.items[itemId];
    if (item?.kind !== "asset" || !item.stage) continue;
    if (item.stage.scaleLocked) continue;
    const state = item.characterState;
    const projection = projectInstance({
      instance: item,
      stage: item.stage,
      panel: rect,
      camera,
      baseHeight: baseHeights?.get(itemId) ?? inferBaseHeight(item, item.stage.depth, camera),
      airborne: isAirborne(state?.pose, state?.poseRig?.descriptors),
      horizonY: activeHorizon(doc, panelId),
    });
    item.cx = projection.cx;
    item.cy = projection.cy;
    item.width = projection.width;
    item.height = projection.height;
  }
  if (panel.autoDepthOrder) sortPanelByDepth(doc, panelId);
}

/**
 * Order a panel's items by depth (§10).
 *
 * Only depth-staged assets are reordered, and they keep their band relative to
 * bubbles and effects — auto ordering is about the stage, not about promoting
 * characters over dialogue.
 */
export function sortPanelByDepth(doc: ProjectDocument, panelId: ID): void {
  const panel = doc.panels[panelId];
  if (!panel) return;
  const staged: ID[] = [];
  const positions: number[] = [];
  panel.itemIds.forEach((id, index) => {
    const item = doc.items[id];
    if (item?.kind === "asset" && item.stage) {
      staged.push(id);
      positions.push(index);
    }
  });
  if (staged.length < 2) return;
  // Far first so near draws on top.
  staged.sort((a, b) => {
    const left = doc.items[a] as AssetInstance;
    const right = doc.items[b] as AssetInstance;
    // depthSortKey is -depth, so ascending puts the farthest first and the
    // nearest last — and last in itemIds is drawn on top.
    return depthSortKey(left.stage) - depthSortKey(right.stage);
  });
  positions.forEach((position, index) => {
    panel.itemIds[position] = staged[index];
  });
}

// ─── Perspective ────────────────────────────────────────────────────────────

export function setPanelPerspective(doc: ProjectDocument, panelId: ID, patch: PerspectivePatch): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  const baseHeights = captureBaseHeights(next, panelId, panel.camera);
  panel.perspective = applyPerspectivePatch(panel.perspective ?? createPanelPerspective(), patch);
  // The horizon IS the floor: turning perspective on, off, or moving the eye
  // level changes where every staged character stands.
  restagePanel(next, panelId, baseHeights);
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
  const panel = next.panels[instance.panelId];
  const camera = panel?.camera;
  const baseHeight = inferBaseHeight(instance, existing?.depth ?? DEFAULT_STAGE.depth, camera);

  instance.stage = stage;
  if (!stage.scaleLocked) {
    const rect = panelPxRect(next, instance.panelId);
    const state = instance.characterState;
    const projection = projectInstance({
      instance,
      stage,
      panel: rect,
      camera,
      baseHeight,
      airborne: isAirborne(state?.pose, state?.poseRig?.descriptors),
      horizonY: activeHorizon(next, instance.panelId),
    });
    instance.cx = projection.cx;
    instance.cy = projection.cy;
    instance.width = projection.width;
    instance.height = projection.height;
    // Depth now owns the size, so the framing mode no longer describes it.
    instance.cropMode = "custom";
  }
  // Depth changed, so auto ordering may need to change with it.
  if (panel?.autoDepthOrder) sortPanelByDepth(next, instance.panelId);
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

/**
 * Place a staged character by where it was dropped on the panel floor (§4/§5).
 *
 * Horizontal movement is kept as-is; vertical movement becomes depth, so
 * dragging a character up the panel walks it into the distance and it shrinks
 * and re-grounds as it goes. Only runs when the panel's stage snapping is on
 * and the panel actually has a floor to infer against — otherwise the drag
 * stays an ordinary free move rather than guessing.
 */
export function placeOnStage(
  doc: ProjectDocument,
  instanceId: ID,
  point: { x: number; y: number },
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requireAssetInstance(next, instanceId);
  if (!instance.stage) return doc;
  const panel = next.panels[instance.panelId];
  if (!panel?.perspective?.snapEnabled) return doc;

  const rect = panelPxRect(next, instance.panelId);
  const camera = panel.camera;
  const feetY = point.y + instance.height / 2;
  const depth = depthFromGroundPoint({
    feetY,
    panel: rect,
    camera,
    horizonY: panel.perspective.horizonY,
  });
  if (depth === null) return doc;

  const baseHeight = inferBaseHeight(instance, instance.stage.depth, camera);
  const stage = createStage({ ...instance.stage, depth, scaleLocked: false });
  instance.stage = stage;
  instance.cx = point.x;

  const state = instance.characterState;
  const projection = projectInstance({
    instance,
    stage,
    panel: rect,
    camera,
    baseHeight,
    airborne: isAirborne(state?.pose, state?.poseRig?.descriptors),
    horizonY: panel.perspective.horizonY,
  });
  instance.cy = projection.cy;
  instance.width = projection.width;
  instance.height = projection.height;
  instance.cropMode = "custom";
  if (panel.autoDepthOrder) sortPanelByDepth(next, instance.panelId);
  touch(next);
  return next;
}

/** True when a canvas drag on this instance should become a stage placement. */
export function usesStagePlacement(doc: ProjectDocument, instanceId: ID): boolean {
  const item = doc.items[instanceId];
  if (item?.kind !== "asset" || !item.stage) return false;
  return Boolean(doc.panels[item.panelId]?.perspective?.snapEnabled);
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
