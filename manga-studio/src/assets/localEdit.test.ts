/**
 * Local generative editing: the enforcement proof.
 *
 * Every provider fixture here deliberately misbehaves — it rewrites the WHOLE
 * image, exactly as a real image-edit model does. The tests assert that what
 * reaches the asset is still local. A prompt asking nicely is not evidence;
 * pixel equality outside the mask is.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATHER,
  MAX_FEATHER,
  compositeLocalEdit,
  emptyMask,
  featherMask,
  maskBounds,
  maskCoverage,
  maskFromRgba,
  maskIsEmpty,
  restoreAlpha,
  type SelectionMask,
} from "./localEdit";

const W = 64;
const H = 64;

type Rgba = [number, number, number, number];

function fill(color: Rgba, width = W, height = H): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    buffer[pixel * 4] = color[0];
    buffer[pixel * 4 + 1] = color[1];
    buffer[pixel * 4 + 2] = color[2];
    buffer[pixel * 4 + 3] = color[3];
  }
  return buffer;
}

function paintRect(buffer: Buffer, x: number, y: number, w: number, h: number, color: Rgba, width = W): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const offset = (py * width + px) * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
}

function rectMask(x: number, y: number, w: number, h: number, width = W, height = H): SelectionMask {
  const mask = emptyMask(width, height);
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) mask.data[py * width + px] = 255;
  }
  return mask;
}

const pixelAt = (buffer: Buffer, x: number, y: number, width = W): Rgba => {
  const offset = (y * width + x) * 4;
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
};

// ─── A: the masked edit ────────────────────────────────────────────────────

describe("outside-mask preservation", () => {
  it("keeps the original outside the mask and takes the edit inside it", () => {
    // Original: red everywhere, blue square in the middle.
    const original = fill([220, 40, 40, 255]);
    paintRect(original, 24, 24, 16, 16, [40, 60, 220, 255]);
    // The provider ignores the instruction and paints EVERYTHING green.
    const generated = fill([30, 200, 90, 255]);
    const mask = rectMask(24, 24, 16, 16);

    const result = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: 0 });

    // Inside: the provider's green.
    expect(pixelAt(result.rgba, 32, 32)).toEqual([30, 200, 90, 255]);
    // Outside: the original red, byte for byte — not "close to".
    expect(pixelAt(result.rgba, 2, 2)).toEqual([220, 40, 40, 255]);
    expect(pixelAt(result.rgba, 60, 60)).toEqual([220, 40, 40, 255]);
    expect(pixelAt(result.rgba, 23, 32)).toEqual([220, 40, 40, 255]);
  });

  it("reproduces every unmasked byte exactly, across the whole image", () => {
    const original = fill([12, 34, 56, 255]);
    for (let i = 0; i < W * H * 4; i += 1) original[i] = (i * 37) % 256;
    const generated = fill([0, 0, 0, 255]);
    const mask = rectMask(10, 10, 8, 8);

    const result = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: 0 });

    let mismatched = 0;
    for (let pixel = 0; pixel < W * H; pixel += 1) {
      if (mask.data[pixel] > 0) continue;
      const offset = pixel * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        if (result.rgba[offset + channel] !== original[offset + channel]) mismatched += 1;
      }
    }
    expect(mismatched).toBe(0);
    expect(result.editedPixels).toBe(64);
    expect(result.preservedPixels).toBe(W * H - 64);
  });

  it("refuses mismatched dimensions rather than composing garbage", () => {
    expect(() =>
      compositeLocalEdit({
        original: fill([0, 0, 0, 255]),
        generated: fill([0, 0, 0, 255]),
        mask: emptyMask(32, 32),
        width: W,
        height: H,
      }),
    ).toThrow(/Mask dimensions/);

    expect(() =>
      compositeLocalEdit({
        original: fill([0, 0, 0, 255], 8, 8),
        generated: fill([0, 0, 0, 255]),
        mask: emptyMask(W, H),
        width: W,
        height: H,
      }),
    ).toThrow(/RGBA at the original dimensions/);
  });

  it("an empty mask changes nothing at all", () => {
    const original = fill([90, 120, 150, 255]);
    const result = compositeLocalEdit({
      original,
      generated: fill([255, 0, 255, 255]),
      mask: emptyMask(W, H),
      width: W,
      height: H,
    });
    expect(result.rgba.equals(original)).toBe(true);
    expect(result.editedPixels).toBe(0);
  });
});

// ─── B: feather is bounded and inward ──────────────────────────────────────

describe("feather", () => {
  it("never spreads coverage outside the drawn mask", () => {
    const mask = rectMask(20, 20, 24, 24);
    const feathered = featherMask(mask, 8);
    for (let pixel = 0; pixel < mask.data.length; pixel += 1) {
      // The clamp: no coverage may appear where none was painted.
      if (mask.data[pixel] === 0) expect(feathered[pixel]).toBe(0);
    }
  });

  it("creates a transition only near the boundary, leaving the core solid", () => {
    const mask = rectMask(16, 16, 32, 32);
    const feathered = featherMask(mask, 6);
    const value = (x: number, y: number) => feathered[y * W + x];

    // Deep inside stays fully editable.
    expect(value(32, 32)).toBe(255);
    // Just inside the edge is partial.
    expect(value(17, 32)).toBeGreaterThan(0);
    expect(value(17, 32)).toBeLessThan(255);
    // Just outside is untouched.
    expect(value(15, 32)).toBe(0);
  });

  it("clamps an absurd radius rather than dissolving the mask", () => {
    const mask = rectMask(24, 24, 16, 16);
    const feathered = featherMask(mask, 9999);
    expect(feathered.some((value) => value > 0)).toBe(true);
    // Still bounded to the drawn region.
    for (let pixel = 0; pixel < mask.data.length; pixel += 1) {
      if (mask.data[pixel] === 0) expect(feathered[pixel]).toBe(0);
    }
    expect(MAX_FEATHER).toBeLessThan(9999);
  });

  it("still preserves the outside exactly when feathering is on", () => {
    const original = fill([220, 40, 40, 255]);
    const generated = fill([30, 200, 90, 255]);
    const mask = rectMask(24, 24, 16, 16);
    const result = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: DEFAULT_FEATHER });
    expect(pixelAt(result.rgba, 2, 2)).toEqual([220, 40, 40, 255]);
    expect(pixelAt(result.rgba, 23, 32)).toEqual([220, 40, 40, 255]);
  });
});

// ─── C: transparency ───────────────────────────────────────────────────────

describe("transparency", () => {
  it("keeps a transparent exterior transparent after a local edit", () => {
    // A cut-out object: opaque blob, transparent surround.
    const original = fill([0, 0, 0, 0]);
    paintRect(original, 20, 20, 24, 24, [180, 160, 90, 255]);
    // The provider flattens everything onto opaque white.
    const generated = fill([255, 255, 255, 255]);
    paintRect(generated, 20, 20, 24, 24, [90, 200, 255, 255]);
    const mask = rectMask(24, 24, 8, 8);

    const composited = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: 0 }).rgba;
    const restored = restoreAlpha(composited, original, mask, false);

    // Exterior still empty — the lamp did not gain a white slab.
    expect(pixelAt(restored, 2, 2)[3]).toBe(0);
    expect(pixelAt(restored, 50, 50)[3]).toBe(0);
    // The edited region took the new colour but kept the original opacity.
    expect(pixelAt(restored, 26, 26).slice(0, 3)).toEqual([90, 200, 255]);
    expect(pixelAt(restored, 26, 26)[3]).toBe(255);
  });

  it("trusts provider alpha when the provider actually returned one", () => {
    const original = fill([180, 160, 90, 255]);
    const generated = fill([0, 0, 0, 0]);
    const mask = rectMask(24, 24, 8, 8);
    const composited = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: 0 }).rgba;
    const restored = restoreAlpha(composited, original, mask, true);
    // Erasing inside the mask is a legitimate edit when alpha is real.
    expect(pixelAt(restored, 26, 26)[3]).toBe(0);
    // Outside is still the original.
    expect(pixelAt(restored, 2, 2)[3]).toBe(255);
  });
});

// ─── D: white detail survives ──────────────────────────────────────────────

describe("white artwork", () => {
  it("does not lose white clothing outside the mask", () => {
    const original = fill([20, 20, 24, 255]);
    // A white shirt region, well outside the edit.
    paintRect(original, 4, 40, 16, 16, [252, 252, 252, 255]);
    const generated = fill([120, 40, 40, 255]);
    const mask = rectMask(40, 8, 12, 12);

    const result = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: DEFAULT_FEATHER });
    expect(pixelAt(result.rgba, 10, 46)).toEqual([252, 252, 252, 255]);
  });
});

// ─── Mask utilities ────────────────────────────────────────────────────────

describe("mask utilities", () => {
  it("reads coverage from a painted RGBA mask image", () => {
    const painted = Buffer.alloc(W * H * 4);
    paintRect(painted, 10, 10, 4, 4, [255, 255, 255, 255]);
    const mask = maskFromRgba(painted, W, H);
    expect(mask.data[11 * W + 11]).toBe(255);
    expect(mask.data[0]).toBe(0);
    expect(maskIsEmpty(mask)).toBe(false);
  });

  it("reports emptiness, coverage and bounds", () => {
    expect(maskIsEmpty(emptyMask(W, H))).toBe(true);
    expect(maskBounds(emptyMask(W, H))).toBeNull();

    const mask = rectMask(8, 12, 4, 6);
    expect(maskBounds(mask)).toEqual({ x: 8, y: 12, width: 4, height: 6 });
    expect(maskCoverage(mask)).toBeCloseTo(24 / (W * H), 6);
  });
});

// ─── §33: the character acceptance test ────────────────────────────────────

describe("character local edit acceptance", () => {
  /** Regions of a synthetic Yuri, so each can be checked independently. */
  const REGIONS = {
    face: { x: 26, y: 6, w: 12, h: 10, color: [246, 214, 190, 255] as Rgba },
    hair: { x: 22, y: 2, w: 20, h: 6, color: [24, 22, 32, 255] as Rgba },
    torso: { x: 22, y: 18, w: 20, h: 20, color: [150, 200, 235, 255] as Rgba },
    leftArm: { x: 14, y: 18, w: 6, h: 18, color: [150, 200, 235, 255] as Rgba },
    legs: { x: 24, y: 40, w: 16, h: 20, color: [26, 35, 72, 255] as Rgba },
    rightHand: { x: 44, y: 32, w: 8, h: 8, color: [246, 214, 190, 255] as Rgba },
  };

  function yuri(): Buffer {
    const buffer = fill([0, 0, 0, 0]);
    for (const region of Object.values(REGIONS)) {
      paintRect(buffer, region.x, region.y, region.w, region.h, region.color);
    }
    return buffer;
  }

  function regionBytes(buffer: Buffer, region: { x: number; y: number; w: number; h: number }): number[] {
    const bytes: number[] = [];
    for (let y = region.y; y < region.y + region.h; y += 1) {
      for (let x = region.x; x < region.x + region.w; x += 1) {
        const offset = (y * W + x) * 4;
        bytes.push(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
      }
    }
    return bytes;
  }

  it("masking only the right hand leaves every other region pixel-identical", () => {
    const original = yuri();
    /**
     * The provider does what providers do: it redraws the entire character —
     * different skin, different hair, a different shirt — while also fixing the
     * hand. None of that may survive outside the mask.
     */
    const generated = fill([255, 0, 255, 255]);
    paintRect(generated, 44, 32, 8, 8, [250, 220, 200, 255]);

    const mask = rectMask(REGIONS.rightHand.x, REGIONS.rightHand.y, REGIONS.rightHand.w, REGIONS.rightHand.h);
    const result = compositeLocalEdit({ original, generated, mask, width: W, height: H, feather: 0 });

    for (const [name, region] of Object.entries(REGIONS)) {
      if (name === "rightHand") continue;
      expect(regionBytes(result.rgba, region), name).toEqual(regionBytes(original, region));
    }
    // The hand did change.
    expect(regionBytes(result.rgba, REGIONS.rightHand)).not.toEqual(regionBytes(original, REGIONS.rightHand));
    expect(pixelAt(result.rgba, 46, 34)).toEqual([250, 220, 200, 255]);
    // And the magenta the provider invented never reached the asset.
    let magenta = 0;
    for (let pixel = 0; pixel < W * H; pixel += 1) {
      const offset = pixel * 4;
      if (result.rgba[offset] === 255 && result.rgba[offset + 1] === 0 && result.rgba[offset + 2] === 255) magenta += 1;
    }
    expect(magenta).toBe(0);
  });

  it("output dimensions always equal the original", () => {
    const original = yuri();
    const result = compositeLocalEdit({
      original,
      generated: fill([1, 2, 3, 255]),
      mask: rectMask(10, 10, 4, 4),
      width: W,
      height: H,
    });
    expect(result.rgba.length).toBe(original.length);
  });
});
