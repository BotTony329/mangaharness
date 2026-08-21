/**
 * Panel perspective — horizon and vanishing points as document data.
 *
 * Phase 1 deliberately stops at a correct model plus editable handles. There is
 * no ruler engine, no snapping solver, and no perspective-aware regeneration
 * yet; those need the model to be right first.
 *
 * Coordinates are normalized to the panel's bounding box (0–1 on both axes) so
 * guides survive panel reshaping and page resizing, exactly like `Panel.points`.
 * Vanishing points routinely sit outside the panel, so they are NOT clamped —
 * a two-point setup with both VPs inside the frame is a fisheye, not a room.
 */

import type { PanelPerspective, PerspectiveType, Point } from "./types";

export const PERSPECTIVE_TYPES: PerspectiveType[] = ["none", "one-point", "two-point", "three-point"];

export function vanishingPointCount(type: PerspectiveType): number {
  switch (type) {
    case "none":
      return 0;
    case "one-point":
      return 1;
    case "two-point":
      return 2;
    case "three-point":
      return 3;
  }
}

/**
 * Default vanishing points for a type, placed at the horizon.
 *
 * Two-point defaults sit well outside the frame because convergence inside the
 * panel reads as distortion; the third point of a three-point setup goes far
 * below for the classic low-angle "hero" look.
 */
export function defaultVanishingPoints(type: PerspectiveType, horizonY: number): Point[] {
  switch (type) {
    case "none":
      return [];
    case "one-point":
      return [{ x: 0.5, y: horizonY }];
    case "two-point":
      return [
        { x: -0.35, y: horizonY },
        { x: 1.35, y: horizonY },
      ];
    case "three-point":
      return [
        { x: -0.35, y: horizonY },
        { x: 1.35, y: horizonY },
        { x: 0.5, y: horizonY + 1.6 },
      ];
  }
}

export function createPanelPerspective(
  type: PerspectiveType = "none",
  horizonY = 0.5,
): PanelPerspective {
  return {
    type,
    horizonY: clamp01(horizonY),
    vanishingPoints: defaultVanishingPoints(type, clamp01(horizonY)),
    visible: type !== "none",
    snapEnabled: false,
  };
}

export type PerspectivePatch = Partial<
  Pick<PanelPerspective, "type" | "horizonY" | "visible" | "snapEnabled">
> & { vanishingPoints?: Point[] };

export function applyPerspectivePatch(
  perspective: PanelPerspective,
  patch: PerspectivePatch,
): PanelPerspective {
  const next: PanelPerspective = { ...perspective, vanishingPoints: [...perspective.vanishingPoints] };

  if (patch.type !== undefined && patch.type !== next.type) {
    next.type = patch.type;
    // Changing type changes how many points exist. Existing points are kept
    // where they still apply so switching one-point → two-point does not throw
    // away a horizon the user already positioned.
    const wanted = vanishingPointCount(patch.type);
    const defaults = defaultVanishingPoints(patch.type, next.horizonY);
    next.vanishingPoints = Array.from({ length: wanted }, (_, index) => next.vanishingPoints[index] ?? defaults[index]);
    next.visible = patch.type !== "none";
  }

  if (patch.horizonY !== undefined) {
    const horizonY = clamp01(patch.horizonY);
    const delta = horizonY - next.horizonY;
    next.horizonY = horizonY;
    // Horizontal vanishing points ride the horizon; a third (vertical) point
    // does not, so only points that were on the old horizon move with it.
    next.vanishingPoints = next.vanishingPoints.map((point, index) =>
      index < 2 ? { x: point.x, y: point.y + delta } : point,
    );
  }

  if (patch.vanishingPoints !== undefined) {
    next.vanishingPoints = patch.vanishingPoints.map((point) => ({ x: point.x, y: point.y }));
  }
  if (patch.visible !== undefined) next.visible = patch.visible;
  if (patch.snapEnabled !== undefined) next.snapEnabled = patch.snapEnabled;
  return next;
}

export function moveVanishingPoint(
  perspective: PanelPerspective,
  index: number,
  point: Point,
): PanelPerspective {
  if (index < 0 || index >= perspective.vanishingPoints.length) {
    throw new Error(`No vanishing point at index ${index}`);
  }
  const vanishingPoints = perspective.vanishingPoints.map((existing, i) =>
    i === index ? { x: point.x, y: point.y } : existing,
  );
  return { ...perspective, vanishingPoints };
}

/**
 * Guide lines radiating from each vanishing point, in normalized panel space.
 *
 * Returned for the editor overlay only. Nothing here may reach the exported
 * page — the render layer draws these on the overlay layer, which export hides
 * (§10).
 */
export function perspectiveGuideLines(perspective: PanelPerspective, raysPerPoint = 12): { from: Point; to: Point }[] {
  if (perspective.type === "none" || !perspective.visible) return [];
  const lines: { from: Point; to: Point }[] = [];
  for (const vp of perspective.vanishingPoints) {
    for (let ray = 0; ray < raysPerPoint; ray += 1) {
      const angle = (ray / raysPerPoint) * Math.PI * 2;
      // Long enough to cross the panel from any vanishing point outside it.
      lines.push({ from: vp, to: { x: vp.x + Math.cos(angle) * 4, y: vp.y + Math.sin(angle) * 4 } });
    }
  }
  return lines;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
