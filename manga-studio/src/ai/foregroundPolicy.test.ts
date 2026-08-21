/**
 * The pure-white foreground contract.
 *
 * The purple fringe kept coming back because coloured artwork was deliberately
 * generated on a magenta screen: the contamination was created at generation
 * time, and every extraction path then had to be taught to undo it. Not
 * introducing the matte is what makes the halo impossible rather than merely
 * recoverable.
 *
 * These tests sweep EVERY foreground prompt template, so the policy cannot be
 * defeated by editing one template in isolation.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  FORBIDDEN_BACKDROP_TERMS,
  backgroundClause,
  foregroundAssetPolicy,
  requestsColouredMatte,
} from "./foregroundPolicy";
import { buildAssetPrompt, buildCharacterStatePrompt } from "./promptTemplates";
import { validateWhiteBackground } from "@/assets/backgroundRemoval";
import { processAssetImage } from "@/assets/postProcessor";

// ─── The policy itself ─────────────────────────────────────────────────────

describe("foreground asset policy", () => {
  it("puts colour and monochrome on the same white backdrop", () => {
    expect(foregroundAssetPolicy({}).background).toBe("pure-white");
    expect(foregroundAssetPolicy({ supportsNativeTransparency: false }).background).toBe("pure-white");
  });

  it("prefers a provider's real alpha, which needs no matte at all", () => {
    const policy = foregroundAssetPolicy({ supportsNativeTransparency: true });
    expect(policy.background).toBe("native-alpha");
    expect(policy.extraction).toBe("provider-alpha");
  });

  it("always requires validation before an asset is registered", () => {
    expect(foregroundAssetPolicy({}).validation).toBe("required");
    expect(foregroundAssetPolicy({ supportsNativeTransparency: true }).validation).toBe("required");
  });

  it("names the prohibition alongside the positive instruction", () => {
    const clause = backgroundClause(foregroundAssetPolicy({}), "character");
    expect(clause).toContain("#FFFFFF");
    expect(clause.toLowerCase()).toContain("no coloured rim light");
    expect(clause).toContain("clean separation");
    expect(requestsColouredMatte(clause)).toBe(false);
  });
});

// ─── Every foreground prompt, swept ────────────────────────────────────────

/** Every prompt shape that produces an asset requiring extraction. */
const FOREGROUND_PROMPTS: { name: string; build: (monochrome: boolean) => string }[] = [
  {
    name: "character reference",
    build: (monochrome) => buildAssetPrompt({ assetType: "character", characterName: "Yuri", monochrome }),
  },
  {
    name: "character pose",
    build: (monochrome) => buildAssetPrompt({ assetType: "character-pose", characterName: "Yuri", pose: "running", monochrome }),
  },
  {
    name: "character expression",
    build: (monochrome) =>
      buildAssetPrompt({ assetType: "character-expression", characterName: "Yuri", expression: "shocked", monochrome }),
  },
  {
    name: "prop",
    build: (monochrome) => buildAssetPrompt({ assetType: "prop", description: "school bag", monochrome }),
  },
  {
    name: "manga effect",
    build: (monochrome) =>
      buildAssetPrompt({ assetType: "manga-effect", description: "shock mark", languageCategory: "emotion", monochrome }),
  },
  {
    name: "character state",
    build: (monochrome) => buildCharacterStatePrompt({ characterName: "Yuri", pose: "walking", monochrome }),
  },
];

describe("no foreground prompt requests a coloured matte", () => {
  for (const { name, build } of FOREGROUND_PROMPTS) {
    for (const monochrome of [false, true]) {
      it(`${name} (${monochrome ? "monochrome" : "colour"})`, () => {
        const prompt = build(monochrome);
        expect(requestsColouredMatte(prompt), prompt).toBe(false);
        for (const term of FORBIDDEN_BACKDROP_TERMS) {
          expect(prompt.toLowerCase(), term).not.toContain(term);
        }
        // And it positively asks for white.
        expect(prompt).toContain("#FFFFFF");
      });
    }
  }

  it("still asks for real alpha when the provider can emit it", () => {
    const prompt = buildAssetPrompt({ assetType: "character", supportsNativeTransparency: true });
    expect(prompt).toContain("real alpha channel");
    expect(requestsColouredMatte(prompt)).toBe(false);
  });

  it("does not apply the isolation clause to backgrounds", () => {
    // A background is a full-frame image; isolating it on white would be wrong.
    const prompt = buildAssetPrompt({ assetType: "background", description: "cyberpunk street" });
    expect(prompt).not.toContain("#FFFFFF");
  });
});

// ─── Validation of what the provider actually returned ─────────────────────

type Rgb = [number, number, number];

async function backdrop(color: Rgb | "gradient" | "noise"): Promise<{ data: Buffer; w: number; h: number }> {
  const w = 64;
  const h = 64;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let c: Rgb;
      if (color === "gradient") c = [255 - y * 2, 255 - y * 2, 255];
      // A genuinely textured backdrop. Mild noise is deliberately NOT rejected:
      // variation the flood's own tolerance can absorb is cleanly removable, so
      // failing it would block a usable render for no benefit.
      else if (color === "noise") c = [120 + ((x * 37 + y * 53) % 135), 130 + ((x * 29) % 120), 140 + ((y * 41) % 110)];
      else c = color;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  // A dark subject in the middle, so the border is what gets measured.
  for (let y = 20; y < 44; y += 1) {
    for (let x = 20; x < 44; x += 1) {
      const o = (y * w + x) * 4;
      rgba[o] = 20;
      rgba[o + 1] = 20;
      rgba[o + 2] = 26;
    }
  }
  return { data: rgba, w, h };
}

describe("white background validation", () => {
  it("accepts pure white and slightly off-white paper", async () => {
    for (const white of [[255, 255, 255], [250, 249, 252], [244, 244, 240]] as Rgb[]) {
      const { data, w, h } = await backdrop(white);
      expect(validateWhiteBackground(data, w, h).valid, `${white}`).toBe(true);
    }
  });

  it("rejects the magenta matte that caused the fringe, and names it", async () => {
    const { data, w, h } = await backdrop([255, 0, 255]);
    const verdict = validateWhiteBackground(data, w, h);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("purple/magenta");
    expect(verdict.measured).toEqual([255, 0, 255]);
  });

  it.each([
    ["green screen", [0, 200, 60] as Rgb],
    ["blue screen", [30, 60, 220] as Rgb],
    ["grey", [128, 128, 128] as Rgb],
  ])("rejects a %s backdrop", async (_name, color) => {
    const { data, w, h } = await backdrop(color);
    expect(validateWhiteBackground(data, w, h).valid).toBe(false);
  });

  it("rejects a gradient or textured backdrop", async () => {
    for (const kind of ["gradient", "noise"] as const) {
      const { data, w, h } = await backdrop(kind);
      expect(validateWhiteBackground(data, w, h).valid, kind).toBe(false);
    }
  });

  it("refuses to extract when the provider ignored the contract", async () => {
    const { data, w, h } = await backdrop([255, 0, 255]);
    const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

    const enforced = await processAssetImage(png, "character", { requireWhiteBackground: true });
    expect(enforced.processingStatus).toBe("failed");
    expect(enforced.reason).toContain("purple/magenta");

    /**
     * Repair and upload deliberately skip the gate: rebuilding a pre-policy
     * asset means re-extracting the very magenta matte it was generated with.
     */
    const legacy = await processAssetImage(png, "character", {});
    expect(legacy.processingStatus).toBe("ready");
  });
});
