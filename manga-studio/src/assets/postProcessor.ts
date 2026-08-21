/**
 * Provider-neutral image post-processing boundary.
 *
 * The current remover is intentionally replaceable: callers depend only on
 * AssetPostProcessor. It removes a dominant background only when that color
 * is connected to the image perimeter, preserving enclosed white artwork.
 */

import sharp from "sharp";
import type { AssetCategory } from "@/domain/types";
import {
  builtInBackgroundRemovalProvider,
  estimateEdgeBackground,
  type BackgroundRemovalProvider,
} from "./backgroundRemoval";
import { describeContamination, detectColorContamination } from "./colorContamination";

export interface AssetProcessingResult {
  sourceHasAlpha: boolean;
  hasAlpha: boolean;
  backgroundRemoved: boolean;
  processingStatus: "ready" | "failed";
  processedData?: Buffer;
  processedMimeType?: "image/png";
  processingMethod?: string;
  processingProvider?: string;
  reason?: string;
}

export interface AssetPostProcessor {
  process(data: Buffer, category: AssetCategory, options?: AssetProcessingOptions): Promise<AssetProcessingResult>;
}

export interface AssetProcessingOptions {
  forceBackgroundRemoval?: boolean;
  backgroundRemovalProvider?: BackgroundRemovalProvider;
  allowLocalFallback?: boolean;
  sourceUrl?: string;
  sourceMimeType?: string;
  strategy?: "auto" | "image-edit" | "provider" | "local";
  /** Project style is black-and-white: refuse a result carrying real colour. */
  expectMonochrome?: boolean;
}

const MAX_DECODED_PIXELS = 25_000_000;
export const defaultAssetPostProcessor: AssetPostProcessor = {
  process: processAssetImage,
};

export async function processAssetImage(
  data: Buffer,
  category: AssetCategory,
  options: AssetProcessingOptions = {},
): Promise<AssetProcessingResult> {
  let decoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    decoded = await sharp(data, { limitInputPixels: MAX_DECODED_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return failed("Image could not be decoded safely");
  }

  const { width, height, channels } = decoded.info;
  if (channels !== 4 || width < 4 || height < 4) return failed("Image dimensions or channels are unsupported");

  const alpha = inspectUsefulAlpha(decoded.data, width, height);
  if (alpha.useful) {
    const validation = validateProcessedAlpha(decoded.data, width, height);
    if (!validation.valid) return failed(validation.reason);
    const contamination = guardMonochrome(decoded.data, width, height, options);
    if (contamination) return contamination;
    return {
      sourceHasAlpha: true,
      hasAlpha: true,
      backgroundRemoved: false,
      processingStatus: "ready",
    };
  }

  const shouldRemove = options.forceBackgroundRemoval || category === "character" || category === "prop";
  if (!shouldRemove) {
    return {
      sourceHasAlpha: false,
      hasAlpha: false,
      backgroundRemoved: false,
      processingStatus: "ready",
    };
  }

  const background = estimateEdgeBackground(decoded.data, width, height);
  if (!background) return failed("No stable edge-connected background was detected");
  if (options.allowLocalFallback === false) {
    return failed("Opaque image requires foreground extraction");
  }
  let extraction;
  try {
    extraction = await (options.backgroundRemovalProvider ?? builtInBackgroundRemovalProvider).removeBackground({
      rgba: decoded.data,
      width,
      height,
      background,
    });
  } catch {
    return failed("Foreground extraction failed; the original source was preserved");
  }
  const output = extraction.rgba;
  const removedRatio = extraction.removedPixels / (width * height);
  if (removedRatio < 0.01 || removedRatio > 0.97) {
    return failed("Foreground separation was not reliable enough to replace the source");
  }

  try {
    const processedData = await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const validation = validateProcessedAlpha(output, width, height);
    if (!validation.valid) return failed(validation.reason);
    const contamination = guardMonochrome(output, width, height, options);
    if (contamination) return contamination;
    return {
      sourceHasAlpha: false,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      processedData,
      processedMimeType: "image/png",
      processingMethod: `${(options.backgroundRemovalProvider ?? builtInBackgroundRemovalProvider).id}:${extraction.method}`,
      processingProvider: (options.backgroundRemovalProvider ?? builtInBackgroundRemovalProvider).id,
    };
  } catch {
    return failed("The transparent derivative could not be encoded");
  }
}

/** Validate and normalize provider-produced cutouts before they can become derivatives. */
export async function validateTransparentImageBytes(
  data: Buffer,
  processingMethod: string,
  processingProvider: string,
  options: AssetProcessingOptions = {},
): Promise<AssetProcessingResult> {
  let decoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    decoded = await sharp(data, { limitInputPixels: MAX_DECODED_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    return failed("Provider cutout could not be decoded safely");
  }
  const { width, height, channels } = decoded.info;
  if (channels !== 4 || width < 4 || height < 4) return failed("Provider cutout dimensions or channels are unsupported");
  if (!inspectUsefulAlpha(decoded.data, width, height).useful) return failed("Provider cutout did not contain real transparency");
  const validation = validateProcessedAlpha(decoded.data, width, height);
  if (!validation.valid) return failed(validation.reason);
  const contamination = guardMonochrome(decoded.data, width, height, options);
  if (contamination) return contamination;
  try {
    return {
      sourceHasAlpha: false,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      processedData: await sharp(decoded.data, { raw: { width, height, channels: 4 } }).png().toBuffer(),
      processedMimeType: "image/png",
      processingMethod,
      processingProvider,
    };
  } catch {
    return failed("Provider cutout could not be normalized as PNG");
  }
}

function inspectUsefulAlpha(data: Buffer, width: number, height: number): { useful: boolean } {
  const pixels = width * height;
  let transparent = 0;
  let opaque = 0;
  for (let index = 3; index < data.length; index += 4) {
    const value = data[index];
    if (value < 245) transparent += 1;
    if (value > 250) opaque += 1;
  }
  // Reject an alpha channel that exists only as metadata or one anomalous pixel.
  const minimum = Math.max(4, Math.floor(pixels * 0.001));
  return { useful: transparent >= minimum && opaque >= minimum };
}

function validateProcessedAlpha(data: Buffer, width: number, height: number): { valid: true } | { valid: false; reason: string } {
  const pixels = width * height;
  let transparent = 0;
  let visible = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const alpha = data[pixel * 4 + 3];
    if (alpha < 16) transparent += 1;
    if (alpha > 16) {
      visible += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (visible < Math.max(16, pixels * 0.005)) return { valid: false, reason: "Foreground extraction produced an empty result" };
  if (transparent < Math.max(16, pixels * 0.01)) return { valid: false, reason: "Foreground extraction remained fully opaque" };
  if (visible > pixels * 0.97) return { valid: false, reason: "Foreground extraction retained the full image background" };
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  if (boxWidth < 2 || boxHeight < 2) return { valid: false, reason: "Foreground bounding box was not usable" };
  return { valid: true };
}

/**
 * Refuse a monochrome character that came back coloured.
 *
 * Runs on the FINAL visible pixels, so it catches spill the extractor could not
 * remove as well as colour the model painted into the artwork itself. Returning
 * a failure keeps it out of the library rather than silently promoting a tinted
 * asset — there is no post-process that can separate unwanted tint from
 * intended colour after the fact.
 */
function guardMonochrome(
  rgba: Buffer,
  width: number,
  height: number,
  options: AssetProcessingOptions,
): AssetProcessingResult | null {
  if (!options.expectMonochrome) return null;
  const report = detectColorContamination(rgba, width, height);
  return report.contaminated ? failed(describeContamination(report)) : null;
}

function failed(reason: string): AssetProcessingResult {
  return {
    sourceHasAlpha: false,
    hasAlpha: false,
    backgroundRemoved: false,
    processingStatus: "failed",
    reason,
  };
}
