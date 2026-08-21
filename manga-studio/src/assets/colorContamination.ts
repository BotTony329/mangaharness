/**
 * Colour-contamination detection for monochrome character assets.
 *
 * A black-and-white manga asset should be overwhelmingly neutral. Saturated
 * regions in one mean something went wrong upstream — most often a coloured
 * background bleeding into hair and silhouette edges before extraction. No
 * post-process can reliably undo colour the model painted into the artwork, so
 * the correct response is to refuse the asset rather than promote a tinted one
 * into the library.
 */

import type { Rgb } from "./backgroundRemoval";

export interface ContaminationOptions {
  /** Minimum chroma (max−min channel) for a pixel to count as coloured. */
  minChroma?: number;
  /** Ignore near-black pixels, where sensor/JPEG noise inflates relative chroma. */
  minValue?: number;
  /** Share of visible pixels that must be coloured before the asset is refused. */
  maxSaturatedRatio?: number;
  /** Floor so a handful of stray pixels in a small image never trips the check. */
  minSaturatedPixels?: number;
}

export interface ContaminationReport {
  contaminated: boolean;
  visiblePixels: number;
  saturatedPixels: number;
  saturatedRatio: number;
  /** A representative offending colour, for diagnostics only. */
  sample?: Rgb;
}

const DEFAULTS: Required<ContaminationOptions> = {
  // Anti-aliasing between black ink and white paper is neutral grey (chroma 0);
  // JPEG ringing adds only a low single/double-digit tint. 36 sits well above
  // that noise floor and well below any deliberate colour.
  minChroma: 36,
  minValue: 40,
  maxSaturatedRatio: 0.004,
  minSaturatedPixels: 64,
};

/**
 * Measure how much of the visible artwork is coloured.
 *
 * Only near-opaque pixels are considered: a semi-transparent edge is a blend
 * with whatever sat behind it, so its colour says nothing about the artwork.
 */
export function detectColorContamination(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  options: ContaminationOptions = {},
): ContaminationReport {
  const { minChroma, minValue, maxSaturatedRatio, minSaturatedPixels } = { ...DEFAULTS, ...options };
  const pixels = width * height;
  let visiblePixels = 0;
  let saturatedPixels = 0;
  let sample: Rgb | undefined;
  let strongestChroma = 0;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    if (rgba[offset + 3] <= 200) continue;
    visiblePixels += 1;

    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const max = Math.max(red, green, blue);
    if (max < minValue) continue;
    const chroma = max - Math.min(red, green, blue);
    if (chroma < minChroma) continue;

    saturatedPixels += 1;
    if (chroma > strongestChroma) {
      strongestChroma = chroma;
      sample = [red, green, blue];
    }
  }

  const saturatedRatio = visiblePixels === 0 ? 0 : saturatedPixels / visiblePixels;
  return {
    contaminated:
      saturatedPixels >= minSaturatedPixels && saturatedRatio > maxSaturatedRatio,
    visiblePixels,
    saturatedPixels,
    saturatedRatio,
    sample,
  };
}

/** Safe user-facing wording; carries no pipeline or provider internals. */
export const COLOR_CONTAMINATION_MESSAGE = "Unexpected color contamination detected";

export function describeContamination(report: ContaminationReport): string {
  const percent = (report.saturatedRatio * 100).toFixed(1);
  const tint = report.sample ? ` (sample rgb ${report.sample.join(", ")})` : "";
  return `${COLOR_CONTAMINATION_MESSAGE}: ${percent}% of the visible artwork is coloured${tint}. A monochrome character should be neutral.`;
}
