"use client";

/**
 * CameraResolver — the ONE application-level boundary that decides whether a
 * camera change is pixels or paint.
 *
 * ## Relationship to the canonical rule
 *
 * The judgement itself lives in `cameraChangeRequiresRedraw`
 * (domain/staging.ts) and is NOT reimplemented here. This module is the formal
 * service boundary every surface must call — Manual UI, Agent, and (from
 * Phase 2) generation — so the verdict can never fork into a second copy of
 * the rules.
 *
 * What this boundary adds on top of the canonical rule, deliberately and in
 * exactly one place:
 *
 *   - Shot COVERAGE. The canonical rule treats every shot change as local
 *     because framing is a viewport operation. That is only honest when the
 *     target frame exists inside the current pixels: tightening (full →
 *     medium) is a crop, but widening (close-up → full) asks for legs the
 *     frame never contained. Until the runtime can measure how much subject a
 *     source image holds beyond its frame, widening redraws — see
 *     `availableCoverage`, the extension point for that future measurement.
 *
 * Phase 1 scope: decisions only. Nothing here calls a provider, and no
 * generation path exists yet. Vocabulary the camera model cannot yet express
 * (worm's-eye, rear view, over-the-shoulder) is a Phase 6 semantic extension,
 * not a schema change made here.
 */

import { cameraChangeRequiresRedraw, type CameraChangeKind } from "@/domain/staging";
import { shotCoverage } from "@/domain/camera";
import type { PanelCamera, ShotType } from "@/domain/types";

export type CameraExecution = "LOCAL_TRANSFORM" | "GENERATIVE_REDRAW";

export interface CameraExecutionInput {
  /** What kind of camera edit is being requested. */
  change: CameraChangeKind;
  /** The camera state AFTER the change is applied. */
  camera: PanelCamera;
  /** Shot before the change; required context when change === "shot". */
  fromShot?: ShotType;
  /** Shot after the change; defaults to the camera's own shot. */
  toShot?: ShotType;
  /**
   * EXTENSION POINT (Phase 2+): how many subject-heights the source artwork
   * actually contains, including what the current frame crops away. Unknown
   * today — the runtime cannot measure pixels beyond the frame — so a
   * widening shot is GENERATIVE unless this says the content exists.
   */
  availableCoverage?: number;
}

export interface CameraExecutionDecision {
  execution: CameraExecution;
  reason?: string;
}

const LOCAL: CameraExecutionDecision = { execution: "LOCAL_TRANSFORM" };

/**
 * The generation size that matches a target panel's shape. Scene redraws
 * inherit the panel's frame instead of a hardcoded landscape: a vertical
 * manga panel gets a vertical scene.
 */
export function panelAspectFor(
  panel: { points: { x: number; y: number }[] } | undefined,
): "portrait" | "landscape" | "square" {
  if (!panel || panel.points.length === 0) return "landscape";
  const xs = panel.points.map((p) => p.x);
  const ys = panel.points.map((p) => p.y);
  const ratio = (Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.max(...ys) - Math.min(...ys));
  if (ratio >= 1.2) return "landscape";
  if (ratio <= 0.8) return "portrait";
  return "square";
}

/**
 * Decide how a camera change is executed.
 *
 * LOCAL_TRANSFORM  — existing pixels suffice (crop, pan, tilt, lens staging).
 *                    Zero API calls, always.
 * GENERATIVE_REDRAW — the viewpoint must be drawn; transforms would fake it.
 */
export function resolveCameraExecution(input: CameraExecutionInput): CameraExecutionDecision {
  if (input.change === "shot") return resolveShotExecution(input);

  const verdict = cameraChangeRequiresRedraw(input.change, input.camera);
  return verdict.requiresRedraw
    ? { execution: "GENERATIVE_REDRAW", reason: verdict.reason }
    : LOCAL;
}

/**
 * Shot changes: LOCAL only when the target frame lives inside the current
 * pixels. "Existing pixels are sufficient" is the test, not "shot = local".
 */
function resolveShotExecution(input: CameraExecutionInput): CameraExecutionDecision {
  const from = input.fromShot ?? input.camera.shot;
  const to = input.toShot ?? input.camera.shot;

  // Tightening is a crop: the close-up's pixels are already in the frame.
  if (shotCoverage(to) >= shotCoverage(from)) return LOCAL;

  // Widening needs subject content the frame does not show. When the source
  // artwork provably contains it (extension point), it is still a crop.
  if (input.availableCoverage !== undefined && input.availableCoverage >= shotCoverage(to)) {
    return LOCAL;
  }
  return {
    execution: "GENERATIVE_REDRAW",
    reason: `Widening from ${from.replace("-", " ")} to ${to.replace("-", " ")} needs subject content outside the current frame; scaling cannot invent it.`,
  };
}
