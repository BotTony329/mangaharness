import type { ProjectDocument, SourceAsset, StyleProfile } from "@/domain/types";
import { getActiveStyleProfile } from "./profiles";

export interface StyleGenerationContext {
  profile: StyleProfile;
  referenceAsset?: SourceAsset;
}

/**
 * Whether a style locks the project to black-and-white artwork.
 *
 * `colorMode` is deliberately free text (it is also injected into prompts), so
 * this matches the monochrome vocabulary the built-in profiles use:
 * "black-and-white", "ink monochrome", "near-monochrome".
 *
 * Two things depend on the answer: monochrome characters are generated on a
 * white background rather than a chroma key, and their results are checked for
 * colour contamination before entering the library.
 */
export function isMonochromeStyle(profile: Pick<StyleProfile, "visualProperties"> | undefined): boolean {
  const colorMode = profile?.visualProperties?.colorMode?.toLowerCase();
  if (!colorMode) return false;
  return colorMode.includes("black") || colorMode.includes("mono");
}

export function getStyleGenerationContext(doc: ProjectDocument): StyleGenerationContext {
  const profile = getActiveStyleProfile(doc);
  return {
    profile,
    referenceAsset: profile.referenceAssetId ? doc.assets[profile.referenceAssetId] : undefined,
  };
}

export function styleMetadata(context: StyleGenerationContext) {
  return {
    styleProfileId: context.profile.id,
    styleName: context.profile.name,
    stylePositivePrompt: context.profile.positivePrompt,
    styleNegativePrompt: context.profile.negativePrompt,
    styleReferenceAssetId: context.referenceAsset?.id,
  };
}
