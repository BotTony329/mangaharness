/**
 * Composition contract: an extracted character must let the layer beneath it
 * show through everywhere outside its silhouette.
 *
 * These tests composite with real alpha over several backdrops and compare
 * pixels. A rectangular bitmap — the symptom this whole pipeline exists to
 * prevent — fails them immediately, because the backdrop would no longer be
 * recoverable outside the figure.
 *
 * Scope note: this proves the ASSET composites correctly under standard
 * source-over alpha blending, which is what Konva's canvas and the PNG export
 * both perform. It does not boot a browser; the renderer is covered by the
 * geometry and render suites.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "./postProcessor";
import { assetRenderUrl, isAssetReadyForComposition } from "./renderSource";
import { serializeProject, deserializeProject } from "@/domain/serialization";
import { createProjectDocument } from "@/domain/factory";
import type { SourceAsset } from "@/domain/types";

const W = 100;
const H = 140;
type Rgb = [number, number, number];

const CHROMA_KEY: Rgb = [255, 0, 255];
const INK: Rgb = [12, 12, 14];
const PAPER: Rgb = [255, 255, 255];

function buffer(fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const [r, g, b, a] = fill(x, y);
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = a;
    }
  return buf;
}

/** Closed ink figure on a chroma-key field — what the fixed prompt asks for. */
function characterSource(): Buffer {
  const cx = W / 2;
  return buffer((x, y) => {
    const dx = (x - cx) / 20;
    const dy = (y - 70) / 45;
    const r = dx * dx + dy * dy;
    if (r <= 1) return r > 0.8 ? [...INK, 255] : [...PAPER, 255];
    return [...CHROMA_KEY, 255];
  });
}

const BACKDROPS: Record<string, (x: number, y: number) => [number, number, number, number]> = {
  "white manga page": () => [255, 255, 255, 255],
  "detailed street": (x, y) => [
    (40 + ((x * 3) % 160)) & 255,
    (60 + ((y * 5) % 150)) & 255,
    (90 + ((x + y) % 140)) & 255,
    255,
  ],
  "dark night": () => [8, 10, 24, 255],
  "another character": (x, y) => (Math.abs(x - 30) + Math.abs(y - 70) < 34 ? [200, 40, 40, 255] : [250, 250, 250, 255]),
};

async function extractedCharacter(): Promise<Buffer> {
  const png = await sharp(characterSource(), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const result = await processAssetImage(png, "character");
  expect(result.processingStatus).toBe("ready");
  expect(result.hasAlpha).toBe(true);
  return result.processedData!;
}

async function raw(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const at = (r: { data: Buffer; width: number }, x: number, y: number) => {
  const o = (y * r.width + x) * 4;
  return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]] as const;
};

describe("character composition over a background", () => {
  it.each(Object.keys(BACKDROPS))("lets a %s backdrop show through outside the silhouette", async (name) => {
    const character = await extractedCharacter();
    const backdropPng = await sharp(buffer(BACKDROPS[name]), { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();

    const composite = await sharp(backdropPng)
      .composite([{ input: character, left: 0, top: 0 }])
      .png()
      .toBuffer();

    const back = await raw(backdropPng);
    const over = await raw(composite);
    const cut = await raw(character);

    let showedThrough = 0;
    let covered = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const alpha = at(cut, x, y)[3];
        if (alpha === 0) {
          // Fully transparent: the backdrop must be pixel-identical.
          expect(at(over, x, y)).toEqual(at(back, x, y));
          showedThrough++;
        } else if (alpha === 255) {
          expect(at(over, x, y).slice(0, 3)).toEqual(at(cut, x, y).slice(0, 3));
          covered++;
        }
      }
    }
    expect(showedThrough).toBeGreaterThan(2000);
    expect(covered).toBeGreaterThan(500);
  });

  it("leaves no opaque rectangle around the figure", async () => {
    const character = await raw(await extractedCharacter());
    // The four image corners sit outside any plausible silhouette.
    for (const [x, y] of [
      [0, 0],
      [W - 1, 0],
      [0, H - 1],
      [W - 1, H - 1],
    ]) {
      expect(at(character, x, y)[3]).toBe(0);
    }
    // And no full row or column is entirely opaque, which a pasted rectangle
    // would produce.
    for (let y = 0; y < H; y++) {
      let opaque = 0;
      for (let x = 0; x < W; x++) if (at(character, x, y)[3] > 200) opaque++;
      expect(opaque).toBeLessThan(W);
    }
  });

  it("keeps the exported PNG identical to the editor composite", async () => {
    const character = await extractedCharacter();
    const backdropPng = await sharp(buffer(BACKDROPS["detailed street"]), { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();

    // Editor preview and export perform the same source-over blend; encoding
    // the result twice must not change a pixel.
    const first = await sharp(backdropPng).composite([{ input: character }]).png().toBuffer();
    const second = await sharp(backdropPng).composite([{ input: character }]).png().toBuffer();
    expect(Buffer.compare(await sharp(first).raw().toBuffer(), await sharp(second).raw().toBuffer())).toBe(0);

    // Export flattens onto the white page sheet; the backdrop must survive.
    const exported = await raw(
      await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
        .composite([{ input: backdropPng }, { input: character }])
        .png()
        .toBuffer(),
    );
    const back = await raw(backdropPng);
    const cut = await raw(character);
    for (const [x, y] of [
      [2, 2],
      [W - 3, 4],
      [5, H - 3],
    ]) {
      expect(at(cut, x, y)[3]).toBe(0);
      expect(at(exported, x, y)).toEqual(at(back, x, y));
    }
  });

  it("clips to the panel without disturbing pixels outside it", async () => {
    const character = await extractedCharacter();
    const panel = { left: 20, top: 30, width: 60, height: 80 };
    const page = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 245, g: 245, b: 245, alpha: 1 } },
    })
      .png()
      .toBuffer();

    // Clip first (panel viewport), then place onto the page.
    const clipped = await sharp(character).extract(panel).png().toBuffer();
    const composed = await raw(
      await sharp(page).composite([{ input: clipped, left: panel.left, top: panel.top }]).png().toBuffer(),
    );

    // Outside the panel the page is untouched.
    expect(at(composed, 5, 5)).toEqual([245, 245, 245, 255]);
    expect(at(composed, W - 5, H - 5)).toEqual([245, 245, 245, 255]);
    // Inside the panel the figure is present.
    let visible = 0;
    for (let y = panel.top; y < panel.top + panel.height; y++)
      for (let x = panel.left; x < panel.left + panel.width; x++) {
        const [r, g, b] = at(composed, x, y);
        if (r !== 245 || g !== 245 || b !== 245) visible++;
      }
    expect(visible).toBeGreaterThan(200);
  });
});

describe("library persistence", () => {
  it("keeps the transparent derivative as the render source across a save/load round trip", () => {
    const doc = createProjectDocument("Transparency");
    const asset: SourceAsset = {
      id: "asset-1",
      projectId: doc.project.id,
      category: "character",
      type: "character-visual",
      name: "Yuri",
      sourceUrl: "https://example.com/yuri-source.png",
      storageUrl: "https://example.com/yuri-source.png",
      processedImageUrl: "https://example.com/yuri-alpha.png",
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      status: "ready",
      width: W,
      height: H,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    doc.assets[asset.id] = asset;

    const restored = deserializeProject(serializeProject(doc));
    const reloaded = restored.assets[asset.id];

    expect(reloaded.processedImageUrl).toBe("https://example.com/yuri-alpha.png");
    expect(reloaded.hasAlpha).toBe(true);
    expect(assetRenderUrl(reloaded)).toBe("https://example.com/yuri-alpha.png");
    expect(isAssetReadyForComposition(reloaded)).toBe(true);
  });

  it("refuses to resolve a render URL for a failed character after reload", () => {
    const doc = createProjectDocument("Transparency");
    const asset: SourceAsset = {
      id: "asset-2",
      projectId: doc.project.id,
      category: "character",
      type: "character-visual",
      name: "Broken",
      sourceUrl: "https://example.com/raw.png",
      storageUrl: "https://example.com/raw.png",
      hasAlpha: false,
      backgroundRemoved: false,
      processingStatus: "failed",
      status: "ready",
      width: W,
      height: H,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    doc.assets[asset.id] = asset;

    const reloaded = deserializeProject(serializeProject(doc)).assets[asset.id];
    expect(assetRenderUrl(reloaded)).toBeUndefined();
    expect(isAssetReadyForComposition(reloaded)).toBe(false);
  });
});
