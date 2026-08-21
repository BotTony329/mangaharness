/**
 * Matte edge decontamination: the purple-halo regression suite.
 *
 * Every fixture is built by the compositing equation itself —
 * `Csrc = α·Cfg + (1−α)·Cmatte` — because that is exactly what an image model
 * produces when it anti-aliases a subject against a coloured screen. The tests
 * then run the REAL pipeline and composite the resulting PNG over four
 * backgrounds, which is the only way a halo actually becomes visible.
 *
 * The headline assertion is deliberately not "alpha reaches 0 and 255". That
 * passed happily while every silhouette carried a purple rim. What is asserted
 * is that compositing introduces no matte-coloured fringe, and that legitimate
 * artwork — including genuinely purple artwork — is not recoloured.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "./postProcessor";
import type { Rgb } from "./backgroundRemoval";

const MAGENTA: Rgb = [255, 0, 255];
const WHITE: Rgb = [255, 255, 255];

const BACKDROPS: { name: string; color: Rgb }[] = [
  { name: "white", color: [255, 255, 255] },
  { name: "black", color: [0, 0, 0] },
  { name: "mid-gray", color: [128, 128, 128] },
  { name: "saturated green", color: [0, 255, 0] },
];

interface Fixture {
  size: number;
  /** Sub-pixel coverage of the foreground at this pixel. */
  coverage(x: number, y: number): number;
  /** True foreground colour at this pixel, before any matte blending. */
  color(x: number, y: number): Rgb;
  matte?: Rgb;
}

/** Render a fixture the way a generator would: foreground blended onto the matte. */
async function renderSource(fixture: Fixture): Promise<Buffer> {
  const { size } = fixture;
  const matte = fixture.matte ?? MAGENTA;
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const a = fixture.coverage(x, y);
      const fg = fixture.color(x, y);
      const offset = (y * size + x) * 3;
      for (let c = 0; c < 3; c += 1) rgb[offset + c] = Math.round(a * fg[c] + (1 - a) * matte[c]);
    }
  }
  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function extract(fixture: Fixture): Promise<{ rgba: Buffer; size: number }> {
  const png = await renderSource(fixture);
  const result = await processAssetImage(png, "character", { forceBackgroundRemoval: true });
  expect(result.processingStatus, result.reason).toBe("ready");
  expect(result.processedData).toBeDefined();
  const { data } = await sharp(result.processedData!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, size: fixture.size };
}

function pixel(rgba: Buffer, size: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * size + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

/** Straight-alpha compositing, exactly as a renderer or exporter performs it. */
function composite(rgba: [number, number, number, number], backdrop: Rgb): Rgb {
  const a = rgba[3] / 255;
  return [
    Math.round(rgba[0] * a + backdrop[0] * (1 - a)),
    Math.round(rgba[1] * a + backdrop[1] * (1 - a)),
    Math.round(rgba[2] * a + backdrop[2] * (1 - a)),
  ];
}

/**
 * How magenta a colour is: the red/blue average minus green.
 *
 * A halo shows up as this value exceeding what the true composite would have,
 * which is the measurement that distinguishes "purple fringe" from "the
 * artwork is legitimately purple".
 */
function magentaness(color: Rgb): number {
  return (color[0] + color[2]) / 2 - color[1];
}

interface HaloReport {
  worstExcess: number;
  worstAt: { x: number; y: number; backdrop: string } | null;
}

/**
 * Composite over every backdrop and find the largest matte-coloured excess
 * relative to the physically correct result.
 */
function measureHalo(rgba: Buffer, fixture: Fixture): HaloReport {
  const { size } = fixture;
  let worstExcess = -Infinity;
  let worstAt: HaloReport["worstAt"] = null;

  for (const backdrop of BACKDROPS) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const coverage = fixture.coverage(x, y);
        const truth = fixture.color(x, y);
        const expected: Rgb = [
          coverage * truth[0] + (1 - coverage) * backdrop.color[0],
          coverage * truth[1] + (1 - coverage) * backdrop.color[1],
          coverage * truth[2] + (1 - coverage) * backdrop.color[2],
        ];
        const actual = composite(pixel(rgba, size, x, y), backdrop.color);
        const excess = magentaness(actual) - magentaness(expected);
        if (excess > worstExcess) {
          worstExcess = excess;
          worstAt = { x, y, backdrop: backdrop.name };
        }
      }
    }
  }
  return { worstExcess, worstAt };
}

/** A centred square with a two-pixel anti-aliased border. */
function squareFixture(fg: Rgb, size = 80, half = 20): Fixture {
  const centre = size / 2;
  return {
    size,
    coverage(x, y) {
      const d = Math.max(Math.abs(x + 0.5 - centre), Math.abs(y + 0.5 - centre));
      if (d <= half - 1) return 1;
      if (d <= half) return 0.75;
      if (d <= half + 1) return 0.25;
      return 0;
    },
    color: () => fg,
  };
}

/** Tolerance for "no fringe". A few units absorbs 8-bit rounding. */
const HALO_TOLERANCE = 10;

// ─── 1-4, 8: single-colour foregrounds on a magenta matte ──────────────────

const SINGLE_COLOUR_CASES: { name: string; fg: Rgb }[] = [
  { name: "black hair", fg: [12, 12, 16] },
  { name: "skin", fg: [247, 214, 190] },
  { name: "light-blue shirt", fg: [150, 200, 235] },
  { name: "dark navy trousers", fg: [26, 35, 72] },
  { name: "white foreground", fg: [250, 250, 250] },
];

describe("no matte fringe after extraction", () => {
  it.each(SINGLE_COLOUR_CASES)("$name leaves no purple halo on any backdrop", async ({ fg }) => {
    const fixture = squareFixture(fg);
    const { rgba, size } = await extract(fixture);
    const halo = measureHalo(rgba, fixture);
    expect(halo.worstExcess, `worst at ${JSON.stringify(halo.worstAt)}`).toBeLessThanOrEqual(HALO_TOLERANCE);
    // And the artwork itself was not recoloured.
    expect(pixel(rgba, size, size / 2, size / 2)).toEqual([...fg, 255]);
  });

  it.each(SINGLE_COLOUR_CASES)("$name recovers the true foreground colour at the edge", async ({ fg }) => {
    const fixture = squareFixture(fg);
    const { rgba, size } = await extract(fixture);
    // The 75%-covered ring: RGB must be the unmixed foreground, not a blend.
    const edge = pixel(rgba, size, size / 2 + 19, size / 2);
    expect(fixture.coverage(size / 2 + 19, size / 2)).toBe(0.75);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(edge[channel] - fg[channel]), `channel ${channel} of ${edge}`).toBeLessThanOrEqual(4);
    }
    // Coverage is recovered too, so the edge is soft rather than fattened.
    expect(edge[3]).toBeGreaterThan(150);
    expect(edge[3]).toBeLessThan(230);
  });
});

// ─── 5: legitimate purple artwork must survive ─────────────────────────────

describe("legitimate purple artwork", () => {
  const PURPLE: Rgb = [150, 60, 190];

  it("keeps a purple object's colour instead of desaturating its edge", async () => {
    const fixture = squareFixture(PURPLE);
    const { rgba, size } = await extract(fixture);

    const interior = pixel(rgba, size, size / 2, size / 2);
    expect(interior).toEqual([...PURPLE, 255]);

    const edge = pixel(rgba, size, size / 2 + 19, size / 2);
    expect(fixture.coverage(size / 2 + 19, size / 2)).toBe(0.75);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(edge[channel] - PURPLE[channel])).toBeLessThanOrEqual(4);
    }
    /**
     * The regression this pins down: the previous spill suppressor rewrote this
     * pixel to [79,79,79], i.e. grey. Magenta-ness near zero would mean the
     * purple was destroyed to hide the halo.
     */
    expect(magentaness([edge[0], edge[1], edge[2]])).toBeGreaterThan(50);
  });

  it("cleans a purple object that touches a black silhouette", async () => {
    const size = 80;
    const centre = size / 2;
    // Black body on the left, purple prop on the right, sharing a silhouette.
    const fixture: Fixture = {
      size,
      coverage(x, y) {
        const d = Math.max(Math.abs(x + 0.5 - centre), Math.abs(y + 0.5 - centre));
        if (d <= 19) return 1;
        if (d <= 20) return 0.75;
        if (d <= 21) return 0.25;
        return 0;
      },
      color: (x) => (x >= centre ? PURPLE : [12, 12, 16]),
    };
    const { rgba, size: s } = await extract(fixture);

    const halo = measureHalo(rgba, fixture);
    expect(halo.worstExcess, `worst at ${JSON.stringify(halo.worstAt)}`).toBeLessThanOrEqual(HALO_TOLERANCE);
    // Each side kept its own colour: no bleeding between neighbours.
    expect(pixel(rgba, s, centre + 10, centre).slice(0, 3)).toEqual(PURPLE);
    expect(pixel(rgba, s, centre - 10, centre).slice(0, 3)).toEqual([12, 12, 16]);
  });
});

// ─── 6: thin manga line art ────────────────────────────────────────────────

describe("thin line art", () => {
  it("keeps a thick ink line clean and un-recoloured", async () => {
    const size = 64;
    const INK: Rgb = [10, 10, 12];
    // A 6px vertical bar with a 1px anti-aliased edge on each side.
    const fixture: Fixture = {
      size,
      coverage(x) {
        const d = Math.abs(x + 0.5 - size / 2);
        if (d <= 3) return 1;
        if (d <= 4) return 0.5;
        return 0;
      },
      color: () => INK,
    };
    const { rgba, size: s } = await extract(fixture);
    const halo = measureHalo(rgba, fixture);
    expect(halo.worstExcess, `worst at ${JSON.stringify(halo.worstAt)}`).toBeLessThanOrEqual(HALO_TOLERANCE);
    expect(pixel(rgba, s, s / 2, s / 2).slice(0, 3)).toEqual(INK);
  });
});

// ─── 7: a genuinely soft edge ──────────────────────────────────────────────

describe("soft anti-aliased edges", () => {
  it("recovers a wide gradient edge without a fringe", async () => {
    const size = 80;
    const centre = size / 2;
    const FG: Rgb = [40, 90, 160];
    const fixture: Fixture = {
      size,
      // A 5px soft falloff — far wider than typical anti-aliasing.
      coverage(x, y) {
        const d = Math.max(Math.abs(x + 0.5 - centre), Math.abs(y + 0.5 - centre));
        if (d <= 16) return 1;
        if (d >= 21) return 0;
        return 1 - (d - 16) / 5;
      },
      color: () => FG,
    };
    const { rgba } = await extract(fixture);
    const halo = measureHalo(rgba, fixture);
    expect(halo.worstExcess, `worst at ${JSON.stringify(halo.worstAt)}`).toBeLessThanOrEqual(HALO_TOLERANCE);
  });
});

// ─── The same mechanism on a white matte ───────────────────────────────────

describe("white matte", () => {
  it("removes the white halo dark artwork picks up on a white background", async () => {
    const INK: Rgb = [15, 15, 18];
    const fixture: Fixture = { ...squareFixture(INK), matte: WHITE };
    const { rgba, size } = await extract(fixture);

    // Over black, an un-decontaminated white matte shows a bright rim.
    const edge = pixel(rgba, size, size / 2 + 19, size / 2);
    const onBlack = composite(edge, [0, 0, 0]);
    const coverage = 0.75;
    const expectedLuma = coverage * INK[0];
    expect(onBlack[0]).toBeLessThanOrEqual(expectedLuma + 12);
    expect(pixel(rgba, size, size / 2, size / 2)).toEqual([...INK, 255]);
  });
});

// ─── Guardrails on the algorithm itself ────────────────────────────────────

describe("decontamination guardrails", () => {
  it("does not touch the interior of the subject", async () => {
    const FG: Rgb = [200, 40, 90];
    const fixture = squareFixture(FG);
    const { rgba, size } = await extract(fixture);
    // Every fully covered pixel is byte-identical to the source foreground.
    for (let y = size / 2 - 15; y <= size / 2 + 15; y += 5) {
      for (let x = size / 2 - 15; x <= size / 2 + 15; x += 5) {
        expect(pixel(rgba, size, x, y), `${x},${y}`).toEqual([...FG, 255]);
      }
    }
  });

  it("reports how much of the rim it actually recovered", async () => {
    const { builtInBackgroundRemovalProvider, estimateEdgeBackground } = await import("./backgroundRemoval");
    const fixture = squareFixture([12, 12, 16]);
    const png = await renderSource(fixture);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = estimateEdgeBackground(data, info.width, info.height)!;
    expect(background.kind).toBe("chroma-key");

    const output = await builtInBackgroundRemovalProvider.removeBackground({
      rgba: data,
      width: info.width,
      height: info.height,
      background,
    });
    expect(output.decontamination).toBeDefined();
    expect(output.decontamination!.recoveredPixels).toBeGreaterThan(0);
    // Only the rim is touched, never the bulk of the image.
    expect(output.decontamination!.recoveredPixels).toBeLessThan(info.width * info.height * 0.2);
  });
});
