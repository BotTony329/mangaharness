"use client";

/**
 * Alpha masks for pointer hit-testing.
 *
 * A character cutout's image is a rectangle whose corners are empty. Konva's
 * default picking treats that whole rectangle as the hit region, so a standing
 * figure captured clicks across a large slab of the panel and nothing behind it
 * could be selected. Sampling real alpha fixes that at the source.
 *
 * Masks are downsampled hard: pointer accuracy needs a few hundred samples
 * across the silhouette, not the full render, and one byte per sample keeps a
 * project's worth of characters in a trivial amount of memory. They are built
 * lazily on first hit-test and cached per URL.
 *
 * Building one requires reading pixels back, which taints on a cross-origin
 * image without CORS. `useImageElement` already requests `crossOrigin`
 * anonymous for exactly this class of reason; if a read still throws, the mask
 * is recorded as unavailable and hit-testing falls back to bounds rather than
 * making the asset unselectable.
 */

import type { AlphaSampler } from "@/canvas/hitStack";
import { loadImageElement } from "./useImageElement";

/** Longest edge of a cached mask, in samples. */
const MASK_SIZE = 192;

interface AlphaMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** `null` means "we tried and cannot read this image" — do not retry forever. */
const masks = new Map<string, AlphaMask | null>();
const building = new Set<string>();

function buildMask(url: string, image: HTMLImageElement): AlphaMask | null {
  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  if (!natural.width || !natural.height) return null;
  const scale = Math.min(1, MASK_SIZE / Math.max(natural.width, natural.height));
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const alpha = new Uint8Array(width * height);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = data[index * 4 + 3];
    return { width, height, data: alpha };
  } catch {
    // Tainted canvas, or a decode that never completed.
    return null;
  }
}

/**
 * Sample alpha at normalized image coordinates.
 *
 * Returns null while the mask is still being built, which callers treat as
 * "fall back to bounds" — a click must never be swallowed just because a
 * texture has not finished decoding.
 */
export const sampleAssetAlpha: AlphaSampler = (url, u, v) => {
  const mask = masks.get(url);
  if (mask === null) return null;
  if (mask === undefined) {
    requestMask(url);
    return null;
  }
  if (u < 0 || v < 0 || u > 1 || v > 1) return 0;
  const x = Math.min(mask.width - 1, Math.max(0, Math.floor(u * mask.width)));
  const y = Math.min(mask.height - 1, Math.max(0, Math.floor(v * mask.height)));
  return mask.data[y * mask.width + x];
};

function requestMask(url: string): void {
  if (building.has(url)) return;
  building.add(url);
  loadImageElement(url)
    .then((image) => {
      masks.set(url, buildMask(url, image));
    })
    .catch(() => {
      masks.set(url, null);
    })
    .finally(() => {
      building.delete(url);
    });
}

/** Drop a cached mask — used when an asset's pixels are replaced. */
export function invalidateAlphaMask(url: string): void {
  masks.delete(url);
}
