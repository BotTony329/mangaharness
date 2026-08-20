/**
 * Pure framing/transform math. No Konva, no React — these functions are the
 * single implementation used by the editor UI, the agent tools, and export,
 * and they are guarded by unit tests (wrong math here renders silently wrong).
 */

import type { CropMode, FocusRegion, Point, Rect, SourceAsset } from "./types";

export interface ItemTransform {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Heuristic upper-body region for character art without annotations: the
 * upper ~55% of the image, trimmed at the sides. This is approximate framing
 * (explicitly allowed by the product spec), not face detection.
 */
export const DEFAULT_UPPER_BODY_REGION: Rect = { x: 0.1, y: 0.02, width: 0.8, height: 0.55 };

/** Scale so the whole asset is contained in the panel (letterboxing allowed). */
export function fitTransform(assetW: number, assetH: number, panelW: number, panelH: number): ItemTransform {
  const scale = Math.min(panelW / assetW, panelH / assetH);
  return centered(assetW * scale, assetH * scale, panelW, panelH);
}

/** Scale so the asset covers the panel completely (overflow clipped by the panel). */
export function fillTransform(assetW: number, assetH: number, panelW: number, panelH: number): ItemTransform {
  const scale = Math.max(panelW / assetW, panelH / assetH);
  return centered(assetW * scale, assetH * scale, panelW, panelH);
}

/**
 * Frame a normalized sub-region of the asset so that region covers the panel.
 * The instance stays whole (larger than the panel); the panel viewport does
 * the cropping — the source asset is never modified.
 */
export function frameRegionTransform(
  assetW: number,
  assetH: number,
  panelW: number,
  panelH: number,
  region: Rect,
): ItemTransform {
  const regionW = Math.max(region.width * assetW, 1);
  const regionH = Math.max(region.height * assetH, 1);
  const scale = Math.max(panelW / regionW, panelH / regionH);
  const width = assetW * scale;
  const height = assetH * scale;
  // Place the region's center at the panel's center.
  const regionCx = region.x + region.width / 2;
  const regionCy = region.y + region.height / 2;
  return {
    cx: panelW / 2 - (regionCx - 0.5) * width,
    cy: panelH / 2 - (regionCy - 0.5) * height,
    width,
    height,
  };
}

export function findRegion(asset: Pick<SourceAsset, "focusRegions">, kind: FocusRegion["kind"]): Rect | undefined {
  return asset.focusRegions?.find((r) => r.kind === kind)?.rect;
}

/** Face framing is only available with real region metadata — never faked. */
export function supportsFaceFocus(asset: Pick<SourceAsset, "focusRegions">): boolean {
  return findRegion(asset, "face") !== undefined;
}

/**
 * Compute the transform for a crop mode. Returns null for "custom" (custom
 * means: keep whatever transform the user made) and for "face" without
 * region metadata.
 */
export function cropModeTransform(
  mode: CropMode,
  asset: Pick<SourceAsset, "width" | "height" | "focusRegions">,
  panelW: number,
  panelH: number,
): ItemTransform | null {
  switch (mode) {
    case "fit":
      return fitTransform(asset.width, asset.height, panelW, panelH);
    case "fill":
      return fillTransform(asset.width, asset.height, panelW, panelH);
    case "upper-body":
      return frameRegionTransform(
        asset.width,
        asset.height,
        panelW,
        panelH,
        findRegion(asset, "upper-body") ?? DEFAULT_UPPER_BODY_REGION,
      );
    case "face": {
      const face = findRegion(asset, "face");
      return face ? frameRegionTransform(asset.width, asset.height, panelW, panelH, face) : null;
    }
    case "custom":
      return null;
  }
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

// ─── Panel polygons ─────────────────────────────────────────────────────────
// Panels are polygons in normalized 0–1 page coordinates. Framing math
// (fit/fill/upper-body) works against the polygon's bounding box; clipping,
// borders, and hit testing use the polygon itself.

/** A rect expressed as the equivalent 4-point polygon (clockwise). */
export function rectToPoints(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/** Normalized polygon → page-pixel polygon. */
export function polygonToPx(points: Point[], pageW: number, pageH: number): Point[] {
  return points.map((p) => ({ x: p.x * pageW, y: p.y * pageH }));
}

/** Axis-aligned bounding box of a pixel-space polygon. */
export function polygonBounds(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Ray-casting point-in-polygon test (same coordinate space as the polygon). */
export function pointInPolygon(x: number, y: number, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const crosses = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function centered(width: number, height: number, panelW: number, panelH: number): ItemTransform {
  return { cx: panelW / 2, cy: panelH / 2, width, height };
}
