/**
 * Monochrome manga characters on a pure white background.
 *
 * White is the preferred generation background for black-and-white line art
 * because a chroma-key screen spills onto hair and silhouette edges and the
 * model bakes that tint into the artwork. White cannot tint anything — but it
 * is only safe because extraction is connectivity-based. Every assertion below
 * about eye whites, white clothing, and hair highlights is really an assertion
 * that the flood never reaches enclosed regions.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processAssetImage } from "./postProcessor";
import { detectColorContamination, COLOR_CONTAMINATION_MESSAGE } from "./colorContamination";
import { selectBackgroundStrategy } from "@/ai/promptTemplates";

const W = 160;
const H = 220;
type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [12, 12, 14];
const NEAR_WHITE: Rgb = [245, 245, 245];
const MID_GREY: Rgb = [200, 200, 200];

/** Landmarks the assertions probe, so fixture and expectations cannot drift. */
const P = {
  exteriorCorner: [2, 2] as const,
  exteriorMid: [W - 3, 140] as const,
  face: [80, 92] as const,
  hairMass: [80, 40] as const,
  hairHighlight: [75, 39] as const,
  eyeWhiteLeft: [63, 78] as const,
  eyeWhiteRight: [97, 78] as const,
  pupilLeft: [66, 78] as const,
  shirt: [80, 160] as const,
  shirtOutline: [53, 160] as const,
  thinStrandLeft: [44, 80] as const,
  thinStrandRight: [116, 80] as const,
  aaNearWhite: [49, 160] as const,
  aaMidGrey: [50, 160] as const,
};

function paint(tint?: { color: Rgb; region: (x: number, y: number) => boolean }): Buffer {
  const buf = Buffer.alloc(W * H * 4);
  const put = (x: number, y: number, c: Rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
    buf[o + 3] = 255;
  };

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, WHITE);

  // ── head: ink ring enclosing a white face ──
  for (let y = 24; y < 116; y++)
    for (let x = 42; x < 118; x++) {
      const dx = (x - 80) / 34;
      const dy = (y - 70) / 44;
      const r = dx * dx + dy * dy;
      if (r <= 1) put(x, y, r > 0.86 ? INK : WHITE);
    }
  // hair mass covers the upper skull
  for (let y = 24; y < 62; y++)
    for (let x = 42; x < 118; x++) {
      const dx = (x - 80) / 34;
      const dy = (y - 70) / 44;
      if (dx * dx + dy * dy <= 1) put(x, y, INK);
    }
  // white hair highlight, fully enclosed by the hair mass
  for (let y = 34; y < 45; y++) for (let x = 70; x < 82; x++) put(x, y, WHITE);

  // ── eyes: ink ring, white sclera, black pupil ──
  for (const cx of [66, 94]) {
    for (let y = 68; y < 89; y++)
      for (let x = cx - 11; x <= cx + 11; x++) {
        const d = Math.hypot(x - cx, y - 78);
        if (d <= 10) put(x, y, d > 8 ? INK : WHITE);
        if (d <= 4) put(x, y, INK);
      }
  }

  // ── neck + torso: ink outline enclosing a white shirt ──
  for (let y = 104; y < 120; y++) for (let x = 72; x < 89; x++) put(x, y, x < 75 || x > 85 ? INK : WHITE);
  for (let y = 116; y < 205; y++)
    for (let x = 52; x < 109; x++) {
      const edge = x < 55 || x > 105 || y < 119 || y > 201;
      put(x, y, edge ? INK : WHITE);
    }
  // anti-aliased ramp on the torso's left edge
  for (let y = 116; y < 205; y++) {
    put(50, y, MID_GREY);
    put(49, y, NEAR_WHITE);
  }

  // ── thin hair strands: 1px ink, isolated in the background ──
  for (let y = 60; y < 104; y++) {
    put(44, y, INK);
    put(116, y, INK);
  }

  if (tint) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (tint.region(x, y)) put(x, y, tint.color);
  }
  return buf;
}

const encode = (buf: Buffer) => sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

async function decode(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const alphaAt = (r: { data: Buffer; width: number }, [x, y]: readonly [number, number]) =>
  r.data[(y * r.width + x) * 4 + 3];

async function extract(buf: Buffer, expectMonochrome = true) {
  return processAssetImage(await encode(buf), "character", { expectMonochrome });
}

describe("monochrome character on a pure white background", () => {
  it("prefers the white background strategy for monochrome, chroma key otherwise", () => {
    expect(selectBackgroundStrategy({ monochrome: true })).toBe("white");
    expect(selectBackgroundStrategy({ monochrome: false })).toBe("chroma-key");
    // Native alpha always wins when the provider genuinely supports it.
    expect(selectBackgroundStrategy({ monochrome: true, supportsNativeTransparency: true })).toBe("native-alpha");
    expect(selectBackgroundStrategy({ monochrome: false, supportsNativeTransparency: true })).toBe("native-alpha");
  });

  it("removes the exterior white background", async () => {
    const result = await extract(paint());
    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
    expect(result.backgroundRemoved).toBe(true);

    const out = await decode(result.processedData!);
    expect(alphaAt(out, P.exteriorCorner)).toBe(0);
    expect(alphaAt(out, P.exteriorMid)).toBe(0);
  });

  it("keeps a black hair mass opaque", async () => {
    const out = await decode((await extract(paint())).processedData!);
    expect(alphaAt(out, P.hairMass)).toBe(255);
  });

  it("keeps white clothing on a white background", async () => {
    const out = await decode((await extract(paint())).processedData!);
    // Pure white, identical to the background colour — only enclosure saves it.
    expect(alphaAt(out, P.shirt)).toBe(255);
    expect(alphaAt(out, P.shirtOutline)).toBe(255);
  });

  it("keeps enclosed white eye regions and their pupils", async () => {
    const out = await decode((await extract(paint())).processedData!);
    expect(alphaAt(out, P.eyeWhiteLeft)).toBe(255);
    expect(alphaAt(out, P.eyeWhiteRight)).toBe(255);
    expect(alphaAt(out, P.pupilLeft)).toBe(255);
  });

  it("keeps white hair highlights enclosed in the hair mass", async () => {
    const out = await decode((await extract(paint())).processedData!);
    expect(alphaAt(out, P.hairHighlight)).toBe(255);
  });

  it("keeps the white face interior", async () => {
    const out = await decode((await extract(paint())).processedData!);
    expect(alphaAt(out, P.face)).toBe(255);
  });

  it("keeps thin black hair strands standing in open background", async () => {
    const out = await decode((await extract(paint())).processedData!);
    // One pixel wide, surrounded by background on both sides.
    expect(alphaAt(out, P.thinStrandLeft)).toBe(255);
    expect(alphaAt(out, P.thinStrandRight)).toBe(255);
  });

  it("treats near-white anti-aliasing as background and mid-grey as artwork", async () => {
    const out = await decode((await extract(paint())).processedData!);
    expect(alphaAt(out, P.aaNearWhite)).toBe(0);
    expect(alphaAt(out, P.aaMidGrey)).toBeGreaterThan(0);
  });

  it("produces a substantial transparent region without erasing the figure", async () => {
    const result = await extract(paint());
    const out = await decode(result.processedData!);
    let transparent = 0;
    let opaque = 0;
    for (let p = 0; p < W * H; p++) {
      const a = out.data[p * 4 + 3];
      if (a < 16) transparent++;
      if (a > 239) opaque++;
    }
    expect(transparent / (W * H)).toBeGreaterThan(0.4);
    expect(opaque / (W * H)).toBeGreaterThan(0.1);
  });
});

describe("colour contamination", () => {
  const halo = (color: Rgb) => ({
    color,
    // A ring hugging the hair silhouette — where key spill actually lands.
    region: (x: number, y: number) => {
      const dx = (x - 80) / 34;
      const dy = (y - 70) / 44;
      const r = dx * dx + dy * dy;
      return r > 1 && r < 1.32 && y < 74;
    },
  });

  it("accepts a clean monochrome character", async () => {
    const result = await extract(paint());
    expect(result.processingStatus).toBe("ready");
    const report = detectColorContamination(
      (await decode(result.processedData!)).data,
      W,
      H,
    );
    expect(report.contaminated).toBe(false);
  });

  it("refuses a magenta halo", async () => {
    const result = await extract(paint(halo([236, 64, 220])));
    expect(result.processingStatus).toBe("failed");
    expect(result.reason).toContain(COLOR_CONTAMINATION_MESSAGE);
    expect(result.processedData).toBeUndefined();
  });

  it("refuses a purple halo", async () => {
    const result = await extract(paint(halo([132, 60, 196])));
    expect(result.processingStatus).toBe("failed");
    expect(result.reason).toContain(COLOR_CONTAMINATION_MESSAGE);
  });

  it("does not apply the check when the project style is not monochrome", async () => {
    const result = await extract(paint(halo([236, 64, 220])), false);
    expect(result.processingStatus).toBe("ready");
    expect(result.hasAlpha).toBe(true);
  });

  it("ignores anti-aliasing noise rather than flagging it", async () => {
    // A sparse scatter of faintly tinted pixels, as JPEG ringing produces.
    const buf = paint();
    for (let i = 0; i < 400; i++) {
      const x = 60 + (i % 40);
      const y = 130 + Math.floor(i / 40);
      const o = (y * W + x) * 4;
      buf[o] = 255;
      buf[o + 1] = 244;
      buf[o + 2] = 250;
    }
    const report = detectColorContamination(buf, W, H);
    expect(report.contaminated).toBe(false);
  });
});

describe("monochrome character composited over a detailed background", () => {
  it("shows the background through every transparent pixel and adds no colour", async () => {
    const result = await extract(paint());
    const character = result.processedData!;

    const backdrop = await sharp(
      Buffer.from(
        Buffer.alloc(W * H * 4).map((_, i) => {
          const p = Math.floor(i / 4);
          const x = p % W;
          const y = Math.floor(p / W);
          if (i % 4 === 3) return 255;
          // A busy manga street: hatching, tone, and structure.
          const hatch = (x + y) % 9 < 2 ? 30 : 210;
          const tone = (x % 6 < 3 ? 0 : 25) + (y % 40 < 20 ? 0 : 18);
          return Math.max(0, Math.min(255, hatch - tone));
        }),
      ),
      { raw: { width: W, height: H, channels: 4 } },
    )
      .png()
      .toBuffer();

    const composite = await sharp(backdrop).composite([{ input: character }]).png().toBuffer();
    const back = await decode(backdrop);
    const over = await decode(composite);
    const cut = await decode(character);

    let showedThrough = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (cut.data[o + 3] !== 0) continue;
        showedThrough++;
        expect(over.data[o]).toBe(back.data[o]);
        expect(over.data[o + 1]).toBe(back.data[o + 1]);
        expect(over.data[o + 2]).toBe(back.data[o + 2]);
      }
    expect(showedThrough).toBeGreaterThan(W * H * 0.4);

    // The character contributes no colour: every pixel it covers stays neutral.
    const contamination = detectColorContamination(cut.data, W, H);
    expect(contamination.contaminated).toBe(false);
    expect(contamination.saturatedPixels).toBe(0);
  });
});
