"use client";

/**
 * Camera Semantic Normalization Boundary — the SINGLE source of truth between
 * the Creative Director's photographic language and the Editor's camera enums.
 *
 * The director says "dramatic", "intimate", "compressed"; the editor only
 * understands ShotType / CameraAngle / CameraLens / PerspectiveType. This
 * module is the only place that translation may happen — never the prompt,
 * the schema, the UI, or the executor.
 *
 * SOFT NORMALIZATION rule: an unknown creative word can never kill a run.
 * Camera style is not identity integrity — unmappable intent falls back to a
 * safe value and records a warning.
 *
 * Phase 5 boundary: this module is an INTENT COMPILER, nothing more. It never
 * decides LOCAL_TRANSFORM vs GENERATIVE_REDRAW and never produces generation
 * hints — that judgement belongs to the CameraResolver behind the Panel
 * Camera application service, the same verdict the UI button reads.
 */

export type EditorShot = "extreme-wide" | "wide" | "full" | "medium" | "close-up" | "extreme-close-up";
export type EditorAngle = "eye-level" | "high" | "low" | "overhead" | "dutch";
export type EditorLens = "wide" | "normal" | "telephoto";
export type EditorPerspective = "one-point" | "two-point" | "three-point";

export interface CreativeCameraInput {
  shot?: string;
  angle?: string;
  lens?: string;
  /** Creative perspective words ("three-point perspective"). */
  perspective?: string;
  dramaticIntent?: string;
}

export interface NormalizedCamera {
  shot?: EditorShot;
  angle?: EditorAngle;
  lens?: EditorLens;
  perspective?: EditorPerspective;
  warnings: string[];
}

const SHOT_MAP: Record<string, EditorShot> = {
  "extreme-wide": "extreme-wide",
  establishing: "wide",
  wide: "wide",
  cinematic: "wide",
  full: "full",
  "full-body": "full",
  medium: "medium",
  standard: "medium",
  bust: "medium",
  "close-up": "close-up",
  closeup: "close-up",
  close: "close-up",
  intimate: "close-up",
  emotional: "close-up",
  portrait: "close-up",
  "extreme-close-up": "extreme-close-up",
  detail: "extreme-close-up",
};

const ANGLE_MAP: Record<string, EditorAngle> = {
  "eye-level": "eye-level",
  eye: "eye-level",
  natural: "eye-level",
  neutral: "eye-level",
  flat: "eye-level",
  high: "high",
  "high-angle": "high",
  "bird's-eye": "overhead",
  birdsEye: "overhead",
  overhead: "overhead",
  top: "overhead",
  low: "low",
  "low-angle": "low",
  heroic: "low",
  dramatic: "low",
  dutch: "dutch",
  tilted: "dutch",
  canted: "dutch",
};

const LENS_MAP: Record<string, EditorLens> = {
  wide: "wide",
  dramatic: "wide",
  dynamic: "wide",
  intense: "wide",
  cinematic: "wide",
  expansive: "wide",
  normal: "normal",
  natural: "normal",
  standard: "normal",
  neutral: "normal",
  balanced: "normal",
  flat: "telephoto",
  compressed: "telephoto",
  portrait: "telephoto",
  telephoto: "telephoto",
  tele: "telephoto",
  long: "telephoto",
};

const PERSPECTIVE_MAP: Record<string, EditorPerspective> = {
  "one-point": "one-point",
  "one-point perspective": "one-point",
  "two-point": "two-point",
  "two-point perspective": "two-point",
  "three-point": "three-point",
  "three-point perspective": "three-point",
};

function lookup<T extends string>(table: Record<string, T>, value: string | undefined): T | undefined {
  if (!value) return undefined;
  return table[value.trim().toLowerCase()];
}

export function resolveCameraIntent(input: CreativeCameraInput | undefined): NormalizedCamera | undefined {
  if (!input) return undefined;
  const warnings: string[] = [];

  let shot = lookup(SHOT_MAP, input.shot);
  if (input.shot && !shot) {
    warnings.push(`Unsupported creative shot intent "${input.shot}"; using medium.`);
    shot = "medium";
  }
  let angle = lookup(ANGLE_MAP, input.angle);
  if (input.angle && !angle) {
    warnings.push(`Unsupported creative angle intent "${input.angle}"; using eye-level.`);
    angle = "eye-level";
  }
  let lens = lookup(LENS_MAP, input.lens);
  if (input.lens && !lens) {
    warnings.push(`Unsupported creative lens intent "${input.lens}"; using normal.`);
    lens = "normal";
  }
  let perspective = lookup(PERSPECTIVE_MAP, input.perspective);
  if (input.perspective && !perspective) {
    warnings.push(`Unsupported creative perspective intent "${input.perspective}"; ignored.`);
    perspective = undefined;
  }

  if (!shot && !angle && !lens && !perspective) return undefined;
  return { shot, angle, lens, perspective, warnings };
}
