/**
 * The character-asset transparency contract.
 *
 * Every assertion here reads real alpha bytes. A "success" flag from the
 * pipeline proves nothing on its own — the regression these tests exist to
 * prevent shipped precisely because a status said ready while the stored
 * bitmap still carried an opaque background.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "./postProcessor";
import { estimateEdgeBackground, colorDistance, type Rgb } from "./backgroundRemoval";

const W = 120;
const H = 160;

// Palette of the real failure: a light transparency grid is the single case
// the previous seeding rule could never solve.
const GRID_LIGHT: [Rgb, Rgb] = [[255, 255, 255], [204, 204, 204]];
const GRID_DARK: [Rgb, Rgb] = [[63, 63, 70], [39, 39, 42]];
const CHROMA_KEY: Rgb = [255, 0, 255];

const INK: Rgb = [12, 12, 14];
const PAPER: Rgb = [255, 255, 255];
const SKIN: Rgb = [252, 251, 250];

interface Canvas {
  buf: Buffer;
  set(x: number, y: number, c: Rgb, a?: number): void;
}

function canvas(): Canvas {
  const buf = Buffer.alloc(W * H * 4);
  return {
    buf,
    set(x, y, c, a = 255) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = a;
    },
  };
}

function fillSolid(c: Canvas, color: Rgb) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c.set(x, y, color);
}

function fillChecker(c: Canvas, [a, b]: [Rgb, Rgb], tile = 8) {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      c.set(x, y, (Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0 ? a : b);
}

function fillTransparent(c: Canvas) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c.set(x, y, [0, 0, 0], 0);
}

/**
 * A closed manga figure: unbroken ink outline enclosing paper-white skin and
 * white clothing, with black eyes inside the face. Every white region inside
 * the outline is unreachable from the border, which is the property the
 * extractor must rely on.
 */
function drawFigure(c: Canvas, opts: { whiteClothes?: boolean } = {}) {
  const cx = W / 2;
  // torso: ink border, white interior
  for (let y = 70; y < 140; y++)
    for (let x = cx - 26; x <= cx + 26; x++) {
      const border = x <= cx - 24 || x >= cx + 24 || y <= 72 || y >= 138;
      c.set(x, y, border ? INK : opts.whiteClothes ? PAPER : SKIN);
    }
  // head: ink ellipse, white interior
  for (let y = 20; y < 76; y++)
    for (let x = cx - 22; x <= cx + 22; x++) {
      const dx = (x - cx) / 21;
      const dy = (y - 47) / 27;
      const r = dx * dx + dy * dy;
      if (r <= 1) c.set(x, y, r > 0.82 ? INK : SKIN);
    }
  // eyes: enclosed dark regions inside the white face
  for (let y = 40; y < 47; y++) {
    for (let x = cx - 13; x < cx - 6; x++) c.set(x, y, INK);
    for (let x = cx + 6; x < cx + 13; x++) c.set(x, y, INK);
  }
}

async function encodePng(c: Canvas): Promise<Buffer> {
  return sharp(c.buf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function encodeJpeg(c: Canvas): Promise<Buffer> {
  return sharp(c.buf, { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 88 }).toBuffer();
}

interface AlphaReport {
  channels: number;
  alphaMin: number;
  alphaMax: number;
  transparentPixels: number;
  opaquePixels: number;
  transparentRatio: number;
}

async function readAlpha(png: Buffer): Promise<AlphaReport & { rgba: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let alphaMin = 255;
  let alphaMax = 0;
  let transparentPixels = 0;
  let opaquePixels = 0;
  const total = info.width * info.height;
  for (let p = 0; p < total; p++) {
    const a = data[p * 4 + 3];
    if (a < alphaMin) alphaMin = a;
    if (a > alphaMax) alphaMax = a;
    if (a < 16) transparentPixels++;
    if (a > 239) opaquePixels++;
  }
  return {
    rgba: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    alphaMin,
    alphaMax,
    transparentPixels,
    opaquePixels,
    transparentRatio: transparentPixels / total,
  };
}

const alphaAt = (r: { rgba: Buffer; width: number }, x: number, y: number) => r.rgba[(y * r.width + x) * 4 + 3];
const rgbAt = (r: { rgba: Buffer; width: number }, x: number, y: number): Rgb => {
  const o = (y * r.width + x) * 4;
  return [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]];
};

/**
 * Count VISIBLE pixels still carrying a checkerboard tile colour.
 *
 * The tile colours passed here are chosen to appear nowhere in the artwork, so
 * any visible pixel near them can only have come from the baked grid. Counting
 * adjacent colour steps instead would flag every ink outline, which is
 * artwork, not tiling. Fully transparent pixels are ignored — once alpha is 0
 * their RGB cannot be composited.
 */
function visibleTilePixels(r: { rgba: Buffer; width: number; height: number }, tints: Rgb[]): number {
  let count = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (alphaAt(r, x, y) <= 200) continue;
      if (tints.some((tint) => colorDistance(rgbAt(r, x, y), tint) < 20)) count++;
    }
  }
  return count;
}

describe("character transparency contract", () => {
  // ── 1 ──────────────────────────────────────────────────────────────────
  it("accepts a true RGBA character asset and still emits its own derivative", async () => {
    const c = canvas();
    fillTransparent(c);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");

    expect(result.processingStatus).toBe("ready");
    expect(result.sourceHasAlpha).toBe(true);
    expect(result.hasAlpha).toBe(true);
    // Never "no derivative": that is what let the raw source be rendered.
    expect(result.processedData).toBeDefined();
    // A clean source is passed through unchanged — decontamination declines
    // when there is no matte to detect rather than inventing one.
    expect(result.processingMethod).not.toContain("decontaminated");
  });

  // ── 2 ──────────────────────────────────────────────────────────────────
  it("extracts a character from an opaque white background", async () => {
    const c = canvas();
    fillSolid(c, PAPER);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");

    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
    expect(result.backgroundRemoved).toBe(true);

    const out = await readAlpha(result.processedData!);
    expect(out.transparentPixels).toBeGreaterThan(1000);
    expect(out.alphaMin).toBe(0);
    expect(out.alphaMax).toBe(255);
    expect(alphaAt(out, 1, 1)).toBe(0);
    expect(alphaAt(out, W / 2, 100)).toBe(255);
  });

  // ── 3 ── the exact production failure ──────────────────────────────────
  it("extracts a character from a LIGHT baked checkerboard (the shipped failure)", async () => {
    const c = canvas();
    fillChecker(c, GRID_LIGHT);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");

    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
    expect(result.backgroundRemoved).toBe(true);

    const out = await readAlpha(result.processedData!);
    expect(out.transparentPixels).toBeGreaterThan(1000);
    expect(alphaAt(out, 1, 1)).toBe(0);
    expect(alphaAt(out, W - 2, H - 2)).toBe(0);
    expect(alphaAt(out, W / 2, 100)).toBe(255);
  });

  it("extracts a character from a DARK baked checkerboard", async () => {
    const c = canvas();
    fillChecker(c, GRID_DARK);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");

    expect(result.processingStatus).toBe("ready");
    const out = await readAlpha(result.processedData!);
    expect(out.transparentPixels).toBeGreaterThan(1000);
    expect(alphaAt(out, 1, 1)).toBe(0);
  });

  // ── 5 (spec §5) ────────────────────────────────────────────────────────
  it("never leaves checkerboard pixels in the visible bitmap", async () => {
    // Tile tints that the figure never uses, so finding one visible proves
    // grid pixels survived into the stored bitmap.
    const cases: { grid: [Rgb, Rgb]; tints: Rgb[] }[] = [
      { grid: GRID_LIGHT, tints: [GRID_LIGHT[1]] },
      { grid: GRID_DARK, tints: [GRID_DARK[0], GRID_DARK[1]] },
    ];

    for (const { grid, tints } of cases) {
      const c = canvas();
      fillChecker(c, grid);
      drawFigure(c);
      const result = await processAssetImage(await encodePng(c), "character");
      expect(result.processingStatus).toBe("ready");

      const before = await readAlpha(await encodePng(c));
      const after = await readAlpha(result.processedData!);

      expect(visibleTilePixels(before, tints)).toBeGreaterThan(1000);
      expect(visibleTilePixels(after, tints)).toBe(0);
    }
  });

  it("extracts a character from a chroma-key screen", async () => {
    const c = canvas();
    fillSolid(c, CHROMA_KEY);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");

    expect(result.processingStatus).toBe("ready");
    expect(result.processingMethod).toContain("chroma-key");

    const out = await readAlpha(result.processedData!);
    expect(out.transparentPixels).toBeGreaterThan(1000);
    expect(alphaAt(out, 1, 1)).toBe(0);
    // No magenta may survive in visible pixels.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (alphaAt(out, x, y) > 200) expect(colorDistance(rgbAt(out, x, y), CHROMA_KEY)).toBeGreaterThan(60);
  });

  // ── 4, 6 ───────────────────────────────────────────────────────────────
  it("preserves white clothing and enclosed white areas on a white background", async () => {
    const c = canvas();
    fillSolid(c, PAPER);
    drawFigure(c, { whiteClothes: true });
    const result = await processAssetImage(await encodePng(c), "character");
    expect(result.processingStatus).toBe("ready");

    const out = await readAlpha(result.processedData!);
    // torso interior is pure white and identical to the background colour —
    // only connectivity can keep it.
    expect(alphaAt(out, W / 2, 100)).toBe(255);
    expect(alphaAt(out, W / 2 - 20, 100)).toBe(255);
    // face interior (white skin) survives
    expect(alphaAt(out, W / 2, 55)).toBe(255);
    // and the background is still gone
    expect(alphaAt(out, 1, 1)).toBe(0);
  });

  it("preserves white skin regions enclosed by ink on a checkerboard", async () => {
    const c = canvas();
    fillChecker(c, GRID_LIGHT);
    drawFigure(c, { whiteClothes: true });
    const result = await processAssetImage(await encodePng(c), "character");
    expect(result.processingStatus).toBe("ready");

    const out = await readAlpha(result.processedData!);
    expect(alphaAt(out, W / 2, 100)).toBe(255);
    expect(alphaAt(out, W / 2, 55)).toBe(255);
    expect(alphaAt(out, 1, 1)).toBe(0);
  });

  it("keeps enclosed dark detail (eyes) fully opaque", async () => {
    const c = canvas();
    fillSolid(c, PAPER);
    drawFigure(c);
    const result = await processAssetImage(await encodePng(c), "character");
    const out = await readAlpha(result.processedData!);
    expect(alphaAt(out, W / 2 - 10, 43)).toBe(255);
    expect(alphaAt(out, W / 2 + 10, 43)).toBe(255);
  });

  it("survives JPEG tile-seam noise on a checkerboard", async () => {
    const c = canvas();
    fillChecker(c, GRID_LIGHT);
    drawFigure(c);
    const result = await processAssetImage(await encodeJpeg(c), "character");

    expect(result.processingStatus).toBe("ready");
    const out = await readAlpha(result.processedData!);
    expect(out.transparentRatio).toBeGreaterThan(0.3);
    expect(alphaAt(out, W / 2, 100)).toBe(255);
  });

  // ── 7 ──────────────────────────────────────────────────────────────────
  it("fails loudly rather than shipping an unusable cutout", async () => {
    // A full-bleed photo-like field has no stable border background and no
    // subject to isolate.
    const c = canvas();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) c.set(x, y, [(x * 7) % 256, (y * 11) % 256, (x * y) % 256]);

    const result = await processAssetImage(await encodePng(c), "character");
    expect(result.processingStatus).toBe("failed");
    expect(result.hasAlpha).toBe(false);
    expect(result.processedData).toBeUndefined();
    expect(result.reason).toBeTruthy();
  });

  it("fails when the subject fills the entire frame", async () => {
    const c = canvas();
    fillSolid(c, PAPER);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c.set(x, y, INK);
    const result = await processAssetImage(await encodePng(c), "character");
    expect(result.processingStatus).toBe("failed");
    expect(result.processedData).toBeUndefined();
  });

  // ── background/prop category behaviour ─────────────────────────────────
  it("leaves background assets opaque and rectangular", async () => {
    const c = canvas();
    fillSolid(c, [140, 160, 190]);
    const result = await processAssetImage(await encodePng(c), "background");
    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(false);
    expect(result.processedData).toBeUndefined();
  });

  it("extracts props like characters", async () => {
    const c = canvas();
    fillSolid(c, PAPER);
    for (let y = 60; y < 110; y++) for (let x = 40; x < 80; x++) c.set(x, y, [30, 90, 170]);
    const result = await processAssetImage(await encodePng(c), "prop");
    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
    const out = await readAlpha(result.processedData!);
    expect(alphaAt(out, 1, 1)).toBe(0);
    expect(alphaAt(out, 60, 80)).toBe(255);
  });

  // ── background model estimation ────────────────────────────────────────
  describe("background model estimation", () => {
    const modelOf = async (build: (c: Canvas) => void) => {
      const c = canvas();
      build(c);
      const { data, info } = await sharp(c.buf, { raw: { width: W, height: H, channels: 4 } })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return estimateEdgeBackground(data, info.width, info.height);
    };

    it("classifies a light transparency grid as two-tone, not solid", async () => {
      const model = await modelOf((c) => {
        fillChecker(c, GRID_LIGHT);
        drawFigure(c);
      });
      expect(model?.kind).toBe("checkerboard");
      expect(model?.colors).toHaveLength(2);
    });

    it("classifies a saturated screen as a chroma key", async () => {
      const model = await modelOf((c) => {
        fillSolid(c, CHROMA_KEY);
        drawFigure(c);
      });
      expect(model?.kind).toBe("chroma-key");
    });

    it("classifies a plain white field as solid", async () => {
      const model = await modelOf((c) => {
        fillSolid(c, PAPER);
        drawFigure(c);
      });
      expect(model?.kind).toBe("solid");
    });
  });
});
