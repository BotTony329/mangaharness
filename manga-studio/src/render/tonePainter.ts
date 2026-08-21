/**
 * Drawing a screentone from its parameters.
 *
 * Deliberately framework-free: it takes a 2D-ish context and numbers, so the
 * same code paints the editor canvas, the export at 2x, and a swatch in the
 * library. One painter means the thumbnail cannot lie about what you will get.
 *
 * ## Resolution
 *
 * Everything here draws in the item's own coordinate space. The caller has
 * already scaled the context by the export pixel ratio, so a 26/100px dot grid
 * is computed once and rendered at whatever resolution the output needs — the
 * dots stay round and separate instead of being resampled into grey mush. This
 * is the moiré protection that matters: there is no source bitmap to beat
 * against the output grid, because there is no source bitmap.
 *
 * ## Ink
 *
 * Tone is BLACK (§14). Coverage, not greyness, is what makes a 30% tone read as
 * 30% — a grey wash at 30% opacity prints as mud and cannot be halftoned later.
 * Opacity is a layer property the creator sets deliberately; it is not how the
 * pattern itself is built.
 */

import type { ProceduralToneParams } from "@/domain/tones";

/** The subset of CanvasRenderingContext2D the painter needs. */
export interface ToneContext {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
}

export const TONE_INK = "#000000";

/** Repeats per 100px → distance between repeats, in item units. */
export function spacingFor(frequency: number): number {
  return 100 / Math.max(1, frequency);
}

/**
 * Dot radius for a target coverage.
 *
 * Area of one dot over the area of one grid cell: πr²/s² = density. Solving for
 * r is what makes "Dot 30%" mean thirty percent ink rather than a label someone
 * chose. Capped at half the spacing, past which neighbouring dots merge and
 * coverage stops tracking the number.
 */
export function dotRadiusFor(spacing: number, density: number): number {
  const ideal = spacing * Math.sqrt(Math.max(0, density) / Math.PI);
  return Math.min(spacing * 0.5, ideal);
}

/** Stable hash noise — Math.random would repaint differently every frame. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Paint a procedural tone filling `w × h` in item space.
 *
 * The pattern is drawn on a rotated grid that overshoots the box on every side,
 * so rotating a tone never reveals an unpainted corner.
 */
export function paintTone(ctx: ToneContext, w: number, h: number, params: ProceduralToneParams): void {
  if (w <= 0 || h <= 0 || params.density <= 0) return;
  const spacing = spacingFor(params.frequency);
  // The rotated grid must cover the box's diagonal in both directions.
  const reach = Math.hypot(w, h) / 2 + spacing * 2;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((params.angle * Math.PI) / 180);
  ctx.fillStyle = TONE_INK;
  ctx.strokeStyle = TONE_INK;

  switch (params.type) {
    case "dot":
      paintDotField(ctx, reach, spacing, () => params.density);
      break;
    case "gradient": {
      /**
       * A manga gradient is a DOT gradient: the dots grow along the axis rather
       * than the ink fading to grey. Fading opacity instead would produce a
       * grey wash that no longer halftones, which is precisely the thing tone
       * exists to avoid.
       */
      const span = reach * 2;
      paintDotField(ctx, reach, spacing, (_x, y) => {
        const t = (y + reach) / span;
        return params.density * (1 - t);
      });
      break;
    }
    case "noise":
      paintNoiseField(ctx, reach, spacing, params.density);
      break;
    case "line":
      paintLineField(ctx, reach, spacing, params.density);
      break;
    case "cross-hatch":
      paintLineField(ctx, reach, spacing, params.density / 2);
      ctx.rotate(Math.PI / 2);
      paintLineField(ctx, reach, spacing, params.density / 2);
      break;
  }

  ctx.restore();
}

/** Dots on a staggered grid; `densityAt` allows a gradient across the field. */
function paintDotField(
  ctx: ToneContext,
  reach: number,
  spacing: number,
  densityAt: (x: number, y: number) => number,
): void {
  let row = 0;
  for (let y = -reach; y <= reach; y += spacing) {
    // Every other row is offset half a step — the classic halftone lattice.
    const offset = (row % 2) * (spacing / 2);
    for (let x = -reach; x <= reach; x += spacing) {
      const radius = dotRadiusFor(spacing, densityAt(x, y));
      if (radius <= 0.05) continue;
      ctx.beginPath();
      ctx.arc(x + offset, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    row += 1;
  }
}

/**
 * Irregular grain.
 *
 * Positions and sizes are jittered from a stable hash so the texture does not
 * read as a grid — but it repaints identically every frame and exports exactly
 * as it appears on screen.
 */
function paintNoiseField(ctx: ToneContext, reach: number, spacing: number, density: number): void {
  const radius = dotRadiusFor(spacing, density);
  if (radius <= 0.05) return;
  let seed = 0;
  for (let y = -reach; y <= reach; y += spacing) {
    for (let x = -reach; x <= reach; x += spacing) {
      seed += 1;
      const jx = (pseudoRandom(seed) - 0.5) * spacing;
      const jy = (pseudoRandom(seed * 3.7) - 0.5) * spacing;
      const size = radius * (0.5 + pseudoRandom(seed * 7.1));
      ctx.beginPath();
      ctx.arc(x + jx, y + jy, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Parallel lines whose width is the coverage fraction of the spacing. */
function paintLineField(ctx: ToneContext, reach: number, spacing: number, density: number): void {
  const width = spacing * Math.min(1, Math.max(0, density));
  if (width <= 0.02) return;
  for (let y = -reach; y <= reach; y += spacing) {
    // Drawn as filled rects rather than strokes: a stroke centres on the path
    // and its width is affected by line joins, so coverage would drift.
    ctx.fillRect(-reach, y - width / 2, reach * 2, width);
  }
}

/**
 * Paint an image tone.
 *
 * Tileable images REPEAT at `scale`; the scale dial changes pattern size, not
 * how far a single copy is stretched. A non-tileable one (a decorative sticker,
 * a one-off generated texture) is fitted to the box instead, because repeating
 * a picture of falling petals produces a visible seam grid.
 */
export function paintImageTone(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  w: number,
  h: number,
  options: { tileable: boolean; scale: number; naturalWidth: number; naturalHeight: number },
): void {
  const scale = Math.max(0.05, options.scale);
  if (!options.tileable) {
    ctx.drawImage(image, 0, 0, w, h);
    return;
  }
  const tileW = Math.max(1, options.naturalWidth * scale);
  const tileH = Math.max(1, options.naturalHeight * scale);
  for (let y = 0; y < h; y += tileH) {
    for (let x = 0; x < w; x += tileW) {
      ctx.drawImage(image, x, y, tileW, tileH);
    }
  }
}
