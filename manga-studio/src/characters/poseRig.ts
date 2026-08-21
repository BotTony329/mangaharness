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

// ─── PoseIntent: the one semantic pose representation ───────────────────────

/**
 * The canonical pose representation (§1).
 *
 * BOTH the joint editor and the Manga Agent produce this. There is no
 * agent-only pose path: the Agent supplies descriptors, the editor supplies
 * joints and derives descriptors from them, and everything downstream — the
 * cache key, the resolver, the prompt — consumes only a PoseIntent.
 *
 * `jointOverrides` holds only the joints that were MOVED, normalized to the
 * character's own bounds, so a pose survives scaling, moving, reframing and
 * save/load (§4). Descriptors are the SEMANTIC reading and are the pose's
 * identity: keying the cache on coordinates would fork a distinct uncached
 * state on every pixel of drag.
 */
export interface PoseIntent {
  /** Preset the pose starts from. A preset is a starting pose, not a lock (§8). */
  basePose: string;
  /** Canonical, sorted, de-duplicated descriptors. */
  descriptors: string[];
  /** Sparse joint edits. Present for editor-authored intents (§8). */
  jointOverrides?: Partial<Record<JointId, JointPosition>>;
  torsoDirection?: Direction;
  headDirection?: Direction;
  motionVector?: { x: number; y: number };
}

/** Retained name for readability at call sites; the type is PoseIntent. */
export type PoseRigState = PoseIntent;

/** One semantic change relative to the base pose (§3). */
export interface PoseDelta {
  basePose: string;
  descriptors: string[];
  movedJoints: JointId[];
}

/**
 * Rig calibration for ONE rendered state (§4).
 *
 * Stored against the render, not the character: a walking render and a
 * crouching render need different alignment, and a single per-character fit
 * would be wrong for both.
 */
export interface PoseCalibration {
  /** Normalized anchor positions fitted to this specific artwork. */
  anchors: Partial<Record<JointId, JointPosition>>;
  updatedAt: string;
}

/** Anchors the calibration UI exposes. Deliberately the major landmarks only (§3). */
export const CALIBRATION_ANCHORS: JointId[] = [
  "head",
  "shoulderLeft",
  "shoulderRight",
  "hips",
  "handLeft",
  "handRight",
  "kneeLeft",
  "kneeRight",
  "footLeft",
  "footRight",
];

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

/** Joints that move when a given joint is calibrated, root-first. */
const DESCENDANTS: Record<JointId, JointId[]> = (() => {
  const children: Record<string, JointId[]> = {};
  for (const joint of JOINT_IDS) {
    const parent = JOINT_PARENT[joint];
    if (parent) (children[parent] ??= []).push(joint);
  }
  const collect = (joint: JointId): JointId[] =>
    (children[joint] ?? []).flatMap((child) => [child, ...collect(child)]);
  return Object.fromEntries(JOINT_IDS.map((joint) => [joint, collect(joint)])) as Record<JointId, JointId[]>;
})();

/** Root-first traversal so calibration deltas accumulate down the chain. */
const ROOT_FIRST: JointId[] = (() => {
  const depth = (joint: JointId): number => {
    let steps = 0;
    let current: JointId | null = joint;
    while (current && JOINT_PARENT[current]) {
      current = JOINT_PARENT[current];
      steps += 1;
    }
    return steps;
  };
  return [...JOINT_IDS].sort((a, b) => depth(a) - depth(b));
})();

/** Uncalibrated joints for a preset. Unknown presets fall back to standing. */
export function basePoseJoints(basePose: string): Record<JointId, JointPosition> {
  return findPoseDefinition(basePose)?.joints ?? STANDING;
}

export function createPoseIntent(basePose: string): PoseIntent {
  const id = basePose.trim().toLowerCase();
  const definition = findPoseDefinition(id);
  return {
    basePose: id,
    descriptors: [],
    jointOverrides: {},
    torsoDirection: definition?.torsoDirection,
    headDirection: definition?.headDirection,
    motionVector: definition?.motionVector,
  };
}

/** Backwards-compatible alias used by existing call sites. */
export const createPoseRigState = createPoseIntent;

/**
 * Shift the generic skeleton onto the actual artwork (§5).
 *
 * A calibrated joint carries its descendants with it, so aligning the hips
 * moves the whole lower body rather than detaching it. Without that, fitting
 * one landmark would visibly break the limb it belongs to.
 */
export function applyCalibration(
  joints: Record<JointId, JointPosition>,
  calibration: PoseCalibration | undefined,
): Record<JointId, JointPosition> {
  if (!calibration || Object.keys(calibration.anchors).length === 0) return joints;
  const out = { ...joints };
  for (const joint of ROOT_FIRST) {
    const anchor = calibration.anchors[joint];
    if (!anchor) continue;
    const dx = anchor.x - out[joint].x;
    const dy = anchor.y - out[joint].y;
    for (const affected of [joint, ...DESCENDANTS[joint]]) {
      out[affected] = { x: out[affected].x + dx, y: out[affected].y + dy };
    }
  }
  return out;
}

/**
 * Displayed skeleton = generic preset + state calibration + pose edits (§5).
 *
 * Calibration is applied BEFORE the pose edits so an edit is expressed in the
 * calibrated frame — the creator drags what they see.
 */
export function resolveJoints(
  intent: PoseIntent | undefined,
  calibration?: PoseCalibration,
): Record<JointId, JointPosition> {
  const base = basePoseJoints(intent?.basePose ?? "standing");
  const calibrated = applyCalibration(base, calibration);
  return { ...calibrated, ...(intent?.jointOverrides ?? {}) } as Record<JointId, JointPosition>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Lightweight constraints (§10 of Phase 3). Deliberately NOT inverse
 * kinematics: a moved joint keeps the position the creator chose, and only its
 * dependent middle joint is nudged back onto its limb. Solving the whole chain
 * would fight the drag and make the rig feel like it is resisting the user.
 */
export function applyConstraints(joints: Record<JointId, JointPosition>): Record<JointId, JointPosition> {
  const next = { ...joints };
  for (const id of JOINT_IDS) {
    next[id] = { x: clamp01(next[id].x), y: clamp01(next[id].y) };
  }
  for (const { root, mid, tip } of LIMB_CHAINS) {
    const midpoint = { x: (next[root].x + next[tip].x) / 2, y: (next[root].y + next[tip].y) / 2 };
    const drift = Math.hypot(next[mid].x - midpoint.x, next[mid].y - midpoint.y);
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

/**
 * Move one joint, returning an intent with constraints applied.
 *
 * Descriptors are measured against the CALIBRATED baseline, not the generic
 * preset — otherwise every calibrated character would read as permanently
 * "arm raised" merely because its artwork sits differently from the preset.
 */
export function moveJoint(
  intent: PoseIntent,
  joint: JointId,
  position: JointPosition,
  calibration?: PoseCalibration,
): PoseIntent {
  const baseline = applyCalibration(basePoseJoints(intent.basePose), calibration);
  const current = resolveJoints(intent, calibration);
  const dragged: Record<JointId, JointPosition> = { ...current, [joint]: position };
  const chain = LIMB_CHAINS.find((limb) => limb.tip === joint);
  if (chain) {
    // Follow at half the delta: the limb bends naturally instead of the mid
    // joint staying behind and registering a bend nobody asked for.
    const dx = (position.x - current[joint].x) / 2;
    const dy = (position.y - current[joint].y) / 2;
    dragged[chain.mid] = { x: current[chain.mid].x + dx, y: current[chain.mid].y + dy };
  }
  const resolved = applyConstraints(dragged);

  const jointOverrides: Partial<Record<JointId, JointPosition>> = {};
  for (const id of JOINT_IDS) {
    if (Math.hypot(resolved[id].x - baseline[id].x, resolved[id].y - baseline[id].y) > 0.012) {
      jointOverrides[id] = resolved[id];
    }
  }
  return normalizePoseIntent({ ...intent, jointOverrides, descriptors: deriveDescriptors(baseline, resolved) });
}

export function resetPoseIntent(intent: PoseIntent): PoseIntent {
  return createPoseIntent(intent.basePose);
}
export const resetPoseRig = resetPoseIntent;

export function isPoseEdited(intent: PoseIntent | undefined): boolean {
  return Boolean(intent && intent.descriptors.length > 0);
}

// ─── Descriptor vocabulary ──────────────────────────────────────────────────

/**
 * The canonical descriptor set (§7).
 *
 * One vocabulary shared by the joint editor and the Agent. Without it, "raise
 * her right hand" and a dragged arm would produce different strings for the
 * same pose, forking two cache entries and two generations for one intent.
 */
export const POSE_DESCRIPTORS = [
  "right arm raised",
  "left arm raised",
  "right arm lowered",
  "left arm lowered",
  "right arm extended",
  "left arm extended",
  "right elbow bent",
  "left elbow bent",
  "head turned left",
  "head turned right",
  "head tilted up",
  "head tilted down",
  "torso leaning forward",
  "torso leaning back",
  "torso leaning left",
  "torso leaning right",
  "right knee bent",
  "left knee bent",
  "right leg lifted",
  "left leg lifted",
  "feet apart",
  "walking stride",
  "running stride",
] as const;

export type PoseDescriptor = (typeof POSE_DESCRIPTORS)[number];

const DESCRIPTOR_SET = new Set<string>(POSE_DESCRIPTORS);

/** Phrases that mean the same thing, resolved before token parsing. */
const DESCRIPTOR_ALIASES: Record<string, PoseDescriptor> = {
  "arms crossed": "left elbow bent",
  "hands on hips": "left elbow bent",
  "legs apart": "feet apart",
  "stance wide": "feet apart",
  striding: "walking stride",
  sprinting: "running stride",
};

const SIDE_WORDS: Record<string, "left" | "right"> = { left: "left", right: "right" };
const PART_WORDS: Record<string, "arm" | "head" | "torso" | "knee" | "leg" | "feet" | "elbow"> = {
  arm: "arm",
  hand: "arm",
  hands: "feet" as never, // replaced below; placeholder never reached
  head: "head",
  face: "head",
  torso: "torso",
  body: "torso",
  chest: "torso",
  knee: "knee",
  knees: "knee",
  leg: "leg",
  legs: "leg",
  foot: "leg",
  feet: "feet",
  elbow: "elbow",
};
PART_WORDS.hands = "arm";

/** Verbs that imply a body part when none is named ("look left" = head). */
const IMPLIED_PART: Record<string, string> = {
  look: "head",
  looking: "head",
  glance: "head",
  turn: "head",
  turned: "head",
  turning: "head",
  lean: "torso",
  leaning: "torso",
  leans: "torso",
};

const ACTION_WORDS: Record<string, string> = {
  raise: "raised",
  raised: "raised",
  raising: "raised",
  lift: "raised",
  lifted: "raised",
  lifting: "raised",
  up: "raised",
  upward: "raised",
  lower: "lowered",
  lowered: "lowered",
  down: "lowered",
  downward: "lowered",
  drop: "lowered",
  dropped: "lowered",
  extend: "extended",
  extended: "extended",
  out: "extended",
  outstretched: "extended",
  reach: "extended",
  reaching: "extended",
  bend: "bent",
  bent: "bent",
  bending: "bent",
  turn: "turned",
  turned: "turned",
  turning: "turned",
  look: "turned",
  looking: "turned",
  tilt: "tilted",
  tilted: "tilted",
  lean: "leaning",
  leaning: "leaning",
  leans: "leaning",
  apart: "apart",
  wide: "apart",
};

const DIRECTION_WORDS = new Set(["left", "right", "up", "down", "forward", "back", "backward"]);

/**
 * Map free text onto the canonical vocabulary, or null when nothing matches.
 *
 * Token-based rather than a lookup table, so unseen phrasings still resolve:
 * "lift her right arm up", "right hand up" and "raise right arm" all reduce to
 * side=right, part=arm, action=raised.
 */
export function normalizeDescriptor(input: string): PoseDescriptor | null {
  const text = input.trim().toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (DESCRIPTOR_SET.has(text)) return text as PoseDescriptor;
  if (DESCRIPTOR_ALIASES[text]) return DESCRIPTOR_ALIASES[text];
  if (text.includes("walking stride") || text === "walking") return "walking stride";
  if (text.includes("running stride") || text === "running") return "running stride";

  const tokens = text.split(" ");
  let side: "left" | "right" | undefined;
  let part: string | undefined;
  let action: string | undefined;
  let direction: string | undefined;

  for (const token of tokens) {
    if (!part && IMPLIED_PART[token]) part = IMPLIED_PART[token];
    if (!part && PART_WORDS[token]) {
      part = PART_WORDS[token];
      continue;
    }
    if (ACTION_WORDS[token] && !action) {
      action = ACTION_WORDS[token];
      // "up"/"down" double as direction; keep them available for head/torso.
      if (DIRECTION_WORDS.has(token)) direction ??= token;
      continue;
    }
    if (SIDE_WORDS[token] && !side && !part) {
      side = SIDE_WORDS[token];
      continue;
    }
    if (DIRECTION_WORDS.has(token)) {
      direction ??= token;
      if (SIDE_WORDS[token] && !side && !part) side = SIDE_WORDS[token];
      continue;
    }
  }

  // For head and torso a bare side word IS the direction: "look right" names
  // where the head points, not which of two heads.
  if (part === "head" || part === "torso") direction ??= side;

  if (part === "head") {
    if (action === "tilted" || direction === "up" || direction === "down") {
      return direction === "down" ? "head tilted down" : "head tilted up";
    }
    if (direction === "left" || direction === "right") return `head turned ${direction}` as PoseDescriptor;
    return null;
  }
  if (part === "torso") {
    if (direction === "forward") return "torso leaning forward";
    if (direction === "back" || direction === "backward") return "torso leaning back";
    if (direction === "left" || direction === "right") return `torso leaning ${direction}` as PoseDescriptor;
    return null;
  }
  if (part === "feet" || (part === "leg" && action === "apart")) return "feet apart";
  if (!side) return null;
  if (part === "arm") {
    if (action === "raised" || action === "lowered" || action === "extended") {
      return `${side} arm ${action}` as PoseDescriptor;
    }
    if (action === "bent") return `${side} elbow bent` as PoseDescriptor;
    return null;
  }
  if (part === "elbow" && action === "bent") return `${side} elbow bent` as PoseDescriptor;
  if (part === "knee" && action === "bent") return `${side} knee bent` as PoseDescriptor;
  if (part === "leg" && (action === "raised" || action === "bent")) {
    return action === "raised" ? (`${side} leg lifted` as PoseDescriptor) : (`${side} knee bent` as PoseDescriptor);
  }
  return null;
}

/** Normalize a list, dropping anything unrecognized. Sorted and de-duplicated. */
export function normalizeDescriptors(inputs: string[]): PoseDescriptor[] {
  const out = new Set<PoseDescriptor>();
  for (const input of inputs) {
    const descriptor = normalizeDescriptor(input);
    if (descriptor) out.add(descriptor);
  }
  return [...out].sort();
}

/**
 * Enforce the consistency rule (§8): joint edits are authoring truth,
 * descriptors summarize them. An intent carrying joints always has its
 * descriptors re-derived; a descriptor-only intent (the Agent's) keeps its
 * normalized descriptors.
 */
export function normalizePoseIntent(intent: PoseIntent, calibration?: PoseCalibration): PoseIntent {
  const basePose = intent.basePose.trim().toLowerCase();
  const overrides = intent.jointOverrides ?? {};
  const hasJoints = Object.keys(overrides).length > 0;
  const baseline = applyCalibration(basePoseJoints(basePose), calibration);
  const descriptors = hasJoints
    ? deriveDescriptors(baseline, { ...baseline, ...overrides } as Record<JointId, JointPosition>)
    : normalizeDescriptors(intent.descriptors);
  return { ...intent, basePose, descriptors, jointOverrides: hasJoints ? overrides : {} };
}

/** Build an intent from descriptors alone — the Agent's entry point (§6). */
export function poseIntentFromDescriptors(basePose: string, descriptors: string[]): PoseIntent {
  return normalizePoseIntent({ ...createPoseIntent(basePose), descriptors });
}

/**
 * Read semantic meaning out of joint positions (§3 of Phase 3).
 *
 * Compared against a BASELINE rather than the raw preset, so a calibrated
 * character is measured from where its artwork actually sits.
 */
export function deriveDescriptors(
  baseline: Record<JointId, JointPosition>,
  joints: Record<JointId, JointPosition>,
): PoseDescriptor[] {
  const out: PoseDescriptor[] = [];
  const moved = (id: JointId) => ({ dx: joints[id].x - baseline[id].x, dy: joints[id].y - baseline[id].y });

  for (const [side, hand, elbow, shoulder] of [
    ["left", "handLeft", "elbowLeft", "shoulderLeft"],
    ["right", "handRight", "elbowRight", "shoulderRight"],
  ] as [string, JointId, JointId, JointId][]) {
    const h = moved(hand);
    if (h.dy < -0.12) out.push(`${side} arm raised` as PoseDescriptor);
    else if (h.dy > 0.12) out.push(`${side} arm lowered` as PoseDescriptor);
    if (Math.abs(h.dx) > 0.12) out.push(`${side} arm extended` as PoseDescriptor);
    if (bendOffset(joints, shoulder, elbow, hand) - bendOffset(baseline, shoulder, elbow, hand) > 0.08) {
      out.push(`${side} elbow bent` as PoseDescriptor);
    }
  }

  const head = moved("head");
  if (Math.abs(head.dx) > 0.05) out.push(head.dx > 0 ? "head turned right" : "head turned left");
  if (head.dy < -0.05) out.push("head tilted up");
  else if (head.dy > 0.05) out.push("head tilted down");

  const hips = moved("hips");
  if (Math.abs(hips.dx) > 0.06) out.push(hips.dx > 0 ? "torso leaning left" : "torso leaning right");

  for (const [side, knee, foot] of [
    ["left", "kneeLeft", "footLeft"],
    ["right", "kneeRight", "footRight"],
  ] as [string, JointId, JointId][]) {
    const f = moved(foot);
    if (f.dy < -0.1) out.push(`${side} leg lifted` as PoseDescriptor);
    const hipJoint: JointId = "hips";
    if (bendOffset(joints, hipJoint, knee, foot) - bendOffset(baseline, hipJoint, knee, foot) > 0.08) {
      out.push(`${side} knee bent` as PoseDescriptor);
    }
  }

  return [...new Set(out)].sort();
}

/** How far a middle joint sits off the straight line through its limb. */
function bendOffset(
  joints: Record<JointId, JointPosition>,
  root: JointId,
  mid: JointId,
  tip: JointId,
): number {
  const midX = (joints[root].x + joints[tip].x) / 2;
  const midY = (joints[root].y + joints[tip].y) / 2;
  return Math.hypot(joints[mid].x - midX, joints[mid].y - midY);
}

export function poseDelta(intent: PoseIntent): PoseDelta {
  return {
    basePose: intent.basePose,
    descriptors: [...intent.descriptors],
    movedJoints: Object.keys(intent.jointOverrides ?? {}) as JointId[],
  };
}

/** One sentence for the inspector and for the generation prompt. */
export function describePoseIntent(intent: PoseIntent | undefined, fallbackPose: string): string {
  const base = intent?.basePose ?? fallbackPose;
  const label = findPoseDefinition(base)?.label ?? titleCase(base);
  if (!intent || intent.descriptors.length === 0) return label;
  return `${label}, ${intent.descriptors.join(", ")}`;
}
export const describePoseRig = describePoseIntent;

/**
 * Semantic identity of a pose for cache lookups.
 *
 * Descriptors only — never joints. Keying on coordinates would make every drag
 * a distinct uncached state and defeat the cache entirely.
 */
export function poseIntentKey(intent: PoseIntent | undefined): string {
  if (!intent || intent.descriptors.length === 0) return "";
  return `${intent.basePose}#${[...intent.descriptors].sort().join("|")}`;
}
export const poseRigKey = poseIntentKey;

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
