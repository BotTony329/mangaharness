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

// ─── Phase 3: interactive rig ───────────────────────────────────────────────

/**
 * A pose the creator authored by dragging joints.
 *
 * `joints` holds only what was MOVED, normalized to the character's own bounds,
 * so a pose survives scaling, moving, reframing, and save/load (§4).
 *
 * `descriptors` are the semantic reading of those joints, and they — not the
 * raw coordinates — are the pose's identity. Keying cached states on pixel
 * positions would fork a new state on every pixel of drag; keying on meaning
 * means two different drags that both say "right arm raised" reuse one render.
 */
export interface PoseRigState {
  /** Preset the edit started from. A preset is a starting pose, not a lock (§8). */
  basePose: string;
  /** Only the joints that differ from the base pose. */
  joints: Partial<Record<JointId, JointPosition>>;
  /** Sorted semantic reading, e.g. ["right arm raised", "head turned left"]. */
  descriptors: string[];
}

/** One semantic change relative to the base pose (§3). */
export interface PoseDelta {
  basePose: string;
  descriptors: string[];
  movedJoints: JointId[];
}

const LIMB_CHAINS: { root: JointId; mid: JointId; tip: JointId }[] = [
  { root: "shoulderLeft", mid: "elbowLeft", tip: "handLeft" },
  { root: "shoulderRight", mid: "elbowRight", tip: "handRight" },
  { root: "hips", mid: "kneeLeft", tip: "footLeft" },
  { root: "hips", mid: "kneeRight", tip: "footRight" },
];

/** Bones drawn by the overlay, and the connections constraints must preserve. */
export const BONES: [JointId, JointId][] = [
  ["head", "neck"],
  ["neck", "torso"],
  ["torso", "shoulderLeft"],
  ["torso", "shoulderRight"],
  ["shoulderLeft", "elbowLeft"],
  ["elbowLeft", "handLeft"],
  ["shoulderRight", "elbowRight"],
  ["elbowRight", "handRight"],
  ["torso", "hips"],
  ["hips", "kneeLeft"],
  ["kneeLeft", "footLeft"],
  ["hips", "kneeRight"],
  ["kneeRight", "footRight"],
];

/** Joints the creator may drag. Torso and neck follow the body, not the mouse. */
export const DRAGGABLE_JOINTS: JointId[] = [
  "head",
  "shoulderLeft",
  "shoulderRight",
  "elbowLeft",
  "elbowRight",
  "handLeft",
  "handRight",
  "hips",
  "kneeLeft",
  "kneeRight",
  "footLeft",
  "footRight",
];

export function createPoseRigState(basePose: string): PoseRigState {
  return { basePose: basePose.trim().toLowerCase(), joints: {}, descriptors: [] };
}

/** Resolved joint positions: the base pose with the creator's edits applied. */
export function resolveJoints(rig: PoseRigState): Record<JointId, JointPosition> {
  const base = findPoseDefinition(rig.basePose)?.joints ?? STANDING;
  return { ...base, ...rig.joints } as Record<JointId, JointPosition>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Lightweight constraints (§10). Deliberately NOT inverse kinematics: a moved
 * joint keeps the position the creator chose, and only its dependent middle
 * joint is nudged back onto its limb. Solving the whole chain would fight the
 * drag and make the rig feel like it is resisting the user.
 */
export function applyConstraints(joints: Record<JointId, JointPosition>): Record<JointId, JointPosition> {
  const next = { ...joints };
  for (const id of JOINT_IDS) {
    next[id] = { x: clamp01(next[id].x), y: clamp01(next[id].y) };
  }
  for (const { root, mid, tip } of LIMB_CHAINS) {
    const midpoint = { x: (next[root].x + next[tip].x) / 2, y: (next[root].y + next[tip].y) / 2 };
    const drift = Math.hypot(next[mid].x - midpoint.x, next[mid].y - midpoint.y);
    // Only correct an elbow/knee that has drifted implausibly far off its limb;
    // a bent joint is supposed to sit away from the midpoint.
    const maxDrift = 0.28;
    if (drift > maxDrift) {
      const scale = maxDrift / drift;
      next[mid] = {
        x: midpoint.x + (next[mid].x - midpoint.x) * scale,
        y: midpoint.y + (next[mid].y - midpoint.y) * scale,
      };
    }
  }
  return next;
}

/** Move one joint, returning a rig state with constraints applied. */
export function moveJoint(rig: PoseRigState, joint: JointId, position: JointPosition): PoseRigState {
  const base = findPoseDefinition(rig.basePose)?.joints ?? STANDING;
  const resolved = applyConstraints({ ...resolveJoints(rig), [joint]: position });

  const joints: Partial<Record<JointId, JointPosition>> = {};
  for (const id of JOINT_IDS) {
    const moved = Math.hypot(resolved[id].x - base[id].x, resolved[id].y - base[id].y) > 0.012;
    if (moved) joints[id] = resolved[id];
  }
  return { ...rig, joints, descriptors: deriveDescriptors(rig.basePose, resolved) };
}

export function resetPoseRig(rig: PoseRigState): PoseRigState {
  return createPoseRigState(rig.basePose);
}

export function isPoseEdited(rig: PoseRigState | undefined): boolean {
  return Boolean(rig && Object.keys(rig.joints).length > 0);
}

/**
 * Read semantic meaning out of joint positions (§3).
 *
 * Thresholds are intentionally coarse. A pose descriptor has to survive being
 * turned into a sentence for an image model, so "slightly higher than before"
 * is not a useful distinction — only changes big enough to draw differently
 * should register.
 */
export function deriveDescriptors(basePose: string, joints: Record<JointId, JointPosition>): string[] {
  const base = findPoseDefinition(basePose)?.joints ?? STANDING;
  const out: string[] = [];
  const moved = (id: JointId) => ({ dx: joints[id].x - base[id].x, dy: joints[id].y - base[id].y });

  for (const [side, hand, elbow, shoulder] of [
    ["left", "handLeft", "elbowLeft", "shoulderLeft"],
    ["right", "handRight", "elbowRight", "shoulderRight"],
  ] as [string, JointId, JointId, JointId][]) {
    const h = moved(hand);
    if (h.dy < -0.12) out.push(`${side} arm raised`);
    else if (h.dy > 0.12) out.push(`${side} arm lowered`);
    if (Math.abs(h.dx) > 0.12) out.push(`${side} arm extended ${h.dx > 0 ? "right" : "left"}`);
    // A bent elbow reads as the elbow sitting well off the shoulder-hand line.
    const midX = (joints[shoulder].x + joints[hand].x) / 2;
    const midY = (joints[shoulder].y + joints[hand].y) / 2;
    if (Math.hypot(joints[elbow].x - midX, joints[elbow].y - midY) > 0.1) out.push(`${side} elbow bent`);
  }

  const head = moved("head");
  if (Math.abs(head.dx) > 0.05) out.push(`head turned ${head.dx > 0 ? "right" : "left"}`);
  if (head.dy < -0.05) out.push("head tilted up");
  else if (head.dy > 0.05) out.push("head tilted down");

  const hips = moved("hips");
  if (Math.abs(hips.dx) > 0.06) out.push(`torso leaning ${hips.dx > 0 ? "left" : "right"}`);

  for (const [side, knee, foot] of [
    ["left", "kneeLeft", "footLeft"],
    ["right", "kneeRight", "footRight"],
  ] as [string, JointId, JointId][]) {
    const f = moved(foot);
    if (f.dy < -0.1) out.push(`${side} leg lifted`);
    const k = moved(knee);
    if (Math.abs(k.dx) > 0.1 || k.dy < -0.1) out.push(`${side} knee bent`);
  }

  return [...new Set(out)].sort();
}

export function poseDelta(rig: PoseRigState): PoseDelta {
  return {
    basePose: rig.basePose,
    descriptors: [...rig.descriptors],
    movedJoints: Object.keys(rig.joints) as JointId[],
  };
}

/** One sentence for the inspector and for the generation prompt (§11). */
export function describePoseRig(rig: PoseRigState | undefined, fallbackPose: string): string {
  const base = rig?.basePose ?? fallbackPose;
  const label = findPoseDefinition(base)?.label ?? titleCase(base);
  if (!rig || rig.descriptors.length === 0) return label;
  return `${label}, ${rig.descriptors.join(", ")}`;
}

/**
 * Semantic identity of a pose for cache lookups.
 *
 * Descriptors only — never raw joints. Keying on coordinates would make every
 * drag a distinct uncached state and defeat the whole point of the cache.
 */
export function poseRigKey(rig: PoseRigState | undefined): string {
  if (!rig || rig.descriptors.length === 0) return "";
  return `${rig.basePose}#${[...rig.descriptors].sort().join("|")}`;
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
