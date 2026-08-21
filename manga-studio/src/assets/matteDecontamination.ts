/**
 * Matte edge decontamination.
 *
 * ## The failure this exists to fix
 *
 * An image model asked for a magenta screen draws the subject with genuinely
 * anti-aliased edges, so a boundary pixel is a real alpha blend:
 *
 *     Csrc = α·Cfg + (1−α)·Cmatte
 *
 * Measured on the real pipeline, a black-hair edge at 75% coverage arrives as
 * RGB [73, 9, 76] — three quarters ink, one quarter magenta. Segmentation was
 * never the problem: that pixel is *mostly foreground*, so the background flood
 * correctly refuses to key it out and it stays fully opaque. What was missing is
 * that its RGB still contains a quarter of the matte. Straight-alpha PNG
 * preserves that RGB verbatim, and compositing then shows a purple rim around
 * the entire silhouette — hair, shoulders, arms, hands, trousers.
 *
 * ## Why the previous "spill suppression" made it worse
 *
 * It only looked at partially transparent pixels (`alpha !== 255`), so it never
 * saw the opaque rim that carries the visible halo at all. Where it did fire it
 * pushed RGB toward grey, which is desaturation rather than recovery: it turned
 * a legitimately purple prop's edge from [176, 45, 206] into [79, 79, 79],
 * destroying real artwork to hide a symptom.
 *
 * ## What this does instead
 *
 * Un-mix the blend. For each boundary pixel we already know Cmatte, and we can
 * read Cfg from the clean interior a pixel or two inside the silhouette. The
 * blend then lies on the segment Cmatte → Cfg, and its position along that
 * segment IS the coverage:
 *
 *     α  = clamp( (Csrc − M) · (F − M) / |F − M|² , 0, 1 )
 *     Cfg ≈ (Csrc − (1−α)·M) / α
 *
 * Two properties matter. First, recovery targets the LOCAL foreground colour,
 * never neutral — which is why a purple prop's edge recovers to purple and a
 * blue shirt's edge recovers to blue. Second, a pixel that does not actually
 * lie on that segment is left alone: if the residual is large the pixel is an
 * independent colour, not a matte blend, so there is nothing to decontaminate.
 *
 * Applies to any matte, not just chroma keys — a white background leaves a
 * white halo on dark artwork by exactly the same mechanism.
 */

import { colorDistance, type Rgb } from "./backgroundRemoval";

export interface DecontaminationStats {
  /** Pixels on the silhouette rim that were examined. */
  boundaryPixels: number;
  /** Pixels whose foreground colour and alpha were recovered. */
  recoveredPixels: number;
  /** Skipped: no clean interior colour nearby to unmix against. */
  skippedNoReference: number;
  /** Skipped: colour is not a blend of this matte, so it is real artwork. */
  skippedNotMatteBlend: number;
}

/**
 * Distance from the matte→foreground line beyond which a pixel is treated as
 * its own colour rather than a blend. Generous enough to absorb JPEG ringing
 * and dithering, tight enough that unrelated artwork is never rewritten.
 */
const RESIDUAL_MAX = 46;

/**
 * Below this coverage, dividing by α amplifies quantisation noise into visible
 * speckle, so the local foreground colour is used directly instead.
 */
const MIN_RECOVERY_ALPHA = 0.15;

/** A foreground this close to the matte cannot be separated from it at all. */
const MIN_SEPARATION = 24;

/** Coverage above this is already clean; nothing to unmix. */
const CLEAN_COVERAGE = 0.995;

const NEAR_RADIUS = 3;
const FAR_RADIUS = 6;

/**
 * How deep inside the foreground a pixel must be before its colour is trusted
 * as uncontaminated. Sized for the widest anti-aliasing a generator realistically
 * produces; deeper would need thicker artwork than a manga line provides.
 */
const REFERENCE_DEPTH = 5;

/** Distance transform cap — nothing beyond the reference depth matters. */
const MAX_DEPTH = REFERENCE_DEPTH + 1;

export interface DecontaminationInput {
  /** Straight-alpha RGBA, mutated in place. */
  rgba: Buffer;
  width: number;
  height: number;
  /** The estimated matte colour(s); the nearest one is used per pixel. */
  matteColors: Rgb[];
  /**
   * Pixels the background flood reached. Used only to locate the rim — the
   * decision to rewrite a pixel is made from colour geometry, not from this.
   */
  background: Uint8Array;
}

export function decontaminateMatteEdges(input: DecontaminationInput): DecontaminationStats {
  const { rgba, width, height, matteColors, background } = input;
  const pixelCount = width * height;
  const stats: DecontaminationStats = {
    boundaryPixels: 0,
    recoveredPixels: 0,
    skippedNoReference: 0,
    skippedNotMatteBlend: 0,
  };
  if (matteColors.length === 0) return stats;

  /**
   * Depth of each pixel inside the foreground, in pixels from the background.
   *
   * A one-pixel erosion is NOT enough to find clean reference colour. A soft
   * edge several pixels wide is contaminated several pixels deep, and every one
   * of those pixels is surrounded by other contaminated pixels — so an
   * "adjacent to background" test happily classifies them as clean and then
   * unmixes the rim against a colour that is itself part magenta. A distance
   * transform measures the band instead of assuming it is one pixel.
   */
  const depth = backgroundDistance(background, rgba, width, height, MAX_DEPTH);

  let maxDepth = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) maxDepth = Math.max(maxDepth, depth[pixel]);
  /**
   * How deep a pixel must be to serve as a clean colour reference. Adaptive so
   * that thin artwork — a line, a hair strand — still gets whatever reference
   * its own thickness allows instead of being skipped entirely.
   */
  const referenceDepth = Math.max(1, Math.min(REFERENCE_DEPTH, maxDepth));

  /**
   * Pick the clean neighbour this pixel is actually a blend OF.
   *
   * A median over the window looks reasonable until the window straddles a
   * colour boundary — purple prop against black hair, skin against a collar —
   * where the median is a colour that exists nowhere in the artwork, and
   * unmixing against it leaves residual matte behind. Choosing the candidate
   * with the smallest residual instead asks the right question directly: which
   * neighbouring colour, mixed with this matte, explains this pixel?
   */
  const bestReference = (
    cx: number,
    cy: number,
    color: Rgb,
    matte: Rgb,
  ): { foreground: Rgb; coverage: number; residual: number } | null => {
    let best: { foreground: Rgb; coverage: number; residual: number } | null = null;
    let bestSpatial = Infinity;

    for (const radius of [NEAR_RADIUS, FAR_RADIUS]) {
      for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
          const neighbour = y * width + x;
          if (depth[neighbour] < referenceDepth) continue;
          const offset = neighbour * 4;
          const candidate: Rgb = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];

          const axis: Rgb = [candidate[0] - matte[0], candidate[1] - matte[1], candidate[2] - matte[2]];
          const axisLengthSquared = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
          if (axisLengthSquared < MIN_SEPARATION * MIN_SEPARATION) continue;

          const delta: Rgb = [color[0] - matte[0], color[1] - matte[1], color[2] - matte[2]];
          const raw = (delta[0] * axis[0] + delta[1] * axis[1] + delta[2] * axis[2]) / axisLengthSquared;
          const coverage = Math.max(0, Math.min(1, raw));
          const residual = colorDistance(color, [
            matte[0] + axis[0] * coverage,
            matte[1] + axis[1] * coverage,
            matte[2] + axis[2] * coverage,
          ]);
          const spatial = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (!best || residual < best.residual - 0.5 || (Math.abs(residual - best.residual) <= 0.5 && spatial < bestSpatial)) {
            best = { foreground: candidate, coverage, residual };
            bestSpatial = spatial;
          }
        }
      }
      if (best) return best;
    }
    return best;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      // Deep pixels are references, not candidates. Everything shallower is
      // examined; a genuinely clean pixel projects to full coverage and is
      // skipped below, so including it costs nothing and misses nothing.
      if (depth[pixel] >= referenceDepth) continue;
      const offset = pixel * 4;
      const alpha = rgba[offset + 3];
      if (alpha === 0) continue;

      const color: Rgb = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
      stats.boundaryPixels += 1;

      const matte = nearestColor(color, matteColors);
      const reference = bestReference(x, y, color, matte);
      if (!reference) {
        stats.skippedNoReference += 1;
        continue;
      }
      if (reference.residual > RESIDUAL_MAX) {
        // Not on any local matte→foreground line: this is real artwork.
        stats.skippedNotMatteBlend += 1;
        continue;
      }
      const coverage = reference.coverage;
      if (coverage >= CLEAN_COVERAGE) continue;

      const recovered: Rgb =
        coverage >= MIN_RECOVERY_ALPHA
          ? [
              clampChannel((color[0] - (1 - coverage) * matte[0]) / coverage),
              clampChannel((color[1] - (1 - coverage) * matte[1]) / coverage),
              clampChannel((color[2] - (1 - coverage) * matte[2]) / coverage),
            ]
          : reference.foreground;

      rgba[offset] = recovered[0];
      rgba[offset + 1] = recovered[1];
      rgba[offset + 2] = recovered[2];
      /**
       * Never raise alpha above what segmentation concluded. The projection is
       * the better coverage estimate, but decontamination must not be able to
       * resurrect background the flood decided to remove.
       */
      rgba[offset + 3] = Math.min(alpha, Math.round(255 * coverage));
      stats.recoveredPixels += 1;
    }
  }

  return stats;
}

/**
 * Breadth-first distance from the background, capped.
 *
 * Background and already-transparent pixels are depth 0; each step inward adds
 * one. Capping keeps this O(pixels) regardless of how large the subject is.
 */
function backgroundDistance(
  background: Uint8Array,
  rgba: Buffer,
  width: number,
  height: number,
  cap: number,
): Uint8Array {
  const pixelCount = width * height;
  const depth = new Uint8Array(pixelCount).fill(cap);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (background[pixel] || rgba[pixel * 4 + 3] === 0) {
      depth[pixel] = 0;
      queue[tail++] = pixel;
    }
  }
  // An image with no detected background has no rim to clean.
  if (tail === 0) return depth;

  while (head < tail) {
    const pixel = queue[head++];
    const next = depth[pixel] + 1;
    if (next > cap) continue;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const visit = (neighbour: number) => {
      if (depth[neighbour] <= next) return;
      depth[neighbour] = next;
      queue[tail++] = neighbour;
    };
    if (x > 0) visit(pixel - 1);
    if (x + 1 < width) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y + 1 < height) visit(pixel + width);
  }
  return depth;
}

function nearestColor(color: Rgb, candidates: Rgb[]): Rgb {
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = colorDistance(color, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// ─── Decontaminating an alpha channel we did not create ────────────────────

/**
 * Estimate the matte colour a provider composited against, from its own output.
 *
 * When the background flood produces the alpha we already know the matte: it is
 * whatever we keyed. But a provider that returns a transparent PNG hands us an
 * alpha channel with no such record — and its anti-aliased edges are still
 * blends, because the model rendered the subject over *something* before
 * cutting it out. Measured on the real pipeline, a black-hair edge arrives as
 * RGB [41,18,49] at alpha 234 where the true ink is [22,20,30].
 *
 * The matte is recoverable by inverting the same equation. For a rim pixel with
 * known coverage `a` and a clean opaque neighbour `F`:
 *
 *     M = (Csrc − a·F) / (1 − a)
 *
 * One pixel's estimate is noisy; the median across the whole rim is not.
 */
export function estimateMatteFromAlpha(
  rgba: Buffer,
  width: number,
  height: number,
): { matte: Rgb; samples: number } | null {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const foregroundReds: number[] = [];
  const foregroundGreens: number[] = [];
  const foregroundBlues: number[] = [];

  /**
   * Which alpha values to trust.
   *
   * Real anti-aliasing does NOT produce a smooth spread of coverage: measured
   * on a 1px edge, alpha clusters near the extremes (≈20 and ≈234) with almost
   * nothing between. A "mid-coverage only" window therefore finds no samples at
   * all — which is exactly why the first attempt at this silently declined.
   *
   * Low-alpha pixels are also the BEST estimators, not the worst: at a=0.08 the
   * divisor (1−a) is 0.92, so quantisation barely moves the answer, and the
   * pixel is almost pure matte. High-alpha pixels divide by ~0.08 and amplify
   * noise. So the well-conditioned end is preferred, and the noisy end is only
   * consulted when a shape offers nothing better.
   */
  const collect = (maxAlpha: number) => {
    reds.length = 0;
    greens.length = 0;
    blues.length = 0;
    foregroundReds.length = 0;
    foregroundGreens.length = 0;
    foregroundBlues.length = 0;

    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = rgba[offset + 3];
        if (alpha < MATTE_SAMPLE_MIN_ALPHA || alpha > maxAlpha) continue;

        const neighbour = nearestOpaque(rgba, width, height, x, y);
        if (!neighbour) continue;

        const a = alpha / 255;
        const inverse = 1 - a;
        const estimate: Rgb = [
          (rgba[offset] - a * neighbour[0]) / inverse,
          (rgba[offset + 1] - a * neighbour[1]) / inverse,
          (rgba[offset + 2] - a * neighbour[2]) / inverse,
        ];
        // A wildly out-of-gamut estimate means the model does not hold here.
        if (estimate.some((channel) => channel < -60 || channel > 315)) continue;

        reds.push(estimate[0]);
        greens.push(estimate[1]);
        blues.push(estimate[2]);
        foregroundReds.push(neighbour[0]);
        foregroundGreens.push(neighbour[1]);
        foregroundBlues.push(neighbour[2]);
      }
    }
    return reds.length;
  };

  if (collect(WELL_CONDITIONED_MAX_ALPHA) < MIN_MATTE_SAMPLES) {
    if (collect(MATTE_SAMPLE_MAX_ALPHA) < MIN_MATTE_SAMPLES) return null;
  }
  const matte: Rgb = [
    clampChannel(median(reds)),
    clampChannel(median(greens)),
    clampChannel(median(blues)),
  ];

  /**
   * Two ways this must decline rather than guess.
   *
   * A genuinely clean cutout produces estimates scattered around the artwork's
   * own colours, so the "matte" would sit right on top of the foreground —
   * decontaminating against that would rewrite real pixels. And a wide spread
   * means the estimates never agreed on anything, so there is no single matte.
   */
  const foreground: Rgb = [
    median(foregroundReds),
    median(foregroundGreens),
    median(foregroundBlues),
  ];
  if (colorDistance(matte, foreground) < MIN_MATTE_SEPARATION) return null;

  const spread =
    (medianAbsoluteDeviation(reds, matte[0]) +
      medianAbsoluteDeviation(greens, matte[1]) +
      medianAbsoluteDeviation(blues, matte[2])) /
    3;
  if (spread > MAX_MATTE_SPREAD) return null;

  return { matte, samples: reds.length };
}

/**
 * Decontaminate an image whose alpha came from somewhere else.
 *
 * Used for provider cutouts and for sources that arrive with native alpha —
 * both of which previously bypassed decontamination entirely, which is what
 * left the purple rim on generated colour characters in production.
 *
 * Returns null when no consistent matte is detectable, which is the correct
 * answer for an already-clean cutout: there is nothing to recover.
 */
export function decontaminateExistingAlpha(
  rgba: Buffer,
  width: number,
  height: number,
): (DecontaminationStats & { matte: Rgb }) | null {
  const estimate = estimateMatteFromAlpha(rgba, width, height);
  if (!estimate) return null;

  // Fully transparent pixels ARE the background here; there was no flood.
  const background = new Uint8Array(width * height);
  for (let pixel = 0; pixel < background.length; pixel += 1) {
    background[pixel] = rgba[pixel * 4 + 3] === 0 ? 1 : 0;
  }

  const stats = decontaminateMatteEdges({
    rgba,
    width,
    height,
    matteColors: [estimate.matte],
    background,
  });
  return { ...stats, matte: estimate.matte };
}

/** Ignore all-but-invisible pixels, whose colour is pure noise. */
const MATTE_SAMPLE_MIN_ALPHA = 6;
/** Below this the (1−a) divisor stays large, so the estimate is stable. */
const WELL_CONDITIONED_MAX_ALPHA = 128;
/** The noisy end, used only when a shape offers nothing better. */
const MATTE_SAMPLE_MAX_ALPHA = 247;
const MIN_MATTE_SAMPLES = 24;
/** Below this the "matte" is indistinguishable from the artwork itself. */
const MIN_MATTE_SEPARATION = 60;
/** Above this the estimates never agreed, so there is no single matte. */
const MAX_MATTE_SPREAD = 52;

/** Nearest fully opaque neighbour's colour, searched outward. */
function nearestOpaque(rgba: Buffer, width: number, height: number, cx: number, cy: number): Rgb | null {
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
        const offset = (y * width + x) * 4;
        if (rgba[offset + 3] === 255) return [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
      }
    }
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function medianAbsoluteDeviation(values: number[], centre: number): number {
  return median(values.map((value) => Math.abs(value - centre)));
}

