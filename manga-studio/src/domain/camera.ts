/**
 * Panel camera — the director's controls for one panel.
 *
 * The product principle is "easy first, professional underneath" (§14/§22):
 * shot / angle / lens are the primary vocabulary, and the numeric fields
 * (pitch, yaw, roll, horizon, fov) are derived from a preset unless the user
 * overrides them. `derivedFrom` records which preset produced the numbers, so
 * an untouched camera keeps tracking preset changes while an edited one is
 * never silently reset.
 *
 * This module is pure data + derivation. It does not render, and it does not
 * decide how a shot is achieved — a close-up may become a crop today and a
 * regeneration later without anything here changing.
 */

import type { PanelCamera, CameraAngle, CameraLens, ShotType } from "./types";

export const SHOT_TYPES: ShotType[] = [
  "extreme-wide",
  "wide",
  "full",
  "medium",
  "close-up",
  "extreme-close-up",
];

export const CAMERA_ANGLES: CameraAngle[] = ["eye-level", "high", "low", "overhead", "dutch"];

export const CAMERA_LENSES: CameraLens[] = ["wide", "normal", "telephoto"];

/** Manga foreshortening intent, independent of optical perspective (§13). */
export const MANGA_PERSPECTIVE_LABELS = ["normal", "subtle", "dramatic", "extreme"] as const;
export const MAX_MANGA_PERSPECTIVE = 3;

export interface AngleGeometry {
  /** Rotation about the lateral axis. Negative looks down, positive looks up. */
  pitch: number;
  roll: number;
  /** Eye level as a fraction of panel height. 0 = top edge, 1 = bottom edge. */
  horizonY: number;
}

/**
 * Angle presets. Horizon placement follows the convention that a high angle
 * pushes the eye line down the frame and a low angle lifts it — that is what
 * makes a low-angle shot read as "looking up at the subject".
 */
const ANGLE_GEOMETRY: Record<CameraAngle, AngleGeometry> = {
  "eye-level": { pitch: 0, roll: 0, horizonY: 0.5 },
  high: { pitch: -22, roll: 0, horizonY: 0.72 },
  low: { pitch: 22, roll: 0, horizonY: 0.26 },
  overhead: { pitch: -80, roll: 0, horizonY: 0.95 },
  dutch: { pitch: 0, roll: 14, horizonY: 0.5 },
};

/** Horizontal field of view in degrees. */
const LENS_FOV: Record<CameraLens, number> = { wide: 84, normal: 50, telephoto: 28 };

/**
 * How much of the subject's height the shot keeps in frame. Framing math and
 * depth scaling both read this, so "medium" means the same thing everywhere.
 */
const SHOT_SUBJECT_COVERAGE: Record<ShotType, number> = {
  "extreme-wide": 0.28,
  wide: 0.5,
  full: 0.92,
  medium: 1.45,
  "close-up": 2.6,
  "extreme-close-up": 4.2,
};

export const DEFAULT_CAMERA_PRESET = {
  shot: "medium" as ShotType,
  angle: "eye-level" as CameraAngle,
  lens: "normal" as CameraLens,
  mangaPerspectiveStrength: 0,
};

export function createPanelCamera(preset: Partial<typeof DEFAULT_CAMERA_PRESET> = {}): PanelCamera {
  const shot = preset.shot ?? DEFAULT_CAMERA_PRESET.shot;
  const angle = preset.angle ?? DEFAULT_CAMERA_PRESET.angle;
  const lens = preset.lens ?? DEFAULT_CAMERA_PRESET.lens;
  const geometry = ANGLE_GEOMETRY[angle];
  return {
    shot,
    angle,
    lens,
    mangaPerspectiveStrength: clampMangaPerspective(
      preset.mangaPerspectiveStrength ?? DEFAULT_CAMERA_PRESET.mangaPerspectiveStrength,
    ),
    pitch: geometry.pitch,
    yaw: 0,
    roll: geometry.roll,
    horizonY: geometry.horizonY,
    fov: LENS_FOV[lens],
    derivedFrom: { angle, lens },
  };
}

export function shotCoverage(shot: ShotType): number {
  return SHOT_SUBJECT_COVERAGE[shot];
}

export function lensFov(lens: CameraLens): number {
  return LENS_FOV[lens];
}

export function angleGeometry(angle: CameraAngle): AngleGeometry {
  return { ...ANGLE_GEOMETRY[angle] };
}

export function clampMangaPerspective(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_MANGA_PERSPECTIVE, Math.round(value)));
}

export function mangaPerspectiveLabel(value: number): string {
  return MANGA_PERSPECTIVE_LABELS[clampMangaPerspective(value)];
}

export type CameraPatch = Partial<
  Pick<PanelCamera, "shot" | "angle" | "lens" | "mangaPerspectiveStrength" | "pitch" | "yaw" | "roll" | "horizonY" | "fov">
>;

/**
 * Apply a camera change.
 *
 * Choosing a preset re-derives the numbers it owns; editing a number directly
 * detaches only that number, so a later preset change still moves everything
 * the user has not personally taken control of. Without `derivedFrom` we would
 * have to choose between presets that stomp manual work and presets that stop
 * working after any advanced edit.
 */
export function applyCameraPatch(camera: PanelCamera, patch: CameraPatch): PanelCamera {
  const next: PanelCamera = { ...camera, derivedFrom: { ...camera.derivedFrom } };

  if (patch.shot !== undefined) next.shot = patch.shot;
  if (patch.mangaPerspectiveStrength !== undefined) {
    next.mangaPerspectiveStrength = clampMangaPerspective(patch.mangaPerspectiveStrength);
  }

  if (patch.angle !== undefined) {
    next.angle = patch.angle;
    const geometry = ANGLE_GEOMETRY[patch.angle];
    next.pitch = geometry.pitch;
    next.roll = geometry.roll;
    next.horizonY = geometry.horizonY;
    next.derivedFrom.angle = patch.angle;
  }
  if (patch.lens !== undefined) {
    next.lens = patch.lens;
    next.fov = LENS_FOV[patch.lens];
    next.derivedFrom.lens = patch.lens;
  }

  // Advanced overrides come last so an angle+pitch change in one patch keeps
  // the explicit pitch.
  if (patch.pitch !== undefined) {
    next.pitch = patch.pitch;
    next.derivedFrom.angle = undefined;
  }
  if (patch.roll !== undefined) {
    next.roll = patch.roll;
    next.derivedFrom.angle = undefined;
  }
  if (patch.horizonY !== undefined) {
    next.horizonY = clamp01(patch.horizonY);
    next.derivedFrom.angle = undefined;
  }
  if (patch.yaw !== undefined) next.yaw = patch.yaw;
  if (patch.fov !== undefined) {
    next.fov = Math.max(5, Math.min(170, patch.fov));
    next.derivedFrom.lens = undefined;
  }
  return next;
}

/** True when every numeric field still matches the named presets. */
export function cameraMatchesPresets(camera: PanelCamera): boolean {
  return camera.derivedFrom.angle === camera.angle && camera.derivedFrom.lens === camera.lens;
}

export function describeCamera(camera: PanelCamera): string {
  const parts = [
    labelOf(camera.shot),
    labelOf(camera.angle),
    `${labelOf(camera.lens)} lens`,
  ];
  if (camera.mangaPerspectiveStrength > 0) {
    parts.push(`${mangaPerspectiveLabel(camera.mangaPerspectiveStrength)} manga perspective`);
  }
  return parts.join(", ");
}

function labelOf(value: string): string {
  return value.replace(/-/g, " ");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
