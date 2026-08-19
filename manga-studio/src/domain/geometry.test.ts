import { describe, expect, it } from "vitest";
import {
  cropModeTransform,
  DEFAULT_UPPER_BODY_REGION,
  fillTransform,
  fitTransform,
  frameRegionTransform,
  panelRectToPx,
  supportsFaceFocus,
} from "./geometry";

// A tall portrait character in a landscape panel — the common hard case.
const ASSET = { width: 1000, height: 2000 };
const PANEL = { width: 400, height: 300 };

describe("fitTransform", () => {
  it("contains the whole asset inside the panel", () => {
    const t = fitTransform(ASSET.width, ASSET.height, PANEL.width, PANEL.height);
    expect(t.height).toBeCloseTo(300);
    expect(t.width).toBeCloseTo(150);
    expect(t.cx).toBeCloseTo(200);
    expect(t.cy).toBeCloseTo(150);
  });

  it("preserves aspect ratio", () => {
    const t = fitTransform(ASSET.width, ASSET.height, PANEL.width, PANEL.height);
    expect(t.width / t.height).toBeCloseTo(ASSET.width / ASSET.height);
  });
});

describe("fillTransform", () => {
  it("covers the panel completely (overflow clipped by viewport)", () => {
    const t = fillTransform(ASSET.width, ASSET.height, PANEL.width, PANEL.height);
    expect(t.width).toBeGreaterThanOrEqual(PANEL.width);
    expect(t.height).toBeGreaterThanOrEqual(PANEL.height);
    expect(t.width).toBeCloseTo(400);
    expect(t.height).toBeCloseTo(800);
  });

  it("2000x3000 asset in 400x600 panel yields center crop (PRD acceptance)", () => {
    const t = fillTransform(2000, 3000, 400, 600);
    expect(t.width).toBeCloseTo(400);
    expect(t.height).toBeCloseTo(600);
    expect(t.cx).toBeCloseTo(200);
    expect(t.cy).toBeCloseTo(300);
  });
});

describe("frameRegionTransform", () => {
  it("centers the region on the panel and covers it", () => {
    // Face occupies the top-middle 20% of the asset.
    const region = { x: 0.4, y: 0.05, width: 0.2, height: 0.15 };
    const t = frameRegionTransform(ASSET.width, ASSET.height, PANEL.width, PANEL.height, region);
    // Rendered region size must cover the panel.
    expect(region.width * t.width).toBeGreaterThanOrEqual(PANEL.width - 0.01);
    expect(region.height * t.height).toBeGreaterThanOrEqual(PANEL.height - 0.01);
    // Region center lands on panel center.
    const regionCenterX = t.cx + (region.x + region.width / 2 - 0.5) * t.width;
    const regionCenterY = t.cy + (region.y + region.height / 2 - 0.5) * t.height;
    expect(regionCenterX).toBeCloseTo(PANEL.width / 2);
    expect(regionCenterY).toBeCloseTo(PANEL.height / 2);
  });
});

describe("cropModeTransform", () => {
  it("upper-body falls back to the heuristic region without metadata", () => {
    const t = cropModeTransform("upper-body", { ...ASSET, focusRegions: undefined }, PANEL.width, PANEL.height);
    expect(t).not.toBeNull();
    // The upper-body frame must zoom in more than plain fill.
    const fill = fillTransform(ASSET.width, ASSET.height, PANEL.width, PANEL.height);
    expect(t!.width).toBeGreaterThan(fill.width);
    expect(DEFAULT_UPPER_BODY_REGION.y).toBeLessThan(0.5);
  });

  it("face mode is unavailable (null) without region metadata — never faked", () => {
    expect(cropModeTransform("face", { ...ASSET }, PANEL.width, PANEL.height)).toBeNull();
    expect(supportsFaceFocus({ focusRegions: undefined })).toBe(false);
  });

  it("face mode frames the annotated region when present", () => {
    const asset = {
      ...ASSET,
      focusRegions: [{ kind: "face" as const, rect: { x: 0.35, y: 0.02, width: 0.3, height: 0.15 } }],
    };
    expect(supportsFaceFocus(asset)).toBe(true);
    const t = cropModeTransform("face", asset, PANEL.width, PANEL.height);
    expect(t).not.toBeNull();
    expect(t!.width).toBeGreaterThan(PANEL.width);
  });

  it("custom returns null (keep the user's transform)", () => {
    expect(cropModeTransform("custom", { ...ASSET }, PANEL.width, PANEL.height)).toBeNull();
  });
});

describe("panelRectToPx", () => {
  it("converts normalized page rects to pixels", () => {
    const px = panelRectToPx({ x: 0.5, y: 0.25, width: 0.5, height: 0.5 }, 1200, 1800);
    expect(px).toEqual({ x: 600, y: 450, width: 600, height: 900 });
  });
});
