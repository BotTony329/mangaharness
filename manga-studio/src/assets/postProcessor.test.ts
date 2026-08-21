import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { BackgroundRemovalProvider } from "./backgroundRemoval";
import { processAssetImage } from "./postProcessor";

describe("asset post processor", () => {
  it("produces a derivative for a transparent source instead of aliasing the raw file", async () => {
    const source = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: solid(16, 20, [20, 20, 20, 255]), left: 12, top: 10, raw: { width: 16, height: 20, channels: 4 } }])
      .png()
      .toBuffer();

    const result = await processAssetImage(source, "character");

    expect(result).toMatchObject({
      sourceHasAlpha: true,
      hasAlpha: true,
      backgroundRemoved: false,
      processingStatus: "ready",
    });
    /**
     * A transparency-requiring asset must ALWAYS carry a real derivative.
     * Returning none used to make `processAndStoreAsset` point
     * `processedImageUrl` at the untouched provider file, which is how a
     * contaminated edge reached the canvas while every contract check passed.
     */
    expect(result.processedData).toBeDefined();
  });

  it("removes only edge-connected white while preserving enclosed white artwork", async () => {
    const pixels = solid(40, 40, [255, 255, 255, 255]);
    paintRect(pixels, 40, 10, 6, 20, 30, [25, 25, 25, 255]);
    paintRect(pixels, 40, 17, 15, 6, 6, [255, 255, 255, 255]);
    const source = await sharp(pixels, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();

    const result = await processAssetImage(source, "character");
    expect(result).toMatchObject({ hasAlpha: true, backgroundRemoved: true, processingStatus: "ready" });
    const decoded = await sharp(result.processedData!).ensureAlpha().raw().toBuffer();
    expect(alphaAt(decoded, 40, 0, 0)).toBe(0);
    expect(alphaAt(decoded, 40, 12, 10)).toBe(255);
    expect(alphaAt(decoded, 40, 19, 17)).toBe(255);
  });

  it("leaves background assets rectangular and opaque", async () => {
    const source = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 250, g: 250, b: 250 } },
    }).jpeg().toBuffer();

    const result = await processAssetImage(source, "background");

    expect(result).toMatchObject({ hasAlpha: false, backgroundRemoved: false, processingStatus: "ready" });
    expect(result.processedData).toBeUndefined();
  });

  it("does not mistake an opaque checkerboard for real transparency", async () => {
    const pixels = solid(40, 40, [255, 255, 255, 255]);
    for (let y = 0; y < 40; y += 4) {
      for (let x = 0; x < 40; x += 4) {
        if ((x / 4 + y / 4) % 2 === 0) paintRect(pixels, 40, x, y, 4, 4, [190, 190, 190, 255]);
      }
    }
    // A subject the grid can actually be separated from.
    paintRect(pixels, 40, 12, 10, 16, 20, [20, 20, 25, 255]);
    const source = await sharp(pixels, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();

    const result = await processAssetImage(source, "character");

    // The painted grid is never mistaken for an alpha channel …
    expect(result.sourceHasAlpha).toBe(false);
    // … and a LIGHT grid must still be extractable. Asserting failure here is
    // what let the shipped regression through: the seeding rule required a
    // luminance above 283 on an 8-bit image, so a white-tiled grid could never
    // produce a foreground seed.
    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
    expect(result.backgroundRemoved).toBe(true);
    const decoded = await sharp(result.processedData!).ensureAlpha().raw().toBuffer();
    expect(alphaAt(decoded, 40, 0, 0)).toBe(0);
    expect(alphaAt(decoded, 40, 20, 20)).toBe(255);
  });

  it("extracts a connected subject from a baked checkerboard and preserves internal black and white art", async () => {
    const width = 80;
    const pixels = checkerboard(width, 96);
    paintRect(pixels, width, 20, 12, 40, 70, [245, 220, 205, 255]);
    paintRect(pixels, width, 25, 30, 30, 40, [252, 252, 252, 255]);
    paintRect(pixels, width, 28, 42, 24, 8, [15, 15, 20, 255]);
    const source = await sharp(pixels, { raw: { width, height: 96, channels: 4 } }).jpeg({ quality: 90 }).toBuffer();

    const result = await processAssetImage(source, "character");
    expect(result).toMatchObject({ hasAlpha: true, backgroundRemoved: true, processingStatus: "ready" });
    expect(result.processingMethod).toContain("checkerboard-matte");
    const decoded = await sharp(result.processedData!).ensureAlpha().raw().toBuffer();
    expect(alphaAt(decoded, width, 2, 2)).toBe(0);
    expect(alphaAt(decoded, width, 30, 35)).toBe(255);
    expect(alphaAt(decoded, width, 35, 45)).toBe(255);
  });

  it("keeps thin dark line art enclosing white artwork on a white background", async () => {
    const width = 64;
    const pixels = solid(width, 64, [255, 255, 255, 255]);
    paintRect(pixels, width, 15, 10, 34, 2, [10, 10, 10, 255]);
    paintRect(pixels, width, 15, 50, 34, 2, [10, 10, 10, 255]);
    paintRect(pixels, width, 15, 10, 2, 42, [10, 10, 10, 255]);
    paintRect(pixels, width, 47, 10, 2, 42, [10, 10, 10, 255]);
    const source = await sharp(pixels, { raw: { width, height: 64, channels: 4 } }).png().toBuffer();

    const result = await processAssetImage(source, "character");
    expect(result.processingStatus).toBe("ready");
    const decoded = await sharp(result.processedData!).ensureAlpha().raw().toBuffer();
    expect(alphaAt(decoded, width, 0, 0)).toBe(0);
    expect(alphaAt(decoded, width, 16, 10)).toBeGreaterThan(200);
    expect(alphaAt(decoded, width, 30, 30)).toBe(255);
  });

  it("preserves the source when a removal provider throws", async () => {
    const provider: BackgroundRemovalProvider = {
      id: "throwing-test-provider",
      async removeBackground() { throw new Error("provider unavailable"); },
    };
    const source = await opaqueSubject();
    const result = await processAssetImage(source, "character", { backgroundRemovalProvider: provider });
    expect(result).toMatchObject({ processingStatus: "failed", hasAlpha: false });
    expect(result.processedData).toBeUndefined();
    expect(result.reason).toContain("original source was preserved");
  });

  it.each([
    ["fully transparent", 0, 64 * 64],
    ["fully opaque", 255, 0],
  ])("rejects a %s provider output", async (_label, alpha, removedPixels) => {
    const provider: BackgroundRemovalProvider = {
      id: "invalid-test-provider",
      async removeBackground({ rgba }) {
        const output = Buffer.from(rgba);
        for (let index = 3; index < output.length; index += 4) output[index] = alpha;
        return { rgba: output, method: "edge-flood", removedPixels };
      },
    };
    const result = await processAssetImage(await opaqueSubject(), "character", { backgroundRemovalProvider: provider });
    expect(result.processingStatus).toBe("failed");
    expect(result.processedData).toBeUndefined();
  });
});

function checkerboard(width: number, height: number): Buffer {
  const pixels = solid(width, height, [42, 42, 42, 255]);
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      if ((x / 8 + y / 8) % 2 === 0) paintRect(pixels, width, x, y, 8, 8, [188, 188, 188, 255]);
    }
  }
  return pixels;
}

async function opaqueSubject(): Promise<Buffer> {
  const pixels = solid(64, 64, [255, 255, 255, 255]);
  paintRect(pixels, 64, 16, 10, 32, 44, [25, 80, 160, 255]);
  return sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const result = Buffer.alloc(width * height * 4);
  for (let index = 0; index < result.length; index += 4) {
    result[index] = rgba[0];
    result[index + 1] = rgba[1];
    result[index + 2] = rgba[2];
    result[index + 3] = rgba[3];
  }
  return result;
}

function paintRect(
  pixels: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  rgba: [number, number, number, number],
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const offset = (y * canvasWidth + x) * 4;
      pixels.set(rgba, offset);
    }
  }
}

function alphaAt(pixels: Buffer, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3];
}
