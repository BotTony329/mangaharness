/**
 * The character-asset contract.
 *
 * A RawGeneratedImage and a CleanCharacterAsset are not interchangeable. Only
 * an image that has passed transparency validation may enter the library, be
 * placed on the canvas, or be exported. Anything else is a raw source that can
 * be retried — never a layer.
 *
 *   RawGeneratedImage → extraction → validateCharacterTransparency → CleanCharacterAsset
 *
 * Pixel-level validation (alpha present, a meaningful transparent region, a
 * non-empty foreground, a plausible bounding box) runs server-side in
 * postProcessor.validateProcessedAlpha, where the decoded bitmap lives. This
 * module enforces the resulting envelope everywhere else, so a failed
 * extraction cannot slip through by way of a status flag nobody checked.
 */

import type { AssetCategory, SourceAsset } from "@/domain/types";

/** Categories composited as cut-out layers rather than full-frame images. */
export function requiresTransparency(category: AssetCategory): boolean {
  return category === "character" || category === "prop";
}

export interface TransparencyCandidate {
  category: AssetCategory;
  processingStatus?: "raw" | "processing" | "ready" | "failed";
  hasAlpha?: boolean;
  processedImageUrl?: string;
  width?: number;
  height?: number;
}

export interface TransparencyVerdict {
  valid: boolean;
  reason?: string;
}

const VALID = { valid: true } as const;

/**
 * Gate for "may this become a usable character/prop layer?".
 *
 * Deliberately strict about the derivative URL: an RGBA image can still be
 * fully opaque, and a `hasAlpha` flag with no processed derivative behind it
 * means the raw source would be rendered instead — which is exactly how an
 * opaque background reached the canvas before.
 */
export function validateCharacterTransparency(candidate: TransparencyCandidate): TransparencyVerdict {
  if (!requiresTransparency(candidate.category)) return VALID;

  if (candidate.processingStatus === "processing") {
    return { valid: false, reason: "Background removal is still running." };
  }
  if (candidate.processingStatus !== "ready") {
    return { valid: false, reason: "Background removal did not complete." };
  }
  if (candidate.hasAlpha !== true) {
    return { valid: false, reason: "The image has no usable alpha channel." };
  }
  if (!candidate.processedImageUrl) {
    return { valid: false, reason: "No transparent derivative was produced." };
  }
  if (
    (candidate.width !== undefined && candidate.width < 4) ||
    (candidate.height !== undefined && candidate.height < 4)
  ) {
    return { valid: false, reason: "The image dimensions are unusable." };
  }
  return VALID;
}

/** The same gate applied to an asset already in the document. */
export function assetSatisfiesTransparencyContract(asset: SourceAsset | undefined): boolean {
  if (!asset) return false;
  // Documents written before the pipeline existed carry no processing state;
  // they are grandfathered rather than silently blanked out of old projects.
  if (requiresTransparency(asset.category) && asset.processingStatus === undefined) return true;
  return validateCharacterTransparency({
    category: asset.category,
    processingStatus: asset.processingStatus,
    hasAlpha: asset.hasAlpha,
    processedImageUrl: asset.processedImageUrl,
    width: asset.width,
    height: asset.height,
  }).valid;
}

/** One user-facing sentence. Never contains provider or pipeline internals. */
export const BACKGROUND_REMOVAL_FAILED_MESSAGE = "Background removal failed";
