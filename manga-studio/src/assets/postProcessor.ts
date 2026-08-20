/**
 * Provider-neutral image post-processing boundary.
 *
 * The current remover is intentionally replaceable: callers depend only on
 * AssetPostProcessor. It removes a dominant background only when that color
 * is connected to the image perimeter, preserving enclosed white artwork.
 */

import sharp from "sharp";
import type { AssetCategory } from "@/domain/types";

export interface AssetProcessingResult {
  sourceHasAlpha: boolean;
  hasAlpha: boolean;
  backgroundRemoved: boolean;
  processingStatus: "ready" | "failed";
  processedData?: Buffer;
  processedMimeType?: "image/png";
  reason?: string;
}

export interface AssetPostProcessor {
  process(data: Buffer, category: AssetCategory, options?: { forceBackgroundRemoval?: boolean }): Promise<AssetProcessingResult>;
}

const MAX_DECODED_PIXELS = 25_000_000;
const STRONG_BACKGROUND_DISTANCE = 32;
const MAX_BACKGROUND_DISTANCE = 88;

export const defaultAssetPostProcessor: AssetPostProcessor = {
  process: processAssetImage,
};

export async function processAssetImage(
  data: Buffer,
  category: AssetCategory,
  options: { forceBackgroundRemoval?: boolean } = {},
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
  if (background.checkerboard) return failed("The image contains an opaque checkerboard, not real transparency");

  const output = Buffer.from(decoded.data);
  const visited = floodBackground(output, width, height, background.color);
  const removedRatio = visited / (width * height);
  if (removedRatio < 0.01 || removedRatio > 0.97) {
    return failed("Foreground separation was not reliable enough to replace the source");
  }

  try {
    const processedData = await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const processedAlpha = inspectUsefulAlpha(output, width, height);
    if (!processedAlpha.useful) return failed("The processed image did not contain useful transparency");
    return {
      sourceHasAlpha: false,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      processedData,
      processedMimeType: "image/png",
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

interface EdgeBackground {
  color: [number, number, number];
  checkerboard: boolean;
}

function estimateEdgeBackground(data: Buffer, width: number, height: number): EdgeBackground | null {
  const samples: [number, number, number][] = [];
  const bins = new Map<string, { count: number; values: [number, number, number][] }>();
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    const value: [number, number, number] = [data[offset], data[offset + 1], data[offset + 2]];
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
  return { color, checkerboard: binaryEdge };
}

function floodBackground(data: Buffer, width: number, height: number, background: [number, number, number]): number {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel: number) => {
    if (visited[pixel]) return;
    const offset = pixel * 4;
    const distance = colorDistance([data[offset], data[offset + 1], data[offset + 2]], background);
    if (distance > MAX_BACKGROUND_DISTANCE) return;
    visited[pixel] = 1;
    queue[tail++] = pixel;
    const feather = Math.max(0, Math.min(1, (distance - STRONG_BACKGROUND_DISTANCE) / (MAX_BACKGROUND_DISTANCE - STRONG_BACKGROUND_DISTANCE)));
    data[offset + 3] = Math.round(255 * feather);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }
  return tail;
}

function medianColor(values: [number, number, number][]): [number, number, number] {
  const channel = (index: number) => values.map((value) => value[index]).sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return [channel(0), channel(1), channel(2)];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function countEdgeTransitions(samples: [number, number, number][]): number {
  let transitions = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (colorDistance(samples[index - 1], samples[index]) > 32) transitions += 1;
  }
  return transitions;
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
