/**
 * Semantic pose rig — pose INTENT, independent of the final raster (§7).
 *
 * Phase 1 is the data model and the interaction boundary only. There is no IK,
 * no mesh deformation, and no skeletal renderer; the rig exists so that a pose
 * can be described, compared, and eventually dragged, without the description
 * being tied to whichever image happens to represent it today.
 *
 * Joints are normalized to the character's own bounding box (0–1, origin
 * top-left), so a rig is portable across assets of any size or aspect ratio.
 */

export type JointId =
  | "head"
  | "neck"
  | "shoulderLeft"
  | "shoulderRight"
  | "elbowLeft"
  | "elbowRight"
  | "handLeft"
  | "handRight"
  | "torso"
  | "hips"
  | "kneeLeft"
  | "kneeRight"
  | "footLeft"
  | "footRight";

export const JOINT_IDS: JointId[] = [
  "head",
  "neck",
  "shoulderLeft",
  "shoulderRight",
  "elbowLeft",
  "elbowRight",
  "handLeft",
  "handRight",
  "torso",
  "hips",
  "kneeLeft",
  "kneeRight",
  "footLeft",
  "footRight",
];

/** Parent chain, for future IK and for drawing the skeleton. */
export const JOINT_PARENT: Record<JointId, JointId | null> = {
  head: "neck",
  neck: "torso",
  shoulderLeft: "torso",
  shoulderRight: "torso",
  elbowLeft: "shoulderLeft",
  elbowRight: "shoulderRight",
  handLeft: "elbowLeft",
  handRight: "elbowRight",
  torso: null,
  hips: "torso",
  kneeLeft: "hips",
  kneeRight: "hips",
  footLeft: "kneeLeft",
  footRight: "kneeRight",
};

export interface JointPosition {
  x: number;
  y: number;
}

export type Direction = "left" | "right" | "camera" | "away";

export interface PoseDefinition {
  id: string;
  label: string;
  joints: Record<JointId, JointPosition>;
  torsoDirection: Direction;
  headDirection: Direction;
  /** Normalized motion intent; zero for static poses. Drives speed-line direction (§16). */
  motionVector: { x: number; y: number };
}

const STANDING: Record<JointId, JointPosition> = {
  head: { x: 0.5, y: 0.08 },
  neck: { x: 0.5, y: 0.17 },
  torso: { x: 0.5, y: 0.36 },
  shoulderLeft: { x: 0.38, y: 0.21 },
  shoulderRight: { x: 0.62, y: 0.21 },
  elbowLeft: { x: 0.34, y: 0.38 },
  elbowRight: { x: 0.66, y: 0.38 },
  handLeft: { x: 0.32, y: 0.54 },
  handRight: { x: 0.68, y: 0.54 },
  hips: { x: 0.5, y: 0.55 },
  kneeLeft: { x: 0.44, y: 0.75 },
  kneeRight: { x: 0.56, y: 0.75 },
  footLeft: { x: 0.43, y: 0.97 },
  footRight: { x: 0.57, y: 0.97 },
};

function derive(overrides: Partial<Record<JointId, JointPosition>>): Record<JointId, JointPosition> {
  return { ...STANDING, ...overrides };
}

/**
 * Built-in pose intents.
 *
 * These are coarse on purpose: they describe silhouette and motion well enough
 * to drive prompts, effect direction, and a future drag handle, without
 * pretending to be animation keyframes.
 */
export const BUILTIN_POSES: PoseDefinition[] = [
  {
    id: "standing",
    label: "Standing",
    joints: STANDING,
    torsoDirection: "camera",
    headDirection: "camera",
    motionVector: { x: 0, y: 0 },
  },
  {
    id: "walking",
    label: "Walking",
    joints: derive({
      kneeLeft: { x: 0.4, y: 0.73 },
      kneeRight: { x: 0.6, y: 0.77 },
      footLeft: { x: 0.34, y: 0.95 },
      footRight: { x: 0.66, y: 0.97 },
      elbowLeft: { x: 0.32, y: 0.4 },
      elbowRight: { x: 0.68, y: 0.36 },
    }),
    torsoDirection: "camera",
    headDirection: "camera",
    motionVector: { x: 0.35, y: 0 },
  },
  {
    id: "running",
    label: "Running",
    joints: derive({
      head: { x: 0.54, y: 0.07 },
      torso: { x: 0.52, y: 0.35 },
      kneeLeft: { x: 0.36, y: 0.68 },
      kneeRight: { x: 0.66, y: 0.8 },
      footLeft: { x: 0.26, y: 0.82 },
      footRight: { x: 0.74, y: 0.96 },
      handLeft: { x: 0.28, y: 0.4 },
      handRight: { x: 0.74, y: 0.46 },
    }),
    torsoDirection: "right",
    headDirection: "right",
    motionVector: { x: 0.9, y: -0.1 },
  },
  {
    id: "sitting",
    label: "Sitting",
    joints: derive({
      hips: { x: 0.5, y: 0.68 },
      kneeLeft: { x: 0.36, y: 0.72 },
      kneeRight: { x: 0.64, y: 0.72 },
      footLeft: { x: 0.34, y: 0.95 },
      footRight: { x: 0.66, y: 0.95 },
    }),
    torsoDirection: "camera",
    headDirection: "camera",
    motionVector: { x: 0, y: 0 },
  },
  {
    id: "jumping",
    label: "Jumping",
    joints: derive({
      head: { x: 0.5, y: 0.05 },
      handLeft: { x: 0.26, y: 0.16 },
      handRight: { x: 0.74, y: 0.16 },
      elbowLeft: { x: 0.32, y: 0.26 },
      elbowRight: { x: 0.68, y: 0.26 },
      kneeLeft: { x: 0.42, y: 0.7 },
      kneeRight: { x: 0.58, y: 0.7 },
      footLeft: { x: 0.4, y: 0.86 },
      footRight: { x: 0.6, y: 0.86 },
    }),
    torsoDirection: "camera",
    headDirection: "camera",
    motionVector: { x: 0, y: -0.8 },
  },
];

export function findPoseDefinition(poseId: string): PoseDefinition | undefined {
  const wanted = poseId.trim().toLowerCase();
  return BUILTIN_POSES.find((pose) => pose.id === wanted);
}

/**
 * Motion intent for a pose, used to suggest speed-line direction. Unknown
 * poses report no motion rather than a guess.
 */
export function poseMotionVector(poseId: string): { x: number; y: number } {
  return findPoseDefinition(poseId)?.motionVector ?? { x: 0, y: 0 };
}

/** Joint position in panel-local pixels for a placed instance. */
export function jointPositionPx(
  pose: PoseDefinition,
  joint: JointId,
  box: { cx: number; cy: number; width: number; height: number },
  flipX = false,
): JointPosition {
  const position = pose.joints[joint];
  const u = flipX ? 1 - position.x : position.x;
  return {
    x: box.cx - box.width / 2 + u * box.width,
    y: box.cy - box.height / 2 + position.y * box.height,
  };
}
