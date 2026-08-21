/**
 * The 2.5D staging engine: camera and depth → real panel geometry.
 *
 * Phase 1 shipped a complete camera model that nothing read. This module is
 * what makes it visible. Everything here is deterministic and pure — given a
 * panel, a camera and an instance, it returns the transform that instance
 * should have. No physical camera solve, no 3D: a manga stage compresses depth
 * for readability rather than reproducing optics.
 *
 * Two rules shape the maths:
 *   • The ground line is the anchor. Scaling happens about the FEET, never the
 *     image centre, or characters float as they move through depth.
 *   • Framing is applied around the focal subject, not the panel centre, so a
 *     close-up frames a face rather than whatever happens to be in the middle.
 */

import { lensFov, shotCoverage } from "./camera";
import { depthScale } from "./stage";
import type {
  AssetInstance,
  CameraAngle,
  GroundAnchor,
  InstanceStage,
  PanelCamera,
  Rect,
  ShotType,
} from "./types";

/** Where the ground line sits for a panel, as a fraction of panel height. */
export const DEFAULT_GROUND_Y = 0.92;

/**
 * How far the eye level shifts the ground line.
 *
 * A high angle looks down, so the ground fills more of the frame and the line
 * rides up; a low angle does the opposite. Tied to the camera's horizon so the
 * perspective overlay and the characters agree about where the floor is.
 */
export function groundLineFor(camera: PanelCamera | undefined, fallback = DEFAULT_GROUND_Y): number {
  if (!camera) return fallback;
  // horizonY 0.5 is eye level and leaves the ground where it was; a horizon
  // pushed down the frame (high angle) pulls the ground down with it.
  return clamp01(fallback + (camera.horizonY - 0.5) * 0.35);
}

/**
 * Lens effect on depth falloff.
 *
 * A wide lens exaggerates the near/far size difference; a telephoto flattens
 * it. This is the one place optics genuinely earn their keep, because the
 * difference is instantly readable in a panel.
 */
export function lensDepthExponent(camera: PanelCamera | undefined): number {
  if (!camera) return 1;
  const fov = camera.fov || lensFov("normal");
  // 84° wide → ~1.35, 50° normal → 1, 28° telephoto → ~0.75.
  return clampRange(fov / 50, 0.7, 1.4);
}

/**
 * Manga exaggeration on top of optical falloff (§13).
 *
 * Deliberately separate from the lens: optical perspective is what a camera
 * would see, manga perspective is the artist choosing to overstate it. Strength
 * 0 changes nothing at all, so the control is honest at its default.
 */
export function mangaDepthExponent(strength: number): number {
  return 1 + clampRange(strength, 0, 3) * 0.28;
}

/** Combined depth → screen scale for a panel's camera. */
export function projectedDepthScale(depth: number, camera: PanelCamera | undefined): number {
  const base = depthScale(depth);
  const exponent = lensDepthExponent(camera) * mangaDepthExponent(camera?.mangaPerspectiveStrength ?? 0);
  return Math.pow(base, exponent);
}

/**
 * Poses that legitimately leave the ground (§9).
 *
 * A jumping character must not be yanked back down by the ground plane, so
 * grounding is skipped when the pose says airborne.
 */
const AIRBORNE_POSES = new Set(["jumping", "falling", "flying", "airborne", "leaping"]);

export function isAirborne(pose: string | undefined, descriptors: string[] = []): boolean {
  if (pose && AIRBORNE_POSES.has(pose.trim().toLowerCase())) return true;
  return descriptors.some((descriptor) => descriptor.includes("lifted") && descriptor.includes("leg"));
}

/**
 * The near-plane height implied by an instance's current size at a depth.
 *
 * Camera-aware, because the same pixel height means a different base height
 * under a wide lens than a telephoto — inverting the wrong curve would make a
 * character jump the first time depth or lens changed.
 */
export function inferBaseHeight(instance: AssetInstance, depth: number, camera?: PanelCamera): number {
  const scale = projectedDepthScale(depth, camera);
  return scale === 0 ? instance.height : instance.height / scale;
}

export interface StageProjection {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Project one instance onto the stage.
 *
 * `baseHeight` is the height the subject would have at the near plane, so two
 * characters sharing a base height and depth end up the same size — the
 * property that makes a panel read as one space.
 */
export function projectInstance(input: {
  instance: AssetInstance;
  stage: InstanceStage;
  panel: Rect;
  camera?: PanelCamera;
  baseHeight: number;
  airborne?: boolean;
}): StageProjection {
  const { instance, stage, panel, camera, baseHeight } = input;
  const aspect = instance.height === 0 ? 1 : instance.width / instance.height;
  const height = stage.scaleLocked ? instance.height : baseHeight * projectedDepthScale(stage.depth, camera);
  const width = stage.scaleLocked ? instance.width : height * aspect;

  if (input.airborne) {
    // Keep the character where the creator left it vertically; only size follows depth.
    return { cx: instance.cx, cy: instance.cy, width, height };
  }

  const groundLine = groundY(stage, camera) * panel.height;
  const cy = anchorOffset(stage.anchor, height, groundLine);
  return { cx: instance.cx, cy, width, height };
}

function groundY(stage: InstanceStage, camera: PanelCamera | undefined): number {
  // An explicit per-instance ground line wins; otherwise the camera decides.
  return stage.groundY ?? groundLineFor(camera);
}

function anchorOffset(anchor: GroundAnchor, height: number, groundLine: number): number {
  return anchor === "center" ? groundLine : groundLine - height / 2;
}

// ─── Camera framing ─────────────────────────────────────────────────────────

/**
 * Reframe the focal subject for a shot type (§5/§6).
 *
 * `coverage` is how many subject-heights fill the panel: a close-up wants the
 * subject far larger than the frame so only head and shoulders remain visible,
 * and the panel's clipping does the cropping. The subject is never destructively
 * cut — this is the same viewport principle the crop modes already use.
 */
export function frameSubject(input: {
  instance: AssetInstance;
  panel: Rect;
  shot: ShotType;
  angle?: CameraAngle;
}): StageProjection {
  const { instance, panel, shot } = input;
  const aspect = instance.height === 0 ? 1 : instance.width / instance.height;
  const height = panel.height * shotCoverage(shot);
  const width = height * aspect;

  // Vertical framing: tight shots centre on the head, wide shots on the body.
  const focusY = SHOT_FOCUS[shot];
  const cy = panel.height * 0.5 - (focusY - 0.5) * height;

  // A low angle places the subject high in frame so it towers; a high angle
  // pushes it down so the viewer looks over it.
  const angleShift = input.angle ? ANGLE_FRAMING_SHIFT[input.angle] : 0;
  return {
    cx: instance.cx,
    cy: cy + panel.height * angleShift,
    width,
    height,
  };
}

/**
 * Which fraction down the subject each shot centres on.
 *
 * 0 is the top of the head, 1 the feet. A close-up sits at 0.12 because a
 * manga close-up frames the eyes, not the geometric middle of the head.
 */
const SHOT_FOCUS: Record<ShotType, number> = {
  "extreme-wide": 0.5,
  wide: 0.5,
  full: 0.5,
  medium: 0.3,
  "close-up": 0.12,
  "extreme-close-up": 0.08,
};

const ANGLE_FRAMING_SHIFT: Record<CameraAngle, number> = {
  "eye-level": 0,
  high: 0.06,
  low: -0.06,
  overhead: 0.12,
  dutch: 0,
};

// ─── Transform vs redraw boundary (§14) ─────────────────────────────────────

export type CameraChangeKind = "shot" | "angle" | "lens" | "mangaPerspective";

export interface RedrawDecision {
  /** True when transforms alone cannot honestly represent the change. */
  requiresRedraw: boolean;
  reason?: string;
}

/**
 * Whether a camera change can be satisfied by transforms or genuinely needs a
 * redraw.
 *
 * Cropping to a close-up is honest: the artwork is unchanged, the viewport is
 * tighter. Re-angling a body is not — a low-angle view of a character drawn
 * straight-on cannot be produced by scaling, and pretending otherwise gives the
 * creator a stretched image instead of a new viewpoint. We never regenerate
 * when a crop suffices.
 */
export function cameraChangeRequiresRedraw(
  change: CameraChangeKind,
  camera: PanelCamera,
): RedrawDecision {
  if (change === "shot" || change === "lens") {
    return { requiresRedraw: false };
  }
  if (change === "angle") {
    if (camera.angle === "eye-level") return { requiresRedraw: false };
    if (camera.angle === "dutch") {
      // A dutch tilt is a frame rotation, not a new viewpoint.
      return { requiresRedraw: false };
    }
    return {
      requiresRedraw: true,
      reason: `A ${camera.angle.replace("-", " ")} view of the subject cannot be produced by scaling; the character needs redrawing from that angle.`,
    };
  }
  if (camera.mangaPerspectiveStrength >= 2) {
    return {
      requiresRedraw: true,
      reason: "Dramatic manga perspective needs foreshortening that transforms cannot fake.",
    };
  }
  return { requiresRedraw: false };
}

/**
 * Camera context handed to image generation (§13/§18).
 *
 * Provider-neutral sentences, so a newly generated character or background
 * matches the stage it is joining. Returns an empty array when the camera is
 * neutral, so a default panel adds nothing to the prompt.
 */
export function cameraGenerationContext(camera: PanelCamera | undefined): string[] {
  if (!camera) return [];
  const lines: string[] = [];

  if (camera.angle === "low") lines.push("Low camera angle looking up at the subject; eye level below the subject.");
  else if (camera.angle === "high") lines.push("High camera angle looking down at the subject.");
  else if (camera.angle === "overhead") lines.push("Overhead bird's-eye view looking straight down.");
  else if (camera.angle === "dutch") lines.push("Tilted dutch-angle framing.");

  if (camera.lens === "wide") lines.push("Wide-angle lens with pronounced depth and edge distortion.");
  else if (camera.lens === "telephoto") lines.push("Telephoto lens with compressed, flattened depth.");

  if (camera.mangaPerspectiveStrength >= 2) {
    lines.push(
      camera.mangaPerspectiveStrength >= 3
        ? "Extreme manga foreshortening: parts of the subject nearest the camera are dramatically enlarged."
        : "Dramatic manga foreshortening: exaggerate the size of whatever is nearest the camera.",
    );
  } else if (camera.mangaPerspectiveStrength === 1) {
    lines.push("Subtle manga foreshortening.");
  }

  return lines;
}

/** Shot framing as a generation instruction, for renders that must be redrawn. */
export function shotGenerationContext(shot: ShotType): string {
  switch (shot) {
    case "extreme-wide":
      return "Extreme wide shot: the subject is small within a large environment.";
    case "wide":
      return "Wide shot showing the subject within its surroundings.";
    case "full":
      return "Full shot: the whole body from head to feet.";
    case "medium":
      return "Medium shot framed from roughly the waist up.";
    case "close-up":
      return "Close-up framed on the head and shoulders.";
    case "extreme-close-up":
      return "Extreme close-up filling the frame with the face.";
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
