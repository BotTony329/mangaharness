/**
 * Scene versus Object.
 *
 * A Scene is a rectangular environment and must keep its whole image. An Object
 * is a reusable cutout and must have its background removed. Sending a Scene
 * through foreground extraction would punch holes in a classroom; skipping it
 * for an Object leaves a white slab on top of the scene.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "@/assets/postProcessor";
import { buildAssetPrompt } from "./promptTemplates";
import { requestsColouredMatte } from "./foregroundPolicy";

/** A subject on a plain white field — what the foreground policy asks for. */
async function onWhite(): Promise<Buffer> {
  const w = 80;
  const h = 80;
  const rgb = Buffer.alloc(w * h * 3, 255);
  for (let y = 24; y < 56; y += 1) {
    for (let x = 24; x < 56; x += 1) {
      const o = (y * w + x) * 3;
      rgb[o] = 30;
      rgb[o + 1] = 32;
      rgb[o + 2] = 40;
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A full-frame environment: no plain border, nothing to key out. */
async function scene(): Promise<Buffer> {
  const w = 80;
  const h = 80;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 3;
      rgb[o] = 40 + ((x * 3) % 90);
      rgb[o + 1] = 30 + ((y * 5) % 110);
      rgb[o + 2] = 90 + ((x + y) % 120);
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("scene assets keep their whole image", () => {
  it("a background is never sent through foreground extraction", async () => {
    const result = await processAssetImage(await scene(), "background", {});
    expect(result.processingStatus).toBe("ready");
    // No derivative, no alpha: the rectangle survives intact.
    expect(result.backgroundRemoved).toBe(false);
    expect(result.hasAlpha).toBe(false);
    expect(result.processedData).toBeUndefined();
  });

  it("a scene prompt does not ask for an isolated subject on white", () => {
    const prompt = buildAssetPrompt({ assetType: "background", description: "Japanese classroom" });
    expect(prompt).not.toContain("#FFFFFF");
    expect(prompt).not.toContain("Isolated single");
  });
});

describe("object assets are cut out", () => {
  it("a prop generated on white becomes transparent", async () => {
    const result = await processAssetImage(await onWhite(), "prop", { requireWhiteBackground: true });
    expect(result.processingStatus).toBe("ready");
    expect(result.backgroundRemoved).toBe(true);
    expect(result.hasAlpha).toBe(true);
    expect(result.processedData).toBeDefined();
  });

  it("an object prompt asks for pure white and never a coloured matte", () => {
    const prompt = buildAssetPrompt({ assetType: "prop", description: "small retro desk lamp" });
    expect(prompt).toContain("#FFFFFF");
    expect(requestsColouredMatte(prompt)).toBe(false);
  });

  it("a white object survives extraction because the flood is connectivity-based", async () => {
    // A white notebook with a dark outline, on a white field: the interior
    // white is fenced in by ink and must NOT be keyed out with the background.
    const w = 80;
    const h = 80;
    const rgb = Buffer.alloc(w * h * 3, 255);
    for (let y = 20; y < 60; y += 1) {
      for (let x = 20; x < 60; x += 1) {
        const edge = y < 23 || y > 56 || x < 23 || x > 56;
        const o = (y * w + x) * 3;
        const value = edge ? 25 : 252;
        rgb[o] = value;
        rgb[o + 1] = value;
        rgb[o + 2] = value;
      }
    }
    const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const result = await processAssetImage(png, "prop", { requireWhiteBackground: true });
    expect(result.processingStatus).toBe("ready");

    const { data } = await sharp(result.processedData!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    // The enclosed white page is still opaque; the outside is gone.
    expect(alphaAt(40, 40)).toBeGreaterThan(200);
    expect(alphaAt(2, 2)).toBe(0);
  });
});
