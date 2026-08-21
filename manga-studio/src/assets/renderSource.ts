import type { SourceAsset } from "@/domain/types";
import { assetSatisfiesTransparencyContract, requiresTransparency } from "./characterAssetContract";

/**
 * The single URL-selection rule used by thumbnails, references, canvas, and export.
 *
 * A character or prop that has not satisfied the transparency contract has NO
 * renderable URL. Falling back to `storageUrl` here is what painted the opaque
 * generated background — checkerboard included — into panels and exports:
 * preview, library, canvas, and PNG must all resolve to the same validated
 * derivative or to nothing at all.
 */
export function assetRenderUrl(asset: SourceAsset | undefined): string | undefined {
  if (!asset) return undefined;
  if (requiresTransparency(asset.category)) {
    if (!assetSatisfiesTransparencyContract(asset)) return undefined;
    /**
     * Never `processedImageUrl ?? storageUrl` for a processed asset: the raw
     * source is the contaminated one. The only images reaching `storageUrl`
     * here are pre-pipeline documents, which carry no processing state at all
     * and are grandfathered rather than blanked out of old projects.
     */
    if (asset.processedImageUrl) return asset.processedImageUrl;
    return asset.processingStatus === undefined ? asset.storageUrl : undefined;
  }
  return asset.processedImageUrl && asset.processingStatus === "ready" && asset.hasAlpha
    ? asset.processedImageUrl
    : asset.storageUrl;
}

/**
 * Display-only URL for library chrome — never for compositing.
 *
 * A failed cutout still has a raw source worth showing beside its Retry
 * control so the creator can see what was generated. Keeping that fallback out
 * of `assetRenderUrl` is the whole point: the canvas and the exporter must not
 * be able to reach it.
 */
export function assetPreviewUrl(asset: SourceAsset | undefined): string | undefined {
  return assetRenderUrl(asset) ?? asset?.storageUrl;
}

/** Failed/pending cutouts remain retryable in the library but are not Agent-ready layers. */
export function isAssetReadyForComposition(asset: SourceAsset | undefined): boolean {
  if (!asset || asset.status === "archived") return false;
  if (!requiresTransparency(asset.category)) return asset.status === "ready";
  return assetSatisfiesTransparencyContract(asset) && Boolean(assetRenderUrl(asset));
}
