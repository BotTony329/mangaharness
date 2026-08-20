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
  colorDistance,
  type BackgroundModel,
  type BackgroundRemovalProvider,
  type Rgb,
} from "./backgroundRemoval";

export interface AssetProcessingResult {
  sourceHasAlpha: boolean;
  hasAlpha: boolean;
  backgroundRemoved: boolean;
  processingStatus: "ready" | "failed";
  processedData?: Buffer;
  processedMimeType?: "image/png";
  processingMethod?: string;
  reason?: string;
}

export interface AssetPostProcessor {
  process(data: Buffer, category: AssetCategory, options?: AssetProcessingOptions): Promise<AssetProcessingResult>;
}

export interface AssetProcessingOptions {
  forceBackgroundRemoval?: boolean;
  backgroundRemovalProvider?: BackgroundRemovalProvider;
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
    return failed(background.kind === "checkerboard"
      ? "Opaque checkerboard detected, but no reliable foreground could be extracted"
      : "Foreground separation was not reliable enough to replace the source");
  }

  try {
    const processedData = await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const validation = validateProcessedAlpha(output, width, height);
    if (!validation.valid) return failed(validation.reason);
    return {
      sourceHasAlpha: false,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      processedData,
      processedMimeType: "image/png",
      processingMethod: `${(options.backgroundRemovalProvider ?? builtInBackgroundRemovalProvider).id}:${extraction.method}`,
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

function estimateEdgeBackground(data: Buffer, width: number, height: number): BackgroundModel | null {
  const samples: Rgb[] = [];
  const bins = new Map<string, { count: number; values: Rgb[] }>();
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    const value: Rgb = [data[offset], data[offset + 1], data[offset + 2]];
    samples.push(value);
    const key = `${value[0] >> 4}:${value[1] >> 4}:${value[2] >> 4}`;
    const bin = bins.get(key) ?? { count: 0, values: [] };
    bin.count += 1;
    bin.values.push(value);
    bins.set(key, bin);
  };
  for (let x = 0; x < width; x += 1) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y);
    add(width - 1, y);
  }

  const ranked = [...bins.values()].sort((a, b) => b.count - a.count);
  const dominant = ranked[0];
  if (!dominant || dominant.count / samples.length < 0.28) return null;
  const color = medianColor(dominant.values);
  const second = ranked[1];
  const binaryEdge = Boolean(
    second &&
      (dominant.count + second.count) / samples.length > 0.72 &&
      colorDistance(color, medianColor(second.values)) > 40 &&
      countEdgeTransitions(samples) > samples.length * 0.18,
  );
  return binaryEdge && second
    ? { kind: "checkerboard", colors: [color, medianColor(second.values)] }
    : { kind: "solid", colors: [color] };
}

function medianColor(values: Rgb[]): Rgb {
  const channel = (index: number) => values.map((value) => value[index]).sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return [channel(0), channel(1), channel(2)];
}

function countEdgeTransitions(samples: Rgb[]): number {
  let transitions = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (colorDistance(samples[index - 1], samples[index]) > 32) transitions += 1;
  }
  return transitions;
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

function failed(reason: string): AssetProcessingResult {
  return {
    sourceHasAlpha: false,
    hasAlpha: false,
    backgroundRemoved: false,
    processingStatus: "failed",
    reason,
  };
}
