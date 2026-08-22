"use client";

/**
 * ToneService — the ONE Tone capability boundary.
 *
 * Manual UI ("Generate Tone") and Agent V3 ("apply daylight tone") are just
 * two callers. Neither knows provider request shapes, registration details,
 * or fallback categories: generate → register → resolve all live here, on
 * top of the single tone registry (domain/tones.ts presets + tones/mood.ts
 * mood vocabulary) and the document's tone-category assets.
 *
 * Domain rule: Tone is Tone. The provider renders it as an image; the
 * transparency contract (native alpha for atmosphere/decorative, opaque
 * field for texture/pattern) is owned by the server generation route.
 */

import { buildAssetPrompt } from "@/ai/promptTemplates";
import { generateImage, registerGeneratedAsset, type GenerateApiResult } from "@/services/generation";
import { assetRenderUrl } from "@/assets/renderSource";
import { tonePreset, TONE_PRESETS } from "@/domain/tones";
import { toneForMood } from "@/tones/mood";
import type { ID, ProjectDocument, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";

export type ToneType = "texture" | "atmosphere" | "decorative" | "pattern";

export interface ToneGenerationIntent {
  description: string;
  toneType: ToneType;
  tileable: boolean;
  name?: string;
}

/** Generate tone pixels through the shared generation route. */
export async function generateTone(
  doc: ProjectDocument,
  intent: ToneGenerationIntent,
): Promise<{ result: GenerateApiResult; prompt: string }> {
  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({
    assetType: "tone",
    description: intent.description,
    toneType: intent.toneType,
    tileable: intent.tileable,
    style: style.profile,
    monochrome: isMonochromeStyle(style.profile),
  });
  const result = await generateImage({
    assetType: "tone",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "square",
    expectMonochrome: isMonochromeStyle(style.profile),
    toneType: intent.toneType,
    tileable: intent.tileable,
    referenceUrls: style.referenceAsset ? [assetRenderUrl(style.referenceAsset)!] : undefined,
  });
  return { result, prompt };
}

/** Register generated pixels on the Tones shelf (category "tone"). */
export async function registerTone(input: {
  result: GenerateApiResult;
  prompt: string;
  intent: ToneGenerationIntent;
}): Promise<{ assetId: ID; name: string }> {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No project is open");
  const style = getStyleGenerationContext(doc);
  const name = input.intent.name ?? (input.intent.description.slice(0, 40) || "Tone");
  const assetId = await registerGeneratedAsset({
    result: input.result,
    assetType: "tone",
    category: "tone",
    name,
    prompt: input.prompt,
    metadata: {
      toneType: input.intent.toneType,
      tileable: input.intent.tileable,
      ...styleMetadata(style),
    },
  });
  return { assetId, name };
}

/** Generate AND register in one call — the full Tone capability. */
export async function ensureToneGenerated(intent: ToneGenerationIntent): Promise<{ assetId: ID; name: string }> {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No project is open");
  const { result, prompt } = await generateTone(doc, intent);
  return registerTone({ result, prompt, intent });
}

/** A library tone asset by name (case-insensitive, exact or contained). */
export function findLibraryTone(doc: ProjectDocument, name: string): SourceAsset | undefined {
  const wanted = name.trim().toLowerCase();
  const tones = Object.values(doc.assets).filter((a) => a.category === "tone");
  return (
    tones.find((a) => a.name.trim().toLowerCase() === wanted) ??
    tones.find((a) => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase()))
  );
}

export type ResolvedTone =
  | { kind: "preset"; presetId: string }
  | { kind: "asset"; assetId: ID };

/**
 * Resolution order, shared by Manual UI and the Agent:
 *   1. exact built-in preset (id or name)
 *   2. library tone asset by name
 *   3. mood vocabulary → built-in preset
 *   4. undefined — the caller decides GENERATE or skip, never a fake match
 */
export function resolveToneIntent(
  doc: ProjectDocument,
  intent: { name?: string; mood?: string },
): ResolvedTone | undefined {
  const text = intent.name ?? intent.mood;
  if (!text) return undefined;
  const wanted = text.trim().toLowerCase();
  if (tonePreset(wanted)) return { kind: "preset", presetId: wanted };
  const presetByName = TONE_PRESETS.find((p) => p.name.toLowerCase() === wanted);
  if (presetByName) return { kind: "preset", presetId: presetByName.id };
  const asset = findLibraryTone(doc, text);
  if (asset) return { kind: "asset", assetId: asset.id };
  const fromMood = toneForMood(text);
  if (fromMood) return { kind: "preset", presetId: fromMood.id };
  return undefined;
}
