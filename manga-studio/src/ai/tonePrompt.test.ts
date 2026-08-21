/**
 * What a generated tone is ASKED to be (§10).
 *
 * A tone is an overlay, not a picture. Anything representational — a horizon, a
 * character, a frame — stops working the instant it is laid over someone's
 * face, so the contract is tested rather than trusted to prompt wording that
 * might drift. The provider call itself needs a credential and is not covered.
 */

import { describe, expect, it } from "vitest";
import { buildAssetPrompt, defaultAspect } from "./promptTemplates";

const build = (extra: Parameters<typeof buildAssetPrompt>[0]) => buildAssetPrompt(extra).toLowerCase();

describe("tone generation contract", () => {
  it("asks for a manga screentone overlay, not a scene", () => {
    const prompt = build({ assetType: "tone", description: "dark psychological manga hatching", toneType: "texture" });
    expect(prompt).toContain("screentone");
    expect(prompt).toContain("dark psychological manga hatching");
    // The failure this prevents: a tone with a horizon baked into it.
    expect(prompt).toContain("no scene");
    expect(prompt).toContain("no characters");
    expect(prompt).toContain("no frame");
    expect(prompt).toContain("no text");
  });

  it("states the kind of tone in manga vocabulary", () => {
    expect(build({ assetType: "tone", description: "gloom", toneType: "atmosphere" })).toContain("atmosphere overlay");
    expect(build({ assetType: "tone", description: "flowers", toneType: "decorative" })).toContain("decorative screentone");
    expect(build({ assetType: "tone", description: "hatch", toneType: "pattern" })).toContain("pattern tile");
  });

  it("demands a seamless repeat only when the tone will be tiled", () => {
    const tiled = build({ assetType: "tone", description: "rain", tileable: true });
    expect(tiled).toContain("seamlessly tileable");
    expect(tiled).toContain("no visible seam");

    const single = build({ assetType: "tone", description: "rain", tileable: false });
    expect(single).not.toContain("seamlessly tileable");
  });

  it("rides the existing white-background policy rather than a tone-only pipeline", () => {
    // Same background contract as every other foreground asset, so the existing
    // transparency extraction turns the result into a usable overlay.
    const tone = build({ assetType: "tone", description: "rain", supportsNativeTransparency: false });
    const prop = build({ assetType: "prop", description: "school bag", supportsNativeTransparency: false });
    const clause = /(white background|transparent|alpha)/;
    expect(clause.test(tone)).toBe(true);
    expect(clause.test(prop)).toBe(true);
  });

  it("inherits project art direction like every other generated asset", () => {
    const prompt = build({
      assetType: "tone",
      description: "rain",
      style: { name: "Minimal Line Manga", positivePrompt: "minimal black-and-white manga drawing", visualProperties: {} },
    });
    expect(prompt).toContain("minimal line manga");
  });

  it("generates square, because a portrait tile repeats with visible seams", () => {
    expect(defaultAspect("tone")).toBe("square");
  });
});
