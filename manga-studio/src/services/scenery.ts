"use client";

/**
 * SceneryService — backgrounds ("Scene") and props ("Object") share one
 * category-parameterised pipeline, mirroring how the codebase models them
 * (AssetCategory "background" | "prop", one executor handler, one Generator
 * dialog type union).
 *
 * The Agent path uses `generateSceneryAsset` (generate → register, one call).
 * The Generator dialog uses the same primitives but splits them around its
 * preview-then-accept UX: `buildSceneryRequest` for the request, then
 * generateImage / registerGeneratedAsset from GenerationService on accept.
 */

import { buildAssetPrompt, defaultAspect } from "@/ai/promptTemplates";
import { generateImage, registerGeneratedAsset, type GenerateImageRequest } from "@/services/generation";
import { assetRenderUrl } from "@/assets/renderSource";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";

export type SceneryCategory = "background" | "prop";

/** Assemble the generation request for a scene/object from the project style. */
export function buildSceneryRequest(
  doc: ProjectDocument,
  category: SceneryCategory,
  description: string,
): GenerateImageRequest & { prompt: string } {
  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({
    assetType: category,
    description,
    style: style.profile,
    monochrome: isMonochromeStyle(style.profile),
  });
  return {
    assetType: category,
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: defaultAspect(category),
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls: style.referenceAsset ? [assetRenderUrl(style.referenceAsset)!] : undefined,
  };
}

/** Generate a scene/object and register it in the library. Returns asset id. */
export async function generateSceneryAsset(input: {
  category: SceneryCategory;
  description: string;
  name?: string;
}): Promise<ID> {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No project is open");
  const { prompt, ...rest } = buildSceneryRequest(doc, input.category, input.description);
  const result = await generateImage({ ...rest, prompt });
  return registerGeneratedAsset({
    result,
    assetType: input.category,
    category: input.category,
    name: input.name ?? input.description.slice(0, 40),
    prompt,
    metadata: styleMetadata(getStyleGenerationContext(doc)),
  });
}
