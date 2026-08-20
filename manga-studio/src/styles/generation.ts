import type { ProjectDocument, SourceAsset, StyleProfile } from "@/domain/types";
import { getActiveStyleProfile } from "./profiles";

export interface StyleGenerationContext {
  profile: StyleProfile;
  referenceAsset?: SourceAsset;
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
