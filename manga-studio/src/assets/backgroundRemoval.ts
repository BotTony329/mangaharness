/**
 * Background-removal capability boundary. Generation providers create pixels;
 * background-removal providers turn opaque character/prop sources into layers.
 *
 * The built-in provider is a single deterministic algorithm: a perimeter flood
 * that keys out every pixel reachable from the image border whose colour
 * matches the estimated background model. Everything the flood cannot reach
 * stays opaque, which is what preserves enclosed foreground whites — eyes,
 * white clothing, paper-white skin, and the interiors of closed line art. It
 * is deliberately NOT a global colour replacement: "make near-white
 * transparent" would destroy exactly those regions.
 *
 * One flood handles every background model. A solid field, a baked
 * transparency checkerboard, and a chroma-key screen differ only in how many
 * colours count as background and how much tolerance is safe; the traversal is
 * identical, so there is no second code path to drift.
 */

import { decontaminateMatteEdges, type DecontaminationStats } from "./matteDecontamination";

export type Rgb = [number, number, number];

export interface BackgroundModel {
  kind: "solid" | "checkerboard" | "chroma-key";
  colors: Rgb[];
}

export interface BackgroundRemovalInput {
  rgba: Buffer;
  width: number;
  height: number;
  background: BackgroundModel;
}

export type BackgroundRemovalMethod = "edge-flood" | "checkerboard-matte" | "chroma-key";

export interface BackgroundRemovalOutput {
  rgba: Buffer;
  method: BackgroundRemovalMethod;
  removedPixels: number;
  /** What edge decontamination did, for diagnostics and tests. */
  decontamination?: DecontaminationStats;
}

export interface BackgroundRemovalProvider {
  readonly id: string;
  removeBackground(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutput>;
}

/**
 * Tolerances per background model.
 *
 * `strong` — at or below this distance a pixel is unambiguously background
 * (alpha 0). `max` — beyond this a pixel is foreground and the flood stops,
 * so it also bounds how far the background can bleed into artwork. Between
 * them alpha ramps, which is what keeps anti-aliased line art from acquiring a
 * hard jagged edge.
 */
interface Tolerance {
  strong: number;
  max: number;
}

function toleranceFor(background: BackgroundModel): Tolerance {
  // A saturated key sits far from ink, paper, and skin, so a wide band is safe
  // and absorbs JPEG ringing around the silhouette.
  if (background.kind === "chroma-key") return { strong: 62, max: 118 };
  return { strong: 32, max: 88 };
}

/**
 * Distance from a colour to the background model.
 *
 * Measured to the SEGMENT between background colours, not merely to each
 * colour. Anti-aliased and JPEG-blurred pixels along a checkerboard tile seam
 * are blends of the two tile colours, so they lie on that segment and stay
 * within tolerance; without this the seams form walls the flood cannot cross
 * and the background survives as a grid of unreachable squares. Widening the
 * radius instead would bridge the seams but also swallow artwork — a mid-tone
 * skin fill sits closer to a light tile than the tiles sit to each other.
 */
function distanceToModel(color: Rgb, colors: Rgb[]): number {
  let nearest = Infinity;
  for (const candidate of colors) nearest = Math.min(nearest, colorDistance(color, candidate));
  for (let a = 0; a < colors.length; a += 1) {
    for (let b = a + 1; b < colors.length; b += 1) {
      nearest = Math.min(nearest, distanceToSegment(color, colors[a], colors[b]));
    }
  }
  return nearest;
}

function distanceToSegment(point: Rgb, start: Rgb, end: Rgb): number {
  const axis: Rgb = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const lengthSquared = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
  if (lengthSquared === 0) return colorDistance(point, start);
  const offset: Rgb = [point[0] - start[0], point[1] - start[1], point[2] - start[2]];
  const raw = (offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]) / lengthSquared;
  const t = Math.max(0, Math.min(1, raw));
  return colorDistance(point, [start[0] + axis[0] * t, start[1] + axis[1] * t, start[2] + axis[2] * t]);
}

export const builtInBackgroundRemovalProvider: BackgroundRemovalProvider = {
  id: "built-in-connectivity",
  async removeBackground(input) {
    return floodKeyBackground(input);
  },
};

function methodFor(kind: BackgroundModel["kind"]): BackgroundRemovalMethod {
  if (kind === "checkerboard") return "checkerboard-matte";
  if (kind === "chroma-key") return "chroma-key";
  return "edge-flood";
}

/**
 * Flood the background inward from the image border.
 *
 * Only perimeter-connected pixels are considered, so a white shirt enclosed by
 * ink keeps its alpha even though its colour matches a white background
 * exactly. Distance is measured to the NEAREST background colour, which is why
 * a two-tone checkerboard needs no special casing.
 */
function floodKeyBackground(input: BackgroundRemovalInput): BackgroundRemovalOutput {
  const { width, height, background } = input;
  const rgba = Buffer.from(input.rgba);
  const { strong, max } = toleranceFor(background);
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const distanceToBackground = (pixel: number): number => {
    const offset = pixel * 4;
    return distanceToModel([rgba[offset], rgba[offset + 1], rgba[offset + 2]], background.colors);
  };

  const enqueue = (pixel: number) => {
    if (visited[pixel]) return;
    const distance = distanceToBackground(pixel);
    if (distance > max) return;
    visited[pixel] = 1;
    queue[tail++] = pixel;
    const ramp = Math.max(0, Math.min(1, (distance - strong) / (max - strong)));
    rgba[pixel * 4 + 3] = Math.round(255 * ramp);
  };

  enqueuePerimeter(width, height, enqueue);
  while (head < tail) enqueueNeighbours(queue[head++], width, height, enqueue);

  /**
   * Segmentation is only half the job.
   *
   * The rim pixels the flood correctly refused to key out are real alpha blends
   * of foreground over the matte, so their RGB still carries matte colour. Left
   * as-is, straight-alpha output reproduces that as a coloured halo the moment
   * it is composited. Un-mixing happens here, on every background model — a
   * white matte haloes dark artwork exactly as a magenta one haloes everything.
   */
  const decontamination = decontaminateMatteEdges({
    rgba,
    width,
    height,
    matteColors: background.colors,
    background: visited,
  });

  let removedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (rgba[pixel * 4 + 3] < 128) removedPixels += 1;
  }
  return { rgba, method: methodFor(background.kind), removedPixels, decontamination };
}

function enqueuePerimeter(width: number, height: number, enqueue: (pixel: number) => void): void {
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
}

function enqueueNeighbours(
  pixel: number,
  width: number,
  height: number,
  enqueue: (pixel: number) => void,
): void {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  if (x > 0) enqueue(pixel - 1);
  if (x + 1 < width) enqueue(pixel + 1);
  if (y > 0) enqueue(pixel - width);
  if (y + 1 < height) enqueue(pixel + width);
}

export function colorDistance(a: Rgb, b: Rgb): number {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

export function luminance(color: Rgb): number {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}

export function chroma(color: Rgb): number {
  return Math.max(...color) - Math.min(...color);
}

/**
 * Estimate what the background is by sampling the image border.
 *
 * The perimeter is walked as a real ring (top → right → bottom → left) rather
 * than as interleaved opposite edges, because the checkerboard test counts
 * colour transitions between ADJACENT samples. Sampling top(x) then bottom(x)
 * alternately compares pixels on opposite sides of the image, which measures
 * nothing about tiling.
 */
export function estimateEdgeBackground(data: Buffer, width: number, height: number): BackgroundModel | null {
  const ring: Rgb[] = [];
  const bins = new Map<string, { count: number; values: Rgb[] }>();
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    const value: Rgb = [data[offset], data[offset + 1], data[offset + 2]];
    ring.push(value);
    const key = `${value[0] >> 4}:${value[1] >> 4}:${value[2] >> 4}`;
    const bin = bins.get(key) ?? { count: 0, values: [] };
    bin.count += 1;
    bin.values.push(value);
    bins.set(key, bin);
  };
  for (let x = 0; x < width; x += 1) add(x, 0);
  for (let y = 1; y < height; y += 1) add(width - 1, y);
  for (let x = width - 2; x >= 0; x -= 1) add(x, height - 1);
  for (let y = height - 2; y >= 1; y -= 1) add(0, y);

  const ranked = [...bins.values()].sort((a, b) => b.count - a.count);
  const dominant = ranked[0];
  if (!dominant) return null;
  const primary = medianColor(dominant.values);
  const dominantShare = dominant.count / ring.length;

  // A deliberate chroma-key screen is one saturated colour over most of the
  // border. Detected first: it is the only model whose colour cannot be
  // confused with ink or paper, so it earns the widest tolerance.
  if (dominantShare > 0.55 && chroma(primary) > 60) {
    return { kind: "chroma-key", colors: [primary] };
  }

  // A two-tone border — a transparency checkerboard, but equally a tiled or
  // split backdrop. Detection is by colour SHARE, not by spatial alternation:
  // a 16px checker on a 400px edge produces only ~6% adjacent-sample
  // transitions, so a tiling test rejects the very case it exists to catch,
  // and the second tile colour then blocks the flood as an unreachable grid.
  // Both tones being background is all the flood needs to know.
  const second = ranked[1];
  if (second) {
    const secondary = medianColor(second.values);
    const combinedShare = (dominant.count + second.count) / ring.length;
    const secondShare = second.count / ring.length;
    if (combinedShare > 0.7 && secondShare > 0.15 && colorDistance(primary, secondary) > 40) {
      return { kind: "checkerboard", colors: [primary, secondary] };
    }
  }

  if (dominantShare < 0.28) return null;
  return { kind: "solid", colors: [primary] };
}

function medianColor(values: Rgb[]): Rgb {
  const channel = (index: number) =>
    values.map((value) => value[index]).sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return [channel(0), channel(1), channel(2)];
}

/**
 * Does this look like the pure-white backdrop the policy asked for?
 *
 * Checked BEFORE extraction. A provider that ignored the contract and returned
 * a coloured, textured or gradient backdrop must not be quietly keyed out: the
 * result would carry that colour into every edge pixel, which is the failure
 * the white policy exists to prevent. Better to fail loudly and let the
 * creator regenerate.
 *
 * Tolerant of anti-aliasing, JPEG ringing and slightly off-white paper — it is
 * checking for a *violation*, not grading whiteness.
 */
export interface WhiteBackgroundVerdict {
  valid: boolean;
  /** The colour actually found at the border. */
  measured: Rgb;
  reason?: string;
}

/** Minimum luminance for a border colour to read as white paper rather than a tone. */
const WHITE_MIN_LUMINANCE = 208;
/** Above this saturation the backdrop is a colour, not white. */
const WHITE_MAX_CHROMA = 34;
/** Border variation above this means texture or a gradient rather than a flat field. */
const WHITE_MAX_SPREAD = 46;

export function validateWhiteBackground(data: Buffer, width: number, height: number): WhiteBackgroundVerdict {
  const samples: Rgb[] = [];
  const push = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    // A fully transparent border is a provider cutout, not a white field.
    if (data[offset + 3] === 0) return;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  const step = Math.max(1, Math.floor(Math.max(width, height) / 128));
  for (let x = 0; x < width; x += step) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = step; y < height - 1; y += step) {
    push(0, y);
    push(width - 1, y);
  }
  if (samples.length === 0) {
    return { valid: true, measured: [255, 255, 255] };
  }

  const median = (index: number) =>
    samples.map((sample) => sample[index]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const measured: Rgb = [median(0), median(1), median(2)];

  if (chroma(measured) > WHITE_MAX_CHROMA) {
    return { valid: false, measured, reason: describeBackdrop(measured) };
  }
  if (luminance(measured) < WHITE_MIN_LUMINANCE) {
    return { valid: false, measured, reason: "The generated background is grey or dark rather than white." };
  }
  const spread = median3(samples.map((sample) => colorDistance(sample, measured)));
  if (spread > WHITE_MAX_SPREAD) {
    return { valid: false, measured, reason: "The generated background is textured or a gradient rather than flat white." };
  }
  return { valid: true, measured };
}

/** Name the colour a creator can see, so the message is actionable. */
function describeBackdrop(color: Rgb): string {
  const [red, green, blue] = color;
  const name =
    red > green && blue > green
      ? "purple/magenta"
      : green > red && green > blue
        ? "green"
        : blue > red && blue > green
          ? "blue"
          : red > green && red > blue
            ? "red/orange"
            : "coloured";
  return `The generated background is ${name} rather than white, so extracting it would tint the artwork's edges.`;
}

function median3(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

