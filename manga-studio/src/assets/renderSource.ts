import type { SourceAsset } from "@/domain/types";

/** The single URL-selection rule used by thumbnails, references, canvas, and export. */
export function assetRenderUrl(asset: SourceAsset | undefined): string | undefined {
  return asset?.processedImageUrl && asset.processingStatus === "ready" && asset.hasAlpha
    ? asset.processedImageUrl
    : asset?.storageUrl;
}

/** Failed/pending cutouts remain retryable in the library but are not Agent-ready layers. */
export function isAssetReadyForComposition(asset: SourceAsset | undefined): boolean {
  if (!asset || asset.status === "archived") return false;
  if (asset.category !== "character" && asset.category !== "prop") return asset.status === "ready";
  // Pre-pipeline documents did not have processing state. New and migrated
  // assets take the strict ready + real-alpha + derivative branch.
  if (asset.processingStatus === undefined) return asset.status === "ready";
  return asset.processingStatus === "ready" && asset.hasAlpha === true && Boolean(asset.processedImageUrl);
}
