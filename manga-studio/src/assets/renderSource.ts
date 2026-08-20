import type { SourceAsset } from "@/domain/types";

/** The single URL-selection rule used by thumbnails, references, canvas, and export. */
export function assetRenderUrl(asset: SourceAsset | undefined): string | undefined {
  return asset?.processedImageUrl ?? asset?.storageUrl;
}
