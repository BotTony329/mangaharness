/**
 * Depth stage — an OPTIONAL semantic layer over the existing transform system.
 *
 * An instance without `stage` behaves exactly as before: free transform, no
 * derived scale, nothing recomputed. Opting in lets the creator drag a
 * character deeper into the scene and have it shrink, and gives characters a
 * shared ground plane so they stop floating at unrelated sizes (§11/§12).
 *
 * Manual scale always wins. `scaleLocked` records that the user resized the
 * instance by hand after enabling depth, and depth then stops driving size —
 * anything else would fight the user's own edit.
 */

import type { AssetInstance, GroundAnchor, InstanceStage, Rect } from "./types";

/** depth 0 = at the camera, depth 1 = at the far plane. */
export const NEAR_DEPTH = 0;
export const FAR_DEPTH = 1;

/**
 * How much smaller the far plane is than the near plane.
 *
 * 0.32 keeps a full-body character readable at maximum depth; a true optical
 * falloff would make background figures too small to letter around, which is
 * why manga stages compress depth rather than reproduce it.
 */
export const FAR_PLANE_SCALE = 0.32;

export const DEFAULT_STAGE: InstanceStage = {
  depth: 0.5,
  groundY: 0.92,
  anchor: "feet",
  scaleLocked: false,
};

export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_STAGE.depth;
  return Math.max(NEAR_DEPTH, Math.min(FAR_DEPTH, depth));
}

export function createStage(patch: Partial<InstanceStage> = {}): InstanceStage {
  return {
    depth: clampDepth(patch.depth ?? DEFAULT_STAGE.depth),
    groundY: clamp01(patch.groundY ?? DEFAULT_STAGE.groundY),
    anchor: patch.anchor ?? DEFAULT_STAGE.anchor,
    scaleLocked: patch.scaleLocked ?? false,
  };
}

/** Linear depth → scale factor. Monotonic and stable, so dragging feels predictable. */
export function depthScale(depth: number): number {
  const t = clampDepth(depth);
  return 1 - t * (1 - FAR_PLANE_SCALE);
}

/**
 * Screen height for a subject at a given depth.
 *
 * `baseHeight` is the height the instance would have at the near plane, so
 * two characters sharing a base height and a depth end up the same size — the
 * property that makes a stage read as one space.
 */
export function stageHeight(baseHeight: number, depth: number): number {
  return baseHeight * depthScale(depth);
}

/** Where the instance's ground anchor sits, in panel-local pixels. */
export function groundAnchorPoint(instance: AssetInstance, anchor: GroundAnchor = "feet"): { x: number; y: number } {
  const halfHeight = instance.height / 2;
  switch (anchor) {
    case "feet":
      return { x: instance.cx, y: instance.cy + halfHeight };
    case "center":
      return { x: instance.cx, y: instance.cy };
    case "custom":
      return { x: instance.cx, y: instance.cy + halfHeight };
  }
}

/**
 * Reposition and resize an instance for a stage state.
 *
 * The ground anchor is held fixed while height changes, so a character pushed
 * deeper keeps its feet on the ground line instead of sliding up the frame.
 */
export function applyStageToInstance(
  instance: AssetInstance,
  stage: InstanceStage,
  panel: Rect,
  baseHeight: number,
): { cx: number; cy: number; width: number; height: number } {
  const aspect = instance.height === 0 ? 1 : instance.width / instance.height;
  const height = stage.scaleLocked ? instance.height : stageHeight(baseHeight, stage.depth);
  const width = stage.scaleLocked ? instance.width : height * aspect;
  const groundLine = stage.groundY * panel.height;
  const cy = stage.anchor === "center" ? groundLine : groundLine - height / 2;
  return { cx: instance.cx, cy, width, height };
}

/**
 * The height an instance would have at the near plane, inferred from its
 * current size. Used when enabling depth on an already-placed instance so it
 * does not jump.
 */
export function inferBaseHeight(instance: AssetInstance, depth: number): number {
  const scale = depthScale(depth);
  return scale === 0 ? instance.height : instance.height / scale;
}

/** Ordering hint: nearer characters draw on top. */
export function depthSortKey(stage: InstanceStage | undefined): number {
  return stage ? -stage.depth : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
