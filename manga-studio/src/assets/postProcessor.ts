/**
 * Provider-neutral image post-processing boundary.
 *
 * The current remover is intentionally replaceable: callers depend only on
 * AssetPostProcessor. It removes a dominant background only when that color
 * is connected to the image perimeter, preserving enclosed white artwork.
 */

import sharp, { type OutputInfo } from "sharp";
import type { AssetCategory } from "@/domain/types";
import {
  builtInBackgroundRemovalProvider,
  estimateEdgeBackground,
  validateWhiteBackground,
  type BackgroundRemovalProvider,
} from "./backgroundRemoval";
import { describeContamination, detectColorContamination } from "./colorContamination";
import { decontaminateExistingAlpha } from "./matteDecontamination";

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
  /**
   * Enforce the pure-white backdrop contract.
   *
   * Opt-IN, and set only by the generation path. Uploads may legitimately carry
   * any backdrop, and repairing a pre-policy asset means re-extracting the
   * magenta matte it was generated with — refusing those would break both.
   */
  requireWhiteBackground?: boolean;
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
  let decoded: { data: Buffer; info: OutputInfo };
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
    /**
     * An alpha channel we did not create still needs decontaminating.
     *
     * A provider that "supports native transparency" renders the subject over
     * something and keys it, so its anti-aliased edges arrive as blends with
     * that matte — measured at RGB [41,18,49] for black ink whose true colour
     * is [22,20,30]. This path used to return here with no derivative at all,
     * and `processAndStoreAsset` then pointed `processedImageUrl` at the raw
     * source, which is how the purple rim reached production.
     */
    return cleanExistingAlpha(decoded.data, width, height, {
      sourceHasAlpha: true,
      backgroundRemoved: false,
      processingMethod: "native-alpha",
      processingProvider: "provider",
    });
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

  /**
   * Enforce the white-background contract BEFORE keying anything out.
   *
   * Every foreground asset is now generated on pure white. If the provider
   * returned a coloured backdrop anyway, extracting it would blend that colour
   * into every anti-aliased edge — the exact failure the policy exists to
   * prevent. Failing here is recoverable (regenerate); a tinted silhouette that
   * passed validation is not.
   *
   * Only the generation path opts in. Uploads and the repair of pre-policy
   * assets deliberately skip it.
   */
  if (options.requireWhiteBackground === true) {
    const white = validateWhiteBackground(decoded.data, width, height);
    if (!white.valid) return failed(white.reason ?? "The generated background is not white.");
  }
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
  let decoded: { data: Buffer; info: OutputInfo };
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
  // A cutout from an image-edit model or a background-removal service carries
  // the same contaminated rim, for the same reason. Same treatment.
  return cleanExistingAlpha(decoded.data, width, height, {
    sourceHasAlpha: false,
    backgroundRemoved: true,
    processingMethod,
    processingProvider,
  });
}

/**
 * Decontaminate an externally produced alpha channel and encode the result.
 *
 * ALWAYS returns a derivative, even when no matte is detectable. That matters:
 * a transparency-requiring asset with no `processedImageUrl` used to be stored
 * with its raw source aliased in that field, so "no derivative" silently meant
 * "render the untouched provider bytes".
 */
async function cleanExistingAlpha(
  rgba: Buffer,
  width: number,
  height: number,
  meta: {
    sourceHasAlpha: boolean;
    backgroundRemoved: boolean;
    processingMethod: string;
    processingProvider: string;
  },
): Promise<AssetProcessingResult> {
  const working = Buffer.from(rgba);
  const cleaned = decontaminateExistingAlpha(working, width, height);
  try {
    return {
      sourceHasAlpha: meta.sourceHasAlpha,
      hasAlpha: true,
      backgroundRemoved: meta.backgroundRemoved,
      processingStatus: "ready",
      processedData: await sharp(working, { raw: { width, height, channels: 4 } }).png().toBuffer(),
      processedMimeType: "image/png",
      // The method records whether a matte was actually found and removed, so a
      // clean provider cutout is distinguishable from one we had to repair.
      processingMethod: cleaned
        ? `${meta.processingMethod}+decontaminated`
        : meta.processingMethod,
      processingProvider: meta.processingProvider,
    };
  } catch {
    return failed("The transparent derivative could not be encoded");
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
