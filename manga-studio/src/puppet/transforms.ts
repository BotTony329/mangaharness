/**
 * Hierarchical part transforms (§4).
 *
 * This is where the pivot actually happens. Each part carries an anchor in its
 * parent's space and a pivot in its own, so rotating a shoulder rotates the
 * forearm and hand with it and leaves the torso, head and other arm untouched.
 * That relationship is computed here rather than baked into pixels, which is
 * the difference between a puppet and a picture of one.
 *
 * All coordinates are in the puppet's unit space (1 = puppet height) so a
 * puppet is resolution- and size-independent; the renderer scales once at the
 * instance level.
 */

import type { ID } from "@/domain/types";
import {
  JOINT_PART,
  PUPPET_JOINTS,
  clampJoint,
  type MangaPuppet,
  type PoseParameters,
  type PuppetJoint,
  type PuppetPart,
  type PuppetPartType,
  type Vec2,
} from "./model";

/** A resolved 2D affine transform for one part. */
export interface PartTransform {
  /** Position of the part's pivot, in puppet unit space. */
  x: number;
  y: number;
  /** Accumulated rotation in degrees. */
  rotation: number;
  size: Vec2;
  pivot: Vec2;
  zIndex: number;
  visible: boolean;
}

function rotate(point: Vec2, degrees: number): Vec2 {
  if (!degrees) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/** Which joint, if any, drives a part's rotation. */
export function jointForPart(type: PuppetPartType): PuppetJoint | undefined {
  return PUPPET_JOINTS.find((joint) => JOINT_PART[joint] === type);
}

/**
 * Resolve every part's world transform for a pose.
 *
 * Walks the hierarchy from the roots so a parent's rotation is already applied
 * when its children are placed — the reason a raised upper arm carries the
 * forearm rather than tearing away from it.
 */
export function resolvePartTransforms(
  puppet: MangaPuppet,
  pose: PoseParameters = {},
  overrides: Partial<Record<PuppetPartType, ID>> = {},
): Map<ID, PartTransform> {
  const resolved = new Map<ID, PartTransform>();
  const hidden = new Set<ID>();

  // A part override replaces the part of that type; the replaced one is hidden
  // rather than deleted, so the swap is reversible and cheap.
  for (const [type, replacementId] of Object.entries(overrides)) {
    for (const id of puppet.partOrder) {
      const part = puppet.parts[id];
      if (part?.type === type && part.id !== replacementId) hidden.add(id);
    }
  }

  const place = (partId: ID, parent: PartTransform | null) => {
    const part = puppet.parts[partId];
    if (!part) return;

    const joint = jointForPart(part.type);
    const localRotation = (part.restRotation ?? 0) + (joint ? clampJoint(joint, pose[joint] ?? 0) : 0);
    const rotation = (parent?.rotation ?? 0) + localRotation;

    // The anchor is expressed in the parent's unit space and rides the parent's
    // own rotation, which is what keeps a joint attached while it swings.
    let x: number;
    let y: number;
    if (parent) {
      const offset = rotate({ x: part.anchor.x, y: part.anchor.y }, parent.rotation);
      x = parent.x + offset.x;
      y = parent.y + offset.y;
    } else {
      x = part.anchor.x;
      y = part.anchor.y;
    }

    const transform: PartTransform = {
      x,
      y,
      rotation,
      size: part.size,
      pivot: part.pivot,
      zIndex: part.zIndex,
      visible: part.visible && !hidden.has(partId),
    };
    resolved.set(partId, transform);

    for (const childId of puppet.partOrder) {
      if (puppet.parts[childId]?.parentPartId === partId) place(childId, transform);
    }
  };

  for (const rootId of puppet.partOrder) {
    if (!puppet.parts[rootId]?.parentPartId) place(rootId, null);
  }
  return resolved;
}

/**
 * Which parts an expression shows.
 *
 * Returns the full visible set so the renderer never has to reason about
 * expressions, and so a test can assert that body parts are byte-identical
 * before and after a face change.
 */
export function resolveVisibleParts(
  puppet: MangaPuppet,
  expressionId: string,
  overrides: Partial<Record<PuppetPartType, ID>> = {},
): ID[] {
  const expression = puppet.expressions[expressionId];
  const chosen = new Map<PuppetPartType, ID>();
  for (const [type, partId] of Object.entries(expression?.parts ?? {})) {
    chosen.set(type as PuppetPartType, partId);
  }
  for (const [type, partId] of Object.entries(overrides)) {
    chosen.set(type as PuppetPartType, partId);
  }

  return puppet.partOrder.filter((id) => {
    const part = puppet.parts[id];
    if (!part || !part.visible) return false;
    const selected = chosen.get(part.type);
    // A slot with a selection shows only the selected part; a slot with no
    // selection is body material and always shows.
    return selected === undefined ? true : selected === id;
  });
}

/** Convenience: the part ids an expression selects, for assertions and UI. */
export function expressionPartIds(puppet: MangaPuppet, expressionId: string): ID[] {
  return Object.values(puppet.expressions[expressionId]?.parts ?? {});
}

/**
 * The head's bounding box in puppet unit space, for the face drop target (§6).
 *
 * Derived from real geometry rather than a percentage band, so dropping an
 * expression lands on the face wherever the puppet's head actually is.
 */
export function facePartBounds(
  puppet: MangaPuppet,
  transforms: Map<ID, PartTransform>,
): { x: number; y: number; width: number; height: number } | null {
  const faceTypes: PuppetPartType[] = ["headBase", "faceBase", "eyeLeft", "eyeRight", "mouth"];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of puppet.partOrder) {
    const part: PuppetPart | undefined = puppet.parts[id];
    const transform = resolvedOrNull(transforms, id);
    if (!part || !transform || !faceTypes.includes(part.type)) continue;
    const left = transform.x - transform.pivot.x * transform.size.x;
    const top = transform.y - transform.pivot.y * transform.size.y;
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + transform.size.x);
    maxY = Math.max(maxY, top + transform.size.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function resolvedOrNull(transforms: Map<ID, PartTransform>, id: ID): PartTransform | null {
  return transforms.get(id) ?? null;
}
