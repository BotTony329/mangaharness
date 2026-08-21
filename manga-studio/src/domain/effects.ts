/**
 * Manga effects as structured, editable objects (§15).
 *
 * Effect lines are authored objects in professional manga tools, not flattened
 * decoration — so they are never baked into a generated image and never lose
 * their parameters after creation. Every effect stays adjustable for the life
 * of the document.
 *
 * Params are typed per kind. The pre-existing loose `Record<string, number |
 * string | boolean>` is normalized into these shapes by migration, and
 * `normalizeEffectParams` tolerates partial or unknown input so an older
 * document can never fail to open.
 */

import type { EffectKind, Point } from "./types";

export interface SpeedLinesParams {
  /** Radians. 0 points right; positive turns clockwise on screen. */
  direction: number;
  density: number;
  length: number;
  spread: number;
  intensity: number;
}

export interface FocusLinesParams {
  /** Normalized within the effect's own box. */
  focalPoint: Point;
  density: number;
  radius: number;
  intensity: number;
}

export interface ImpactBurstParams {
  focalPoint: Point;
  spikes: number;
  irregularity: number;
  intensity: number;
}

export interface ScreentoneParams {
  dotSize: number;
  spacing: number;
  angle: number;
  intensity: number;
}

export interface EmotionEffectParams {
  emotion: "sweat" | "anger" | "shock" | "sparkle" | "gloom";
  intensity: number;
}

export type EffectParams =
  | ({ kind: "speed-lines" } & SpeedLinesParams)
  | ({ kind: "focus-lines" } & FocusLinesParams)
  | ({ kind: "impact-burst" } & ImpactBurstParams)
  | ({ kind: "screentone" } & ScreentoneParams)
  | ({ kind: "emotion" } & EmotionEffectParams);

export const EFFECT_KINDS: EffectKind[] = ["speed-lines", "focus-lines", "screentone", "impact-burst", "emotion"];

export function defaultEffectParams(kind: EffectKind): EffectParams {
  switch (kind) {
    case "speed-lines":
      return { kind, direction: 0, density: 0.5, length: 0.7, spread: 0.25, intensity: 0.8 };
    case "focus-lines":
      return { kind, focalPoint: { x: 0.5, y: 0.5 }, density: 0.6, radius: 0.35, intensity: 0.8 };
    case "impact-burst":
      return { kind, focalPoint: { x: 0.5, y: 0.5 }, spikes: 16, irregularity: 0.35, intensity: 0.9 };
    case "screentone":
      return { kind, dotSize: 0.35, spacing: 0.5, angle: Math.PI / 4, intensity: 0.6 };
    case "emotion":
      return { kind, emotion: "sweat", intensity: 0.8 };
  }
}

type LooseParams = Record<string, unknown> | undefined;

/**
 * Coerce arbitrary stored params into the typed shape for a kind.
 *
 * Every field falls back to its default, so a document written before effects
 * were typed — or by a newer build with fields this one does not know — still
 * opens with a usable effect rather than an exception.
 */
export function normalizeEffectParams(kind: EffectKind, params: LooseParams): EffectParams {
  const base = defaultEffectParams(kind);
  if (!params) return base;
  switch (base.kind) {
    case "speed-lines":
      return {
        kind: base.kind,
        direction: num(params.direction, base.direction),
        density: unit(params.density, base.density),
        length: unit(params.length, base.length),
        spread: unit(params.spread, base.spread),
        intensity: unit(params.intensity, base.intensity),
      };
    case "focus-lines":
      return {
        kind: base.kind,
        focalPoint: point(params.focalPoint, base.focalPoint),
        density: unit(params.density, base.density),
        radius: unit(params.radius, base.radius),
        intensity: unit(params.intensity, base.intensity),
      };
    case "impact-burst":
      return {
        kind: base.kind,
        focalPoint: point(params.focalPoint, base.focalPoint),
        spikes: Math.max(3, Math.round(num(params.spikes, base.spikes))),
        irregularity: unit(params.irregularity, base.irregularity),
        intensity: unit(params.intensity, base.intensity),
      };
    case "screentone":
      return {
        kind: base.kind,
        dotSize: unit(params.dotSize, base.dotSize),
        spacing: unit(params.spacing, base.spacing),
        angle: num(params.angle, base.angle),
        intensity: unit(params.intensity, base.intensity),
      };
    case "emotion": {
      const emotion = params.emotion;
      const allowed: EmotionEffectParams["emotion"][] = ["sweat", "anger", "shock", "sparkle", "gloom"];
      return {
        kind: base.kind,
        emotion: allowed.includes(emotion as EmotionEffectParams["emotion"])
          ? (emotion as EmotionEffectParams["emotion"])
          : base.emotion,
        intensity: unit(params.intensity, base.intensity),
      };
    }
  }
}

/** Apply a partial edit, keeping the effect valid. */
export function updateEffectParams(current: EffectParams, patch: Record<string, unknown>): EffectParams {
  return normalizeEffectParams(current.kind, { ...(current as unknown as Record<string, unknown>), ...patch });
}

/**
 * Suggest a speed-line direction from a subject's motion intent (§16).
 *
 * Returns null when the pose carries no motion, so an attached effect keeps
 * whatever the creator set rather than snapping to an arbitrary angle.
 */
export function suggestSpeedLineDirection(motion: { x: number; y: number }): number | null {
  if (Math.abs(motion.x) < 0.01 && Math.abs(motion.y) < 0.01) return null;
  return Math.atan2(motion.y, motion.x);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unit(value: unknown, fallback: number): number {
  const raw = num(value, fallback);
  return Math.max(0, Math.min(1, raw));
}

function point(value: unknown, fallback: Point): Point {
  if (value && typeof value === "object") {
    const candidate = value as Partial<Point>;
    if (typeof candidate.x === "number" && typeof candidate.y === "number") {
      return { x: candidate.x, y: candidate.y };
    }
  }
  return { ...fallback };
}
