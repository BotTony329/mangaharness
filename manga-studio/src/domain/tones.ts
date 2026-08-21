/**
 * Screentone: the manga grammar of shading, mood and texture.
 *
 * ## The one rule
 *
 * TONE IS A NON-DESTRUCTIVE LAYER. A tone never touches the pixels of the
 * character, scene or object it sits over. Hiding the tone returns the artwork
 * exactly as it was, because the artwork was never changed — the tone is a
 * separate item in the panel's layer stack that happens to be drawn on top.
 *
 * ## Why procedural tones are not images
 *
 * A screentone is a PATTERN, not a picture. Storing "40 dots per 100px at 45°,
 * 30% coverage" and drawing it at output resolution keeps the dots circular and
 * crisp at any export scale. Storing a bitmap of that same pattern and scaling
 * it produces the two classic failures: soft grey mush where the dots were, and
 * moiré where the sampling grid beats against the dot grid. So the document
 * stores PARAMETERS and the renderer draws from them — the same contract the
 * existing procedural effects already keep.
 *
 * Generated and uploaded tones ARE images: a rain texture or a flower pattern
 * is not describable as density and angle. Those keep the transform-and-tile
 * path instead. Both kinds are ordinary reusable library material.
 */

import type { ID } from "./types";

// ─── What a tone IS ─────────────────────────────────────────────────────────

/** Patterns the renderer can draw from parameters alone. */
export type ProceduralToneType = "dot" | "line" | "cross-hatch" | "gradient" | "noise";

/** Every tone kind, including the ones that can only be images. */
export type ToneType = ProceduralToneType | "texture" | "decorative";

export type ToneSource = "procedural" | "generated" | "uploaded";

/**
 * Creator-facing shelves. These group by WHAT THE TONE IS FOR, which is how a
 * creator looks for one — nobody browses for "45 degrees, 30 percent".
 */
export type ToneFamily =
  | "basic"
  | "gradient"
  | "hatching"
  | "noise"
  | "dark-mood"
  | "romance"
  | "speed"
  | "impact"
  | "decorative";

export const TONE_FAMILIES: ToneFamily[] = [
  "basic",
  "gradient",
  "hatching",
  "noise",
  "dark-mood",
  "romance",
  "speed",
  "impact",
  "decorative",
];

export const TONE_FAMILY_LABELS: Record<ToneFamily, string> = {
  basic: "Basic",
  gradient: "Gradient",
  hatching: "Hatching",
  noise: "Noise",
  "dark-mood": "Dark Mood",
  romance: "Romance",
  speed: "Speed",
  impact: "Impact",
  decorative: "Decorative",
};

/**
 * A procedural pattern's three dials, in creator terms.
 *
 * - `density` is COVERAGE: what fraction of the area is ink. "Dot 30%" is
 *   literally density 0.3, which is why the presets can be named after it.
 * - `frequency` is how FINE the pattern is — repeats per 100px. Higher is
 *   finer. This is the dial that must never be faked by scaling a bitmap.
 * - `angle` is the screen angle in degrees, the traditional way tones are
 *   distinguished so two overlapping tones do not beat against each other.
 */
export interface ProceduralToneParams {
  type: ProceduralToneType;
  density: number;
  frequency: number;
  angle: number;
}

export const DEFAULT_PROCEDURAL: ProceduralToneParams = {
  type: "dot",
  density: 0.3,
  frequency: 26,
  angle: 45,
};

export const FREQUENCY_RANGE = { min: 6, max: 80 } as const;

// ─── Masking ────────────────────────────────────────────────────────────────

/**
 * Where a tone is allowed to appear, in NORMALIZED panel space (0..1).
 *
 * Normalized rather than pixels so a mask survives the panel being resized or
 * the page being exported at 2x — the shirt stays the shirt. Shapes are stored
 * rather than a rasterized bitmap for the same reason procedural tones store
 * parameters: a stored bitmap can only ever be resampled.
 */
export type ToneMaskShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  /** A brush stroke: a polyline, thickened by `radius` (also normalized). */
  | { kind: "stroke"; radius: number; points: number[] };

export interface ToneMask {
  shapes: ToneMaskShape[];
}

export function maskIsEmpty(mask: ToneMask | undefined): boolean {
  if (!mask) return true;
  return mask.shapes.every((shape) => (shape.kind === "stroke" ? shape.points.length < 2 : shape.width <= 0 || shape.height <= 0));
}

// ─── The item ───────────────────────────────────────────────────────────────

/**
 * What a tone layer references.
 *
 * Procedural tones carry their parameters INLINE rather than pointing at a
 * preset, so editing density on one panel cannot silently change every other
 * panel that used the same preset. `presetId` is kept only to say where it came
 * from. Image tones point at an ordinary library asset.
 */
export type ToneRef =
  | { source: "procedural"; presetId?: string; params: ProceduralToneParams }
  | { source: "asset"; assetId: ID; tileable: boolean };

// ─── Presets ────────────────────────────────────────────────────────────────

export interface TonePreset {
  id: string;
  name: string;
  family: ToneFamily;
  params: ProceduralToneParams;
  /** One line of what it is FOR, shown on hover. */
  use: string;
}

/**
 * The tones a creator can use on day one, with no AI and no upload.
 *
 * The percentages are real coverage values, not labels: "Dot 30%" draws dots
 * sized so that thirty percent of the area is ink, which is what a creator
 * reaching for a 30% tone expects to get.
 */
export const TONE_PRESETS: TonePreset[] = [
  { id: "dot-10", name: "Dot 10%", family: "basic", use: "The lightest shading — a hint of grey", params: { type: "dot", density: 0.1, frequency: 26, angle: 45 } },
  { id: "dot-20", name: "Dot 20%", family: "basic", use: "Soft shading on skin and light fabric", params: { type: "dot", density: 0.2, frequency: 26, angle: 45 } },
  { id: "dot-30", name: "Dot 30%", family: "basic", use: "The everyday mid-grey — clothing and shadow", params: { type: "dot", density: 0.3, frequency: 26, angle: 45 } },
  { id: "dot-40", name: "Dot 40%", family: "basic", use: "Darker fabric and deeper shadow", params: { type: "dot", density: 0.4, frequency: 26, angle: 45 } },
  { id: "dot-50", name: "Dot 50%", family: "basic", use: "Halfway to black", params: { type: "dot", density: 0.5, frequency: 26, angle: 45 } },
  { id: "dot-fine", name: "Fine Dot", family: "basic", use: "Smooth grey that reads as flat tone", params: { type: "dot", density: 0.3, frequency: 52, angle: 45 } },
  { id: "dot-coarse", name: "Coarse Dot", family: "basic", use: "Visible dots — retro and graphic", params: { type: "dot", density: 0.3, frequency: 12, angle: 45 } },

  { id: "lines-horizontal", name: "Horizontal Lines", family: "hatching", use: "Calm, flat shading", params: { type: "line", density: 0.35, frequency: 22, angle: 0 } },
  { id: "lines-diagonal", name: "Diagonal Lines", family: "hatching", use: "Movement and unease", params: { type: "line", density: 0.35, frequency: 22, angle: 45 } },
  { id: "lines-vertical", name: "Vertical Lines", family: "hatching", use: "Stillness, rain, falling light", params: { type: "line", density: 0.35, frequency: 22, angle: 90 } },
  { id: "cross-hatch", name: "Cross Hatch", family: "hatching", use: "Dense shadow with visible drawing", params: { type: "cross-hatch", density: 0.3, frequency: 20, angle: 45 } },

  { id: "gradient-light", name: "Light Gradient", family: "gradient", use: "Fades away to nothing", params: { type: "gradient", density: 0.35, frequency: 28, angle: 90 } },
  { id: "gradient-dark", name: "Dark Gradient", family: "gradient", use: "Heavy at one edge — depth and weight", params: { type: "gradient", density: 0.7, frequency: 28, angle: 90 } },

  { id: "noise-light", name: "Light Noise", family: "noise", use: "Grain and texture without pattern", params: { type: "noise", density: 0.18, frequency: 40, angle: 0 } },
  { id: "noise-heavy", name: "Heavy Noise", family: "noise", use: "Rough, dirty, analogue", params: { type: "noise", density: 0.45, frequency: 40, angle: 0 } },

  { id: "gloom", name: "Gloom", family: "dark-mood", use: "Dread settling over the panel", params: { type: "gradient", density: 0.85, frequency: 18, angle: 270 } },
  { id: "anxiety-hatch", name: "Anxiety Hatch", family: "dark-mood", use: "Tight vertical hatching — panic", params: { type: "line", density: 0.5, frequency: 46, angle: 90 } },
  { id: "darkness", name: "Darkness", family: "dark-mood", use: "Near-solid — night, or losing consciousness", params: { type: "dot", density: 0.75, frequency: 30, angle: 45 } },

  { id: "speed-diagonal", name: "Speed Lines", family: "speed", use: "Motion across the panel", params: { type: "line", density: 0.22, frequency: 34, angle: 22 } },
  { id: "impact-dense", name: "Impact Hatch", family: "impact", use: "The frame of a hit landing", params: { type: "cross-hatch", density: 0.55, frequency: 34, angle: 30 } },
];

export function tonePreset(id: string): TonePreset | undefined {
  return TONE_PRESETS.find((preset) => preset.id === id);
}

export function presetsInFamily(family: ToneFamily): TonePreset[] {
  return TONE_PRESETS.filter((preset) => preset.family === family);
}

// ─── Coercion ───────────────────────────────────────────────────────────────

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce stored parameters into the typed shape.
 *
 * A document written by an older build — or a newer one with dials this build
 * has never heard of — must still open with a usable tone rather than throw.
 */
export function normalizeToneParams(params: unknown): ProceduralToneParams {
  const raw = (params ?? {}) as Record<string, unknown>;
  const types: ProceduralToneType[] = ["dot", "line", "cross-hatch", "gradient", "noise"];
  const type = types.includes(raw.type as ProceduralToneType) ? (raw.type as ProceduralToneType) : DEFAULT_PROCEDURAL.type;
  return {
    type,
    density: clamp(raw.density, 0, 1, DEFAULT_PROCEDURAL.density),
    frequency: clamp(raw.frequency, FREQUENCY_RANGE.min, FREQUENCY_RANGE.max, DEFAULT_PROCEDURAL.frequency),
    // Angles wrap; 190° and -170° are the same screen angle.
    angle: ((clamp(raw.angle, -3600, 3600, DEFAULT_PROCEDURAL.angle) % 180) + 180) % 180,
  };
}

// ─── Moiré ──────────────────────────────────────────────────────────────────

/** Two dot tones at nearly the same screen angle beat against each other. */
export const MOIRE_ANGLE_TOLERANCE = 12;

/**
 * Does laying `b` over `a` risk moiré?
 *
 * Traditional practice separates overlapping dot screens by 30°, and the
 * failure case is two DIFFERENT dot grids at nearly the same angle — identical
 * tones stack cleanly, which is why matching frequency is explicitly fine.
 * This is a warning, not a block: a creator is allowed to want the effect.
 */
export function moireRisk(a: ProceduralToneParams, b: ProceduralToneParams): boolean {
  const patterned = (params: ProceduralToneParams) => params.type === "dot" || params.type === "cross-hatch" || params.type === "line";
  if (!patterned(a) || !patterned(b)) return false;
  const difference = Math.abs(((a.angle - b.angle) % 180 + 180) % 180);
  const separation = Math.min(difference, 180 - difference);
  if (separation > MOIRE_ANGLE_TOLERANCE) return false;
  // Same grid at the same angle simply stacks — it is a darker tone, not moiré.
  return Math.abs(a.frequency - b.frequency) > 1;
}
