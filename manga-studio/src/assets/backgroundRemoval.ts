/**
 * Background-removal capability boundary. Generation providers create pixels;
 * background-removal providers turn opaque character/prop sources into layers.
 *
 * The built-in provider intentionally uses bounded, deterministic pixel work
 * that runs with sharp in the Vercel Node runtime. Solid backgrounds use a
 * perimeter flood. Baked checkerboards need a different matte: their two
 * colours can also occur in black-and-white manga art, so we preserve the
 * non-background foreground seeds, close narrow line-art gaps, and retain the
 * largest isolated subject instead of deleting either colour globally.
 */

export type Rgb = [number, number, number];

export interface BackgroundModel {
  kind: "solid" | "checkerboard";
  colors: Rgb[];
}

export interface BackgroundRemovalInput {
  rgba: Buffer;
  width: number;
  height: number;
  background: BackgroundModel;
}

export interface BackgroundRemovalOutput {
  rgba: Buffer;
  method: "edge-flood" | "checkerboard-matte";
  removedPixels: number;
}

export interface BackgroundRemovalProvider {
  readonly id: string;
  removeBackground(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutput>;
}

const STRONG_BACKGROUND_DISTANCE = 32;
const MAX_BACKGROUND_DISTANCE = 88;

export const builtInBackgroundRemovalProvider: BackgroundRemovalProvider = {
  id: "built-in-connectivity",
  async removeBackground(input) {
    return input.background.kind === "checkerboard"
      ? removeCheckerboard(input)
      : removeSolid(input);
  },
};

function removeSolid(input: BackgroundRemovalInput): BackgroundRemovalOutput {
  const rgba = Buffer.from(input.rgba);
  const background = input.background.colors[0];
  const pixelCount = input.width * input.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel: number) => {
    if (visited[pixel]) return;
    const offset = pixel * 4;
    const distance = colorDistance([rgba[offset], rgba[offset + 1], rgba[offset + 2]], background);
    if (distance > MAX_BACKGROUND_DISTANCE) return;
    visited[pixel] = 1;
    queue[tail++] = pixel;
    const feather = Math.max(0, Math.min(1, (distance - STRONG_BACKGROUND_DISTANCE) /
      (MAX_BACKGROUND_DISTANCE - STRONG_BACKGROUND_DISTANCE)));
    rgba[offset + 3] = Math.round(255 * feather);
  };
  enqueuePerimeter(input.width, input.height, enqueue);
  while (head < tail) enqueueNeighbours(queue[head++], input.width, input.height, enqueue);
  return { rgba, method: "edge-flood", removedPixels: tail };
}

function removeCheckerboard(input: BackgroundRemovalInput): BackgroundRemovalOutput {
  const { width, height } = input;
  const pixelCount = width * height;
  const seed = new Uint8Array(pixelCount);
  // JPEG compression perturbs tile colours; this remains well below the
  // separation between the real production checker colours and white art.
  const seedDistance = 54;
  const brightestBackground = Math.max(...input.background.colors.map(luminance));
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const color: Rgb = [input.rgba[offset], input.rgba[offset + 1], input.rgba[offset + 2]];
    const chroma = Math.max(...color) - Math.min(...color);
    const distant = Math.min(...input.background.colors.map((candidate) => colorDistance(color, candidate))) > seedDistance;
    // Checker generators often add grid seams, watermarks, and compression
    // noise in neutral midtones. Those must not become foreground seeds.
    // Bright paper/skin or genuinely chromatic art provides safer evidence;
    // dark linework is recovered from its spatial relationship to that seed.
    if (distant && (luminance(color) > brightestBackground + 28 || chroma > 28)) {
      seed[pixel] = 1;
    }
  }

  // Grid seams, frames, or JPEG ringing that reach the image boundary are
  // background evidence, not part of the isolated subject.
  clearEdgeConnected(seed, width, height);
  const radius = Math.max(2, Math.min(8, Math.round(Math.min(width, height) * 0.006)));
  const closed = erode(dilate(seed, width, height, radius), width, height, radius);
  const subject = largestInteriorComponent(closed, width, height);
  const filledSubject = fillInteriorHoles(subject, width, height);
  // Recover dark outer ink that is indistinguishable from a dark checker tile
  // but lies immediately beside the confidently segmented subject.
  const matte = dilate(filledSubject, width, height, Math.max(1, Math.round(radius / 3)));
  clearPerimeter(matte, width, height);

  const rgba = Buffer.from(input.rgba);
  let removedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const alphaOffset = pixel * 4 + 3;
    if (matte[pixel]) rgba[alphaOffset] = 255;
    else {
      rgba[alphaOffset] = 0;
      removedPixels += 1;
    }
  }
  return { rgba, method: "checkerboard-matte", removedPixels };
}

function clearEdgeConnected(mask: Uint8Array, width: number, height: number): void {
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel: number) => {
    if (!mask[pixel]) return;
    mask[pixel] = 0;
    queue[tail++] = pixel;
  };
  enqueuePerimeter(width, height, enqueue);
  while (head < tail) enqueueNeighbours(queue[head++], width, height, enqueue, true);
}

function largestInteriorComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let best: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let touchesEdge = false;
    const pixels: number[] = [];
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const pixel = queue[head++];
      pixels.push(pixel);
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      enqueueNeighbours(pixel, width, height, (next) => {
        if (mask[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }, true);
    }
    if (!touchesEdge && pixels.length > best.length) best = pixels;
  }
  const result = new Uint8Array(mask.length);
  for (const pixel of best) result[pixel] = 1;
  return result;
}

function fillInteriorHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const exterior = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel: number) => {
    if (mask[pixel] || exterior[pixel]) return;
    exterior[pixel] = 1;
    queue[tail++] = pixel;
  };
  enqueuePerimeter(width, height, enqueue);
  while (head < tail) enqueueNeighbours(queue[head++], width, height, enqueue, true);
  const result = new Uint8Array(mask.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) result[pixel] = mask[pixel] || !exterior[pixel] ? 1 : 0;
  return result;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return neighbourhood(mask, width, height, radius, true);
}

function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return neighbourhood(mask, width, height, radius, false);
}

/** Separable max/min filter keeps work bounded at O(width × height × radius). */
function neighbourhood(mask: Uint8Array, width: number, height: number, radius: number, maximum: boolean): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = maximum ? 0 : 1;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sample = x + dx;
        const current = sample >= 0 && sample < width ? mask[y * width + sample] : 0;
        value = maximum ? Math.max(value, current) : Math.min(value, current);
        if (value === Number(maximum)) break;
      }
      horizontal[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = maximum ? 0 : 1;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sample = y + dy;
        const current = sample >= 0 && sample < height ? horizontal[sample * width + x] : 0;
        value = maximum ? Math.max(value, current) : Math.min(value, current);
        if (value === Number(maximum)) break;
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function clearPerimeter(mask: Uint8Array, width: number, height: number): void {
  for (let x = 0; x < width; x += 1) {
    mask[x] = 0;
    mask[(height - 1) * width + x] = 0;
  }
  for (let y = 0; y < height; y += 1) {
    mask[y * width] = 0;
    mask[y * width + width - 1] = 0;
  }
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
  diagonals = false,
): void {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  if (x > 0) enqueue(pixel - 1);
  if (x + 1 < width) enqueue(pixel + 1);
  if (y > 0) enqueue(pixel - width);
  if (y + 1 < height) enqueue(pixel + width);
  if (!diagonals) return;
  if (x > 0 && y > 0) enqueue(pixel - width - 1);
  if (x + 1 < width && y > 0) enqueue(pixel - width + 1);
  if (x > 0 && y + 1 < height) enqueue(pixel + width - 1);
  if (x + 1 < width && y + 1 < height) enqueue(pixel + width + 1);
}

export function colorDistance(a: Rgb, b: Rgb): number {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function luminance(color: Rgb): number {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}
