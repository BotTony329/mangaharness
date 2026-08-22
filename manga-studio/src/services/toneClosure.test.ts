/**
 * Golden: TONE GENERATION CLOSURE.
 *
 * Manual UI and Agent V3 are two callers of ONE Tone capability
 * (services/tones.ts) over ONE registry (domain/tones presets + tone-category
 * library assets + tones/mood vocabulary). The live failure — "Invalid
 * generation request" for a decorative "A soft daylight" — was the server
 * schema lacking assetType "tone"; these tests pin the whole closed loop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { generateRequestSchema } from "@/ai/generate";
import { buildAssetPrompt } from "@/ai/promptTemplates";
import { ensureToneGenerated, findLibraryTone, resolveToneIntent, registerTone, generateTone } from "@/services/tones";
import { tonePreset } from "@/domain/tones";

class MockImage {
  naturalWidth = 900;
  naturalHeight = 1400;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    this.onload?.();
  }
}

let generationCalls = 0;

function toneImageResponse() {
  return new Response(
    JSON.stringify({
      url: "https://example.com/tone.png",
      sourceUrl: "https://example.com/tone.png",
      processedImageUrl: "https://example.com/tone-p.png",
      mimeType: "image/png",
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      provider: "test-provider",
      model: "test-model",
      referenceUsed: false,
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  useEditorStore.getState().loadDocument(createProjectDocument("Tone closure"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  generationCalls = 0;
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate")) {
      generationCalls += 1;
      return toneImageResponse();
    }
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

const doc = () => useEditorStore.getState().doc!;
const toneItems = () => Object.values(doc().items).filter((i) => i.kind === "tone");

describe("tone generation closure", () => {
  it("CASE 1: decorative 'A soft daylight' — request valid, tone registered, visible to the shelf", async () => {
    // The live bug: the server schema rejected assetType "tone".
    const parsed = generateRequestSchema.safeParse({
      assetType: "tone",
      prompt: buildAssetPrompt({ assetType: "tone", description: "A soft daylight", toneType: "decorative", tileable: false }),
      size: "square",
      toneType: "decorative",
      tileable: false,
    });
    expect(parsed.success).toBe(true);

    const { assetId, name } = await ensureToneGenerated({ description: "A soft daylight", toneType: "decorative", tileable: false });
    expect(generationCalls).toBe(1);
    const asset = doc().assets[assetId];
    expect(asset.category).toBe("tone");
    expect(asset.metadata?.toneType).toBe("decorative");
    // The shelf lookup is the SAME function the Agent reuses.
    expect(findLibraryTone(doc(), name)?.id).toBe(assetId);
  });

  it("CASE 2: pattern 'small romantic stars' tileable — canonical prompt says seamless", () => {
    const prompt = buildAssetPrompt({ assetType: "tone", description: "small romantic stars", toneType: "pattern", tileable: true });
    expect(prompt).toMatch(/[Ss]eamless/);
    expect(prompt).toContain("small romantic stars");
    expect(generateRequestSchema.safeParse({ assetType: "tone", prompt, toneType: "pattern", tileable: true }).success).toBe(true);
  });

  it("CASE 3: atmosphere 'gloomy rainy night' goes through the Tone capability, not background", async () => {
    const { result, prompt } = await generateTone(doc(), { description: "gloomy rainy night", toneType: "atmosphere", tileable: true });
    expect(prompt).toContain("atmosphere overlay");
    expect(result.processingStatus).toBe("ready");
    const { assetId } = await registerTone({ result, prompt, intent: { description: "gloomy rainy night", toneType: "atmosphere", tileable: true } });
    expect(doc().assets[assetId].category).toBe("tone");
  });

  it("CASE 4: Agent reuse — library has Daylight, 'apply daylight tone' generates NOTHING", async () => {
    await ensureToneGenerated({ description: "Daylight", toneType: "decorative", tileable: false });
    const callsBefore = generationCalls;

    const summary = await executePlan(
      { summary: "tone", steps: [{ tool: "apply_tone", args: { panel: 1, mood: "daylight" } }] },
      () => {},
    );
    expect(summary.status).toBe("completed");
    expect(generationCalls).toBe(callsBefore);
    expect(toneItems().length).toBe(1);
  });

  it("CASE 5: Agent generate — no daylight in library → GENERATE + register + apply", async () => {
    const summary = await executePlan(
      { summary: "tone", steps: [{ tool: "apply_tone", args: { panel: 1, mood: "peach evening haze" } }] },
      () => {},
    );
    expect(summary.status).toBe("completed");
    expect(generationCalls).toBe(1);
    expect(Object.values(doc().assets).some((a) => a.category === "tone")).toBe(true);
    expect(toneItems().length).toBe(1);
  });

  it("CASE 6: cross-entry reuse — manual-generated tone is agent-reusable and vice versa", async () => {
    // Manual → Agent
    const manual = await ensureToneGenerated({ description: "Golden hour", toneType: "decorative", tileable: false });
    expect(resolveToneIntent(doc(), { name: "Golden hour" })).toEqual({ kind: "asset", assetId: manual.assetId });
    // Agent → Manual: an agent-generated tone is visible to the shelf lookup.
    const summary = await executePlan(
      { summary: "tone", steps: [{ tool: "apply_tone", args: { panel: 2, mood: "summer haze" } }] },
      () => {},
    );
    expect(summary.status).toBe("completed");
    expect(Object.values(doc().assets).filter((a) => a.category === "tone").length).toBe(2);
  });

  it("CASE 7: failed generation leaves no half-registered tone and no page pollution", async () => {
    vi.stubGlobal("fetch", async () => new Response("provider down", { status: 500 }));
    const assetsBefore = Object.keys(doc().assets).length;
    const summary = await executePlan(
      { summary: "tone", steps: [{ tool: "apply_tone", args: { panel: 1, mood: "impossible glimmer" } }] },
      () => {},
    );
    // apply_tone is noncritical: the run does not die; nothing is registered.
    expect(summary.rolledBack).toBe(false);
    expect(Object.keys(doc().assets).length).toBe(assetsBefore);
    expect(toneItems().length).toBe(0);
  });

  it("CASE 8: transparency contract — tone never masquerades as prop", async () => {
    const { assetId } = await ensureToneGenerated({ description: "linen texture", toneType: "texture", tileable: true });
    const asset = doc().assets[assetId];
    expect(asset.category).toBe("tone");
    expect(asset.category).not.toBe("prop");
    // Tone is not in the cutout-extraction contract.
    const { requiresTransparency } = await import("@/assets/characterAssetContract");
    expect(requiresTransparency("tone")).toBe(false);
  });

  it("CASE 9: built-in presets keep working through the same resolver", () => {
    expect(resolveToneIntent(doc(), { mood: "gloom" })).toEqual({ kind: "preset", presetId: "gloom" });
    expect(resolveToneIntent(doc(), { name: "Dot 30%" })).toEqual({ kind: "preset", presetId: "dot-30" });
    expect(tonePreset("dot-30")).toBeDefined();
  });

  it("CASE 10: regression — character/background/prop/manga-effect requests still validate", () => {
    for (const assetType of ["character", "character-pose", "character-expression", "background", "prop", "manga-effect"] as const) {
      expect(generateRequestSchema.safeParse({ assetType, prompt: "a valid prompt" }).success, assetType).toBe(true);
    }
    // And unknown types are still rejected.
    expect(generateRequestSchema.safeParse({ assetType: "hologram", prompt: "nope nope" }).success).toBe(false);
  });
});
