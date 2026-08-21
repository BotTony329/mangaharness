/**
 * Manga Puppet — a structured, locally manipulable character model (D36).
 *
 * A puppet is NOT an image. It is a hierarchy of textured parts with anchors
 * and pivots, so rotating an upper arm moves the forearm and hand and nothing
 * else. That is the whole point of the pivot: a semantic skeleton drawn over a
 * flattened raster has no authority over the pixels, so "direct manipulation"
 * was illusory and every edit had to be laundered through regeneration.
 *
 * The MODEL is shared and reusable. Per-panel placement and current local state
 * live in `PuppetInstanceState` on the placed instance, so the same Yuri can be
 * shocked with a raised arm in one panel and smiling in another.
 */

import type { ID, ISODate } from "@/domain/types";

// ─── Part vocabulary ────────────────────────────────────────────────────────

export type FacePartType =
  | "hairBack"
  | "headBase"
  | "faceBase"
  | "eyeLeft"
  | "eyeRight"
  | "browLeft"
  | "browRight"
  | "mouth"
  | "hairFront";

export type BodyPartType =
  | "torso"
  | "upperArmLeft"
  | "lowerArmLeft"
  | "handLeft"
  | "upperArmRight"
  | "lowerArmRight"
  | "handRight"
  | "pelvis"
  | "upperLegLeft"
  | "lowerLegLeft"
  | "footLeft"
  | "upperLegRight"
  | "lowerLegRight"
  | "footRight";

export type PuppetPartType = FacePartType | BodyPartType;

/** Parts an expression may replace. Everything else is body material. */
export const FACE_SWAPPABLE: FacePartType[] = ["eyeLeft", "eyeRight", "browLeft", "browRight", "mouth"];

export const FACE_PART_TYPES: FacePartType[] = [
  "hairBack",
  "headBase",
  "faceBase",
  "eyeLeft",
  "eyeRight",
  "browLeft",
  "browRight",
  "mouth",
  "hairFront",
];

export function isFacePart(type: PuppetPartType): type is FacePartType {
  return (FACE_PART_TYPES as string[]).includes(type);
}

// ─── Parts ──────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * How complete a part's material is (§11).
 *
 * A part cut straight out of a flattened drawing has no pixels where another
 * part used to cover it, so rotating an arm away from the torso would expose a
 * hole. A puppet whose hidden regions are incomplete must not claim every pose
 * is safe, and `capability.ts` reads this.
 */
export interface PartReadiness {
  segmented: boolean;
  hiddenRegionComplete: boolean;
  anchorCalibrated: boolean;
  meshReady: boolean;
}

export const READY: PartReadiness = {
  segmented: true,
  hiddenRegionComplete: true,
  anchorCalibrated: true,
  meshReady: false,
};

/** A normalized rectangle inside a source image (0..1 on both axes). */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PuppetPart {
  id: ID;
  type: PuppetPartType;
  /** Texture for this part alone, with real alpha. */
  textureAssetId: ID;
  /**
   * The sub-rectangle of `textureAssetId` this part draws.
   *
   * Present when the part was cut from a shared render rather than rendered on
   * its own — which is what Compiler v1 produces. Cropping a confirmed region
   * out of one image is honest about what it is: no automatic segmentation is
   * claimed, and the source image is never modified.
   */
  sourceRect?: SourceRect;
  maskAssetId?: ID;
  parentPartId?: ID;
  /**
   * Where this part attaches to its parent, in the PARENT's local unit space.
   * Rotation happens about this point, which is what makes a shoulder behave
   * like a shoulder.
   */
  anchor: Vec2;
  /** The same point expressed in this part's own unit space. */
  pivot: Vec2;
  /** Part size in puppet units (1 = puppet height). */
  size: Vec2;
  zIndex: number;
  /** Rest rotation in degrees, before any pose parameter. */
  restRotation?: number;
  visible: boolean;
  readiness: PartReadiness;
}

// ─── Expressions ────────────────────────────────────────────────────────────

/**
 * A reusable facial configuration (§5).
 *
 * An expression names replacement parts for some facial slots and says nothing
 * about the rest. Applying one therefore cannot touch a torso, an arm, an
 * outfit, a pose, or a transform — the type makes the guarantee structural
 * rather than a promise in a comment.
 */
export interface ExpressionDefinition {
  id: string;
  name: string;
  /** Slot → part id. Absent slots keep whatever the puppet already shows. */
  parts: Partial<Record<FacePartType, ID>>;
}

export const BUILTIN_EXPRESSION_IDS = [
  "neutral",
  "smile",
  "laugh",
  "angry",
  "crying",
  "shocked",
  "embarrassed",
  "worried",
] as const;

// ─── Pose parameters ────────────────────────────────────────────────────────

/**
 * Joints a puppet can articulate locally. Deliberately small: this is the
 * first vertical slice, not a rig.
 */
export type PuppetJoint =
  | "head"
  | "shoulderLeft"
  | "elbowLeft"
  | "wristLeft"
  | "shoulderRight"
  | "elbowRight"
  | "wristRight";

export const PUPPET_JOINTS: PuppetJoint[] = [
  "head",
  "shoulderLeft",
  "elbowLeft",
  "wristLeft",
  "shoulderRight",
  "elbowRight",
  "wristRight",
];

/** The part each joint rotates. */
export const JOINT_PART: Record<PuppetJoint, PuppetPartType> = {
  head: "headBase",
  shoulderLeft: "upperArmLeft",
  elbowLeft: "lowerArmLeft",
  wristLeft: "handLeft",
  shoulderRight: "upperArmRight",
  elbowRight: "lowerArmRight",
  wristRight: "handRight",
};

/** Rotation limits in degrees. Beyond these the puppet cannot represent the pose. */
export interface JointLimit {
  min: number;
  max: number;
}

export const JOINT_LIMITS: Record<PuppetJoint, JointLimit> = {
  head: { min: -28, max: 28 },
  shoulderLeft: { min: -150, max: 60 },
  elbowLeft: { min: -140, max: 10 },
  wristLeft: { min: -50, max: 50 },
  shoulderRight: { min: -60, max: 150 },
  elbowRight: { min: -10, max: 140 },
  wristRight: { min: -50, max: 50 },
};

/** Joint rotations in degrees. Absent means rest. */
export type PoseParameters = Partial<Record<PuppetJoint, number>>;

export function clampJoint(joint: PuppetJoint, degrees: number): number {
  const limit = JOINT_LIMITS[joint];
  return Math.max(limit.min, Math.min(limit.max, degrees));
}

export function jointWithinLimits(joint: PuppetJoint, degrees: number): boolean {
  const limit = JOINT_LIMITS[joint];
  return degrees >= limit.min && degrees <= limit.max;
}

// ─── Attachments ────────────────────────────────────────────────────────────

/** A prop held by, or worn on, a part (§3 attachments). */
export interface PuppetAttachment {
  id: ID;
  /** Where it attaches — a hand for a phone, the torso for a bag. */
  partType: PuppetPartType;
  textureAssetId: ID;
  offset: Vec2;
  size: Vec2;
  rotation: number;
  label: string;
}

// ─── The model ──────────────────────────────────────────────────────────────

export interface PuppetCompilerMetadata {
  /** How this puppet's parts were produced. */
  source: "fixture" | "manual" | "compiled";
  /** Canonical render the parts were cut from, when there was one. */
  sourceStateId?: ID;
  compiledAt?: ISODate;
  /** Honest note about what the compiler could not do. */
  notes?: string;
}

export interface MangaPuppet {
  id: ID;
  characterId: ID;
  version: number;
  /** Aspect ratio of the puppet's unit space (width / height). */
  aspect: number;
  parts: Record<ID, PuppetPart>;
  /** Draw order, back to front. */
  partOrder: ID[];
  expressions: Record<string, ExpressionDefinition>;
  attachments: Record<ID, PuppetAttachment>;
  defaultExpressionId: string;
  canonicalAssetId?: ID;
  compilerMetadata: PuppetCompilerMetadata;
  createdAt: ISODate;
}

// ─── Instance state ─────────────────────────────────────────────────────────

/**
 * One panel's local configuration of a shared puppet (§13).
 *
 * Lives on the placed instance, so two panels holding the same character keep
 * independent expressions, poses and attachments.
 */
export interface PuppetInstanceState {
  puppetId: ID;
  expressionId: string;
  pose: PoseParameters;
  /** Per-instance part swaps beyond the expression (hand variants, etc.). */
  partOverrides?: Partial<Record<PuppetPartType, ID>>;
  /** Attachment ids currently shown. */
  attachments?: ID[];
}

export function createPuppetInstanceState(puppet: MangaPuppet): PuppetInstanceState {
  return { puppetId: puppet.id, expressionId: puppet.defaultExpressionId, pose: {} };
}

// ─── Lookup helpers ─────────────────────────────────────────────────────────

export function partOfType(puppet: MangaPuppet, type: PuppetPartType): PuppetPart | undefined {
  return puppet.partOrder.map((id) => puppet.parts[id]).find((part) => part?.type === type);
}

export function childPartIds(puppet: MangaPuppet, partId: ID): ID[] {
  return puppet.partOrder.filter((id) => puppet.parts[id]?.parentPartId === partId);
}

/** Every descendant of a part, for "moving a parent moves its children" (§4). */
export function descendantPartIds(puppet: MangaPuppet, partId: ID): ID[] {
  return childPartIds(puppet, partId).flatMap((id) => [id, ...descendantPartIds(puppet, id)]);
}

export function rootPartIds(puppet: MangaPuppet): ID[] {
  return puppet.partOrder.filter((id) => !puppet.parts[id]?.parentPartId);
}
