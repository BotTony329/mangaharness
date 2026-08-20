import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "./postProcessor";

describe("asset post processor", () => {
  it("preserves a transparent source image without re-encoding it", async () => {
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
    expect(result.processedData).toBeUndefined();
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
    const source = await sharp(pixels, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();

    const result = await processAssetImage(source, "character");

    expect(result.processingStatus).toBe("failed");
    expect(result.hasAlpha).toBe(false);
    expect(result.reason).toContain("checkerboard");
  });
});

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
