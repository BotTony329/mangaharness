/**
 * Local generative editing — the enforcement boundary.
 *
 * ## Why this exists
 *
 * A prompt that says "only change the selected area" is a request, not a
 * guarantee. Image-edit models redraw the whole frame: they re-encode the
 * background, shift line weights, drift skin tone, and quietly restyle the face
 * while faithfully doing the one thing that was asked. Accepting their output
 * wholesale is how a local hand fix silently becomes a different character.
 *
 * So we do not trust it. The provider's pixels are accepted **only inside the
 * mask the creator drew**; everything else is copied byte-for-byte from the
 * original. That is a property of this compositor, not of the prompt.
 *
 * ## Coordinate rule
 *
 * Masks live in IMAGE space, never screen space. Zoom, pan and display scaling
 * change what the creator looks at; they must not change which pixels are
 * editable. The editor converts pointer positions to image coordinates once,
 * at the boundary.
 */

/** A mask in image space: one byte of coverage per pixel, 0 = keep original. */
export interface SelectionMask {
  width: number;
  height: number;
  /** 0..255. Values above zero are editable, scaled by the amount. */
  data: Uint8Array;
}

export interface CompositeInput {
  /** Straight-alpha RGBA of the untouched asset. */
  original: Buffer;
  /** Straight-alpha RGBA returned by the provider, same dimensions. */
  generated: Buffer;
  mask: SelectionMask;
  width: number;
  height: number;
  /**
   * Softening applied to the mask boundary, in pixels.
   *
   * Feather runs INWARD only — see `featherMask`. A conservative default: a
   * hard cut can leave a visible seam, but a wide blend is how a "fix the hand"
   * edit starts eating the sleeve.
   */
  feather?: number;
}

export const DEFAULT_FEATHER = 3;
/** Beyond this the transition stops being a seam fix and becomes a soft blend. */
export const MAX_FEATHER = 24;

export interface CompositeResult {
  rgba: Buffer;
  /** Pixels that took any provider colour at all. */
  editedPixels: number;
  /** Pixels reproduced exactly from the original. */
  preservedPixels: number;
}

/**
 * Merge a provider edit into the original, honouring the mask absolutely.
 *
 * Mixing is per-channel linear on straight alpha, which is correct because both
 * inputs are straight alpha and the mask is a coverage fraction rather than a
 * transparency.
 */
export function compositeLocalEdit(input: CompositeInput): CompositeResult {
  const { original, generated, width, height } = input;
  const pixels = width * height;
  if (original.length < pixels * 4 || generated.length < pixels * 4) {
    throw new Error("Local edit inputs must both be RGBA at the original dimensions");
  }
  if (input.mask.width !== width || input.mask.height !== height) {
    throw new Error("Mask dimensions must match the image");
  }

  const coverage = featherMask(input.mask, input.feather ?? DEFAULT_FEATHER);
  const out = Buffer.from(original);
  let editedPixels = 0;
  let preservedPixels = 0;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const amount = coverage[pixel];
    if (amount === 0) {
      // The guarantee: untouched, not "recomputed and happened to match".
      preservedPixels += 1;
      continue;
    }
    editedPixels += 1;
    const offset = pixel * 4;
    if (amount === 255) {
      out[offset] = generated[offset];
      out[offset + 1] = generated[offset + 1];
      out[offset + 2] = generated[offset + 2];
      out[offset + 3] = generated[offset + 3];
      continue;
    }
    const t = amount / 255;
    for (let channel = 0; channel < 4; channel += 1) {
      out[offset + channel] = Math.round(
        original[offset + channel] * (1 - t) + generated[offset + channel] * t,
      );
    }
  }

  return { rgba: out, editedPixels, preservedPixels };
}

/**
 * Soften a mask edge INWARD.
 *
 * A symmetric blur would spread coverage outward, which would let provider
 * pixels bleed past the region the creator actually selected — exactly the
 * leak §10 forbids. Multiplying the blurred mask back by the original binary
 * mask clamps it: outside the drawn region the result is exactly zero, by
 * construction rather than by tuning.
 */
export function featherMask(mask: SelectionMask, radius: number): Uint8Array {
  const bounded = Math.max(0, Math.min(MAX_FEATHER, Math.round(radius)));
  if (bounded === 0) return Uint8Array.from(mask.data);

  const blurred = boxBlur(mask.data, mask.width, mask.height, bounded);
  const result = new Uint8Array(mask.data.length);
  for (let index = 0; index < result.length; index += 1) {
    // Clamp to the drawn mask: no coverage can appear where none was painted.
    result[index] = mask.data[index] === 0 ? 0 : Math.min(mask.data[index], blurred[index]);
  }
  return result;
}

/**
 * Separable box blur, run three times to approximate a gaussian cheaply.
 *
 * The per-pass radius is a THIRD of the requested feather, because three
 * stacked passes reach three times as far. Passing the full radius to each pass
 * made "feather 6" soften roughly 18 pixels — the control would not have meant
 * what it said, and a modest feather would have eaten well into the selection.
 */
function boxBlur(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const perPass = Math.max(1, Math.round(radius / 3));
  const current = Uint8Array.from(source);
  const scratch = new Uint8Array(source.length);
  for (let pass = 0; pass < 3; pass += 1) {
    blurAxis(current, scratch, width, height, perPass, true);
    blurAxis(scratch, current, width, height, perPass, false);
  }
  return current;
}

function blurAxis(
  source: Uint8Array,
  target: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const window = radius * 2 + 1;
  for (let o = 0; o < outer; o += 1) {
    let sum = 0;
    const at = (i: number) => (horizontal ? o * width + i : i * width + o);
    // Prime the running sum, clamping at the edges.
    for (let i = -radius; i <= radius; i += 1) sum += source[at(Math.max(0, Math.min(inner - 1, i)))];
    for (let i = 0; i < inner; i += 1) {
      target[at(i)] = Math.round(sum / window);
      const leaving = source[at(Math.max(0, Math.min(inner - 1, i - radius)))];
      const entering = source[at(Math.max(0, Math.min(inner - 1, i + radius + 1)))];
      sum += entering - leaving;
    }
  }
}

// ─── Mask construction ──────────────────────────────────────────────────────

export function emptyMask(width: number, height: number): SelectionMask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function maskIsEmpty(mask: SelectionMask): boolean {
  return !mask.data.some((value) => value > 0);
}

/** Fraction of the image the mask covers — used to sanity-check a selection. */
export function maskCoverage(mask: SelectionMask): number {
  let covered = 0;
  for (const value of mask.data) if (value > 0) covered += 1;
  return covered / (mask.width * mask.height);
}

/** The tight bounding box of the mask in image space, or null when empty. */
export function maskBounds(
  mask: SelectionMask,
): { x: number; y: number; width: number; height: number } | null {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Decode a grayscale/RGBA mask image into image-space coverage.
 *
 * The editor paints its mask on a canvas at the ASSET's pixel dimensions and
 * ships it as a PNG, so the mask arrives already in image space and needs no
 * scaling guesswork here.
 */
export function maskFromRgba(rgba: Buffer, width: number, height: number): SelectionMask {
  const data = new Uint8Array(width * height);
  for (let pixel = 0; pixel < data.length; pixel += 1) {
    const offset = pixel * 4;
    // Painted with white at partial alpha: either channel expresses coverage.
    data[pixel] = Math.min(255, Math.max(rgba[offset], rgba[offset + 3]));
  }
  return { width, height, data };
}

/**
 * Restore alpha the provider flattened away.
 *
 * Image-edit models routinely return an opaque frame even when handed a
 * transparent one. For a cut-out asset the original alpha is the truth outside
 * the mask, and inside the mask we keep whatever alpha the edit produced only
 * if the edit actually carries one — otherwise the lamp gains a white slab.
 */
export function restoreAlpha(
  composited: Buffer,
  original: Buffer,
  mask: SelectionMask,
  generatedHasAlpha: boolean,
): Buffer {
  const out = Buffer.from(composited);
  for (let pixel = 0; pixel < mask.data.length; pixel += 1) {
    const offset = pixel * 4 + 3;
    if (mask.data[pixel] === 0) {
      out[offset] = original[offset];
      continue;
    }
    if (!generatedHasAlpha) {
      /**
       * The provider gave us no alpha to trust. Inside the mask, an area that
       * WAS transparent stays transparent: a local edit is allowed to repaint
       * the lamp shade, not to fill in the empty space around it.
       */
      out[offset] = original[offset];
    }
  }
  return out;
}
