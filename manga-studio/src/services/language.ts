"use client";

/**
 * LanguageService — manga-language visual assets (speed lines, sparkles,
 * impact flashes) land on TWO shelves: a SourceAsset carries the pixels, a
 * MangaLanguageAsset makes them findable by the creator and the Agent. Both
 * the Generator dialog ("accept" button) and the Agent's generate_manga_effect
 * tool go through `registerMangaEffectAsset` so the pair can never drift
 * apart.
 */

import { buildAssetPrompt } from "@/ai/promptTemplates";
import { generateImage, registerGeneratedAsset, type GenerateApiResult } from "@/services/generation";
import { assetRenderUrl } from "@/assets/renderSource";
import type { ID, MangaLanguageCategory, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";

const STOP_WORDS = new Set(["a", "an", "the", "with", "and", "of", "for", "in", "on", "style", "manga"]);

/**
 * Tags from a free-text description. The category is always included so a
 * "shock" search finds the asset even when the description used other words.
 */
export function effectTags(description: string, category: MangaLanguageCategory): string[] {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return [...new Set([category, ...words])].slice(0, 12);
}

/** Generate the pixels (preview stage in the dialog; immediate for the Agent). */
export async function generateMangaEffectImage(
  doc: ProjectDocument,
  description: string,
  category: MangaLanguageCategory,
): Promise<{ result: GenerateApiResult; prompt: string }> {
  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({
    assetType: "manga-effect",
    description,
    languageCategory: category,
    style: style.profile,
    // Project style governs generated language too, so a monochrome project
    // cannot acquire a full-colour sparkle.
    monochrome: isMonochromeStyle(style.profile),
  });
  const result = await generateImage({
    assetType: "manga-effect",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "square",
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls: style.referenceAsset ? [assetRenderUrl(style.referenceAsset)!] : undefined,
  });
  return { result, prompt };
}

/** Register generated pixels as SourceAsset + MangaLanguageAsset pair. */
export async function registerMangaEffectAsset(input: {
  result: GenerateApiResult;
  prompt: string;
  description: string;
  category: MangaLanguageCategory;
  name?: string;
}): Promise<{ assetId: ID; languageAssetId: ID; name: string }> {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No project is open");
  const style = getStyleGenerationContext(doc);
  const name = input.name ?? (input.description.slice(0, 40) || "Manga effect");
  const assetId = await registerGeneratedAsset({
    result: input.result,
    assetType: "manga-effect",
    category: "prop",
    name,
    prompt: input.prompt,
    metadata: styleMetadata(style),
  });
  const created = useEditorStore.getState().dispatch({
    type: "add-language-asset",
    input: {
      category: input.category,
      name,
      source: "ai-generated",
      format: "visual",
      assetId,
      tags: effectTags(input.description, input.category),
      generationMetadata: { prompt: input.prompt, styleProfileId: style.profile.id, createdAt: new Date().toISOString() },
    },
  });
  if (!created.createdId) throw new Error("Generated effect could not be registered in the library");
  return { assetId, languageAssetId: created.createdId, name };
}
