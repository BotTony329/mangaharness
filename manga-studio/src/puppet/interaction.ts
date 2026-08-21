/**
 * Direct-manipulation geometry for puppets (V3.2 §1/§2).
 *
 * Pure functions on purpose: the canvas overlay is thin React that renders
 * whatever these return, so handle placement, drag→angle conversion and the
 * face drop target are all testable without a DOM or a Konva stage.
 *
 * Everything is in the puppet's unit space (1 = puppet height) except where a
 * function explicitly takes instance pixels — the overlay multiplies once.
 */

import type { ID } from "@/domain/types";
import { canApplyJoint, type PuppetCapabilityResult } from "./capability";
import {
  JOINT_PART,
  PUPPET_JOINTS,
  clampJoint,
  partOfType,
  type MangaPuppet,
  type PoseParameters,
  type PuppetJoint,
} from "./model";
import { resolvePartTransforms, facePartBounds, type PartTransform } from "./transforms";

/** Joints exposed as draggable handles on the canvas. */
export const DRAGGABLE_PUPPET_JOINTS: PuppetJoint[] = PUPPET_JOINTS;

export interface JointHandle {
  joint: PuppetJoint;
  partId: ID;
  /** Handle position in puppet unit space — the part's pivot, i.e. the joint. */
  x: number;
  y: number;
  /** Far end of the bone, for drawing the limb guide. */
  tipX: number;
  tipY: number;
  /** World rotation the bone would have at pose 0 — the drag baseline. */
  restWorldAngle: number;
  degrees: number;
  capability: PuppetCapabilityResult;
}

/**
 * The bone's local direction, as an angle offset from the part's own frame.
 *
 * Parts are authored hanging downward from their pivot, so the bone runs along
 * local +y. In atan2 terms that is +90°.
 */
const BONE_LOCAL_ANGLE = 90;

/**
 * Handles for every joint this puppet actually has.
 *
 * A joint whose part is missing produces no handle at all rather than a handle
 * that does nothing — an affordance for a limb the puppet does not own is a
 * lie about its capability.
 */
export function jointHandles(puppet: MangaPuppet, pose: PoseParameters = {}): JointHandle[] {
  const transforms = resolvePartTransforms(puppet, pose);
  const handles: JointHandle[] = [];

  for (const joint of DRAGGABLE_PUPPET_JOINTS) {
    const part = partOfType(puppet, JOINT_PART[joint]);
    if (!part) continue;
    const transform = transforms.get(part.id);
    if (!transform || !transform.visible) continue;

    const degrees = pose[joint] ?? 0;
    const parentRotation = parentRotationOf(puppet, part.id, transforms);
    const restWorldAngle = parentRotation + (part.restRotation ?? 0) + BONE_LOCAL_ANGLE;

    // The bone runs from the pivot along the part's own +y for its length.
    const worldAngle = restWorldAngle + clampJoint(joint, degrees);
    const length = boneLength(transform);
    const radians = (worldAngle * Math.PI) / 180;

    handles.push({
      joint,
      partId: part.id,
      x: transform.x,
      y: transform.y,
      tipX: transform.x + Math.cos(radians) * length,
      tipY: transform.y + Math.sin(radians) * length,
      restWorldAngle,
      degrees,
      capability: canApplyJoint(puppet, joint, degrees),
    });
  }
  return handles;
}

/** How far the bone extends past its pivot, in unit space. */
function boneLength(transform: PartTransform): number {
  return transform.size.y * (1 - transform.pivot.y);
}

function parentRotationOf(puppet: MangaPuppet, partId: ID, transforms: Map<ID, PartTransform>): number {
  const parentId = puppet.parts[partId]?.parentPartId;
  return (parentId ? transforms.get(parentId)?.rotation : 0) ?? 0;
}

export interface JointDragResult {
  /** Angle the creator asked for, before clamping. */
  requested: number;
  /** Angle actually applied. */
  applied: number;
  /** True when the request had to be clamped — the capability boundary was hit. */
  clamped: boolean;
  capability: PuppetCapabilityResult;
}

/**
 * Convert a pointer position into a joint rotation.
 *
 * The drag baseline is the bone's rest direction, so dragging a hand to where
 * the cursor is puts the bone under the cursor — the manipulation is direct
 * rather than an abstract slider mapped onto a limb.
 *
 * The requested angle is reported alongside the applied one so the caller can
 * tell the difference between "moved" and "refused to distort" (§3). The
 * puppet is never bent past its limit to satisfy the pointer.
 */
export function jointAngleFromPointer(
  puppet: MangaPuppet,
  joint: PuppetJoint,
  handle: Pick<JointHandle, "x" | "y" | "restWorldAngle">,
  pointer: { x: number; y: number },
): JointDragResult {
  const dx = pointer.x - handle.x;
  const dy = pointer.y - handle.y;
  const pointerAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const requested = normalizeDegrees(pointerAngle - handle.restWorldAngle);
  const applied = clampJoint(joint, requested);
  return {
    requested,
    applied,
    clamped: Math.abs(applied - requested) > 0.5,
    capability: canApplyJoint(puppet, joint, requested),
  };
}

/** Fold an angle into (-180, 180] so a limit comparison is meaningful. */
export function normalizeDegrees(degrees: number): number {
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

export interface FaceDropTarget {
  /** In puppet unit space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The real face region of a posed puppet — the drop target for an expression.
 *
 * Derived from the actual head geometry under the current pose, so a tilted
 * head moves its own drop target rather than the creator aiming at a fixed
 * percentage band near the top of the sprite.
 */
export function faceDropTarget(puppet: MangaPuppet, pose: PoseParameters = {}): FaceDropTarget | null {
  return facePartBounds(puppet, resolvePartTransforms(puppet, pose));
}

/**
 * Is a point (in puppet unit space) over the face?
 *
 * Padded slightly, because a drop is a gesture rather than a click: requiring
 * pixel accuracy on a small head would make the interaction feel broken.
 */
export function isOverFace(target: FaceDropTarget | null, point: { x: number; y: number }, padding = 0.02): boolean {
  if (!target) return false;
  return (
    point.x >= target.x - padding &&
    point.x <= target.x + target.width + padding &&
    point.y >= target.y - padding &&
    point.y <= target.y + target.height + padding
  );
}

/**
 * Convert a workspace point into the puppet's unit space for one instance.
 *
 * Mirrors `PuppetNode`'s own mapping (flip included), so what the overlay hit
 * tests is what the renderer drew.
 */
export function toPuppetUnits(
  instance: { cx: number; cy: number; width: number; height: number; flipX: boolean },
  panelLocal: { x: number; y: number },
): { x: number; y: number } {
  const left = instance.cx - instance.width / 2;
  const top = instance.cy - instance.height / 2;
  const localX = instance.flipX ? instance.width - (panelLocal.x - left) : panelLocal.x - left;
  return { x: localX / instance.height, y: (panelLocal.y - top) / instance.height };
}

/** Inverse of `toPuppetUnits`: puppet unit space → panel-local pixels. */
export function fromPuppetUnits(
  instance: { cx: number; cy: number; width: number; height: number; flipX: boolean },
  unitPoint: { x: number; y: number },
): { x: number; y: number } {
  const left = instance.cx - instance.width / 2;
  const top = instance.cy - instance.height / 2;
  const px = unitPoint.x * instance.height;
  return {
    x: left + (instance.flipX ? instance.width - px : px),
    y: top + unitPoint.y * instance.height,
  };
}
