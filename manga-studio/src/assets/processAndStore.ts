import type { AssetCategory } from "@/domain/types";
import { putObject } from "@/storage/objectStore";
import { defaultAssetPostProcessor, type AssetPostProcessor, type AssetProcessingResult } from "./postProcessor";
import { requiresTransparency } from "./characterAssetContract";

export interface StoredProcessedAsset {
  sourceUrl: string;
  processedImageUrl?: string;
  hasAlpha: boolean;
  backgroundRemoved: boolean;
  processingStatus: "ready" | "failed";
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
}

/** Persist the provider/upload source first, then add a transparent derivative when safe. */
export async function processAndStoreAsset(input: {
  data: Buffer;
  mimeType: string;
  extension: string;
  category: AssetCategory;
  keyPrefix: string;
  processor?: AssetPostProcessor;
  expectMonochrome?: boolean;
  /** Enforce the pure-white backdrop contract (generation path only). */
  requireWhiteBackground?: boolean;
}): Promise<StoredProcessedAsset> {
  const source = await putObject(
    `${input.keyPrefix}/source-${crypto.randomUUID()}.${input.extension}`,
    input.data,
    input.mimeType,
  );
  let result: AssetProcessingResult;
  try {
    result = await (input.processor ?? defaultAssetPostProcessor).process(input.data, input.category, {
      sourceUrl: source.url,
      sourceMimeType: input.mimeType,
      expectMonochrome: input.expectMonochrome,
      requireWhiteBackground: input.requireWhiteBackground,
    });
  } catch {
    return {
      sourceUrl: source.url,
      hasAlpha: false,
      backgroundRemoved: false,
      processingStatus: "failed",
      processingReason: "Asset post-processing failed; the original source was preserved",
    };
  }
  let processedImageUrl: string | undefined;
  if (result.processedData && result.processedMimeType) {
    try {
      const processed = await putObject(
        `${input.keyPrefix}/processed-${crypto.randomUUID()}.png`,
        result.processedData,
        result.processedMimeType,
      );
      processedImageUrl = processed.url;
    } catch {
      return {
        sourceUrl: source.url,
        hasAlpha: false,
        backgroundRemoved: false,
        processingStatus: "failed",
        processingReason: "Transparent derivative storage failed; the original source was preserved",
      };
    }
  } else if (result.sourceHasAlpha && !requiresTransparency(input.category)) {
    /**
     * Aliasing the derivative to the raw source is only safe for categories
     * that are NOT composited as cut-outs. For a character or prop it meant
     * `processedImageUrl` pointed at untouched provider bytes, so the canvas
     * rendered a contaminated edge while every contract check passed — the
     * production purple-fringe path. Those categories now always carry a real,
     * decontaminated derivative or fail outright.
     */
    processedImageUrl = source.url;
  }
  return {
    sourceUrl: source.url,
    processedImageUrl,
    hasAlpha: result.hasAlpha,
    backgroundRemoved: result.backgroundRemoved,
    processingStatus: result.processingStatus,
    processingReason: result.reason,
    backgroundRemovalMethod: result.processingMethod,
    backgroundRemovalProvider: result.processingProvider,
  };
}
