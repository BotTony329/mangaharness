/**
 * Camera intent — semantic direction compiled into the existing stage system.
 *
 * ## The gap this closes
 *
 * "Close up on Yuri", "low angle", "Yuri in front of Mori" used to survive only
 * as a sentence handed to the planner as a hint. Whether any of it reached the
 * document depended on what the model chose to emit, so the same prompt could
 * silently do nothing. Camera language is now parsed into a typed intent and
 * COMPILED into the camera, perspective, depth and focus commands Kumanga
 * already has.
 *
 * Two rules hold this together:
 *
 *   - **No second camera system.** Every field here maps onto an existing tool:
 *     `set_camera`, `set_perspective`, `set_character_depth`,
 *     `set_focal_character`. Nothing new renders.
 *   - **Relations, not coordinates.** "Mori behind Yuri" is a constraint between
 *     two actors. It is resolved to depth ORDER and handed to the stage
 *     projection, which already knows how to turn depth into scale and ground
 *     position. An LLM inventing pixel values would be guessing at arithmetic
 *     the harness can do exactly.
 *
 * Camera work is editing, never generation: a closer shot re-frames artwork that
 * already exists.
 */

import type { CameraAngle, CameraLens, ID, PerspectiveType, ProjectDocument, SceneDepth, ShotType } from "@/domain/types";

export interface DepthRelation {
  /** The actor nearer the camera. */
  nearerCharacterId: ID;
  fartherCharacterId: ID;
}

export interface CameraIntent {
  shot?: ShotType;
  angle?: CameraAngle;
  lens?: CameraLens;
  /** Dutch tilt in degrees; the existing camera stores this as `roll`. */
  roll?: number;
  perspective?: PerspectiveType;
  focalCharacterId?: ID;
  /** Absolute placements: "Yuri in the foreground". */
  placements?: { characterId: ID; placement: SceneDepth }[];
  /** Relative constraints: "Mori behind Yuri". */
  relations?: DepthRelation[];
}

export function isEmptyCameraIntent(intent: CameraIntent | undefined): boolean {
  if (!intent) return true;
  return (
    intent.shot === undefined &&
    intent.angle === undefined &&
    intent.lens === undefined &&
    intent.roll === undefined &&
    intent.perspective === undefined &&
    intent.focalCharacterId === undefined &&
    (intent.placements?.length ?? 0) === 0 &&
    (intent.relations?.length ?? 0) === 0
  );
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * Longest phrase first inside each group, so "extreme close up" is not eaten by
 * "close up" and 特写 is not eaten by 近.
 */
const SHOTS: [RegExp, ShotType][] = [
  [/\bextreme close[- ]?ups?\b|大特写|极特写/i, "extreme-close-up"],
  [/\bclose[- ]?ups?\b|\bcloser\b|特写|拉近|推近|近景|近距离/i, "close-up"],
  [/\bmedium shots?\b|\bmid shots?\b|中景/i, "medium"],
  [/\bfull shots?\b|\bfull body\b|全身|全景/i, "full"],
  [/\bextreme wide\b|超广角|大远景/i, "extreme-wide"],
  [/\bwide shots?\b|\blong shots?\b|\bpull back\b|\bfarther\b|远景|拉远|广角镜头/i, "wide"],
];

const ANGLES: [RegExp, CameraAngle][] = [
  [/\boverhead\b|\bbird'?s[- ]eye\b|\btop[- ]down\b|俯瞰|鸟瞰|顶视/i, "overhead"],
  [/\bdutch\b|\btilted camera\b|斜角|荷兰角|倾斜镜头/i, "dutch"],
  [/\blow[- ]angle\b|\bfrom below\b|\blow camera\b|低机位|仰角|仰拍|低角度/i, "low"],
  [/\bhigh[- ]angle\b|\bfrom above\b|高机位|俯角|俯拍|高角度/i, "high"],
  [/\beye[- ]level\b|平视|水平机位/i, "eye-level"],
];

const LENSES: [RegExp, CameraLens][] = [
  [/\bwide[- ]angle\b|\bwide lens\b|广角/i, "wide"],
  [/\btelephoto\b|\blong lens\b|长焦|望远/i, "telephoto"],
  [/\bnormal lens\b|标准镜头/i, "normal"],
];

const PERSPECTIVES: [RegExp, PerspectiveType][] = [
  [/\bthree[- ]point perspective\b|三点透视/i, "three-point"],
  [/\btwo[- ]point perspective\b|两点透视|二点透视/i, "two-point"],
  [/\bone[- ]point perspective\b|一点透视|单点透视/i, "one-point"],
];

/** Dutch angle is stored as a roll, so it needs a concrete tilt. */
const DUTCH_ROLL_DEGREES = 12;

const FOREGROUND = /\bforeground\b|\bin front\b|\bup front\b|前景|最前面/i;
const BACKGROUND = /\bbackground\b|\bat the back\b|\bfar behind\b|背景|最后面|远处/i;

function firstMatch<T>(text: string, table: [RegExp, T][]): T | undefined {
  for (const [pattern, value] of table) if (pattern.test(text)) return value;
  return undefined;
}

/**
 * Names in the order they appear, so "Yuri in front of Mori" knows which side
 * of the relation each actor is on.
 */
function orderedMentions(text: string, doc: ProjectDocument, candidates: ID[]): { id: ID; at: number }[] {
  const found: { id: ID; at: number }[] = [];
  for (const id of candidates) {
    const name = doc.characters[id]?.name;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    const at = text.toLowerCase().indexOf(name.toLowerCase());
    if (at >= 0) found.push({ id, at });
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * Relative depth phrasing.
 *
 * The subject of "A in front of B" is nearer; "A behind B" reverses it. Chinese
 * puts the relation after both nouns (A 在 B 前面 / 后面 / 身后), so the same
 * ordered-mention pass serves both once the direction word is known.
 */
const IN_FRONT_OF = /\bin front of\b|\bahead of\b|前面|前方|之前/i;
const BEHIND = /\bbehind\b|\bback of\b|后面|身后|后方|之后的街|背后/i;

export interface ParseCameraInput {
  text: string;
  doc: ProjectDocument;
  /** Characters grounded in this fragment, subject first. */
  characterIds: ID[];
  /** Who the beat is about, used for "focus on" and bare "close-up". */
  subjectId?: ID;
}

/** Read camera direction out of one fragment. Absent language yields an empty intent. */
export function parseCameraIntent(input: ParseCameraInput): CameraIntent {
  const { text, doc, characterIds, subjectId } = input;
  const intent: CameraIntent = {};

  intent.shot = firstMatch(text, SHOTS);
  intent.angle = firstMatch(text, ANGLES);
  intent.lens = firstMatch(text, LENSES);
  intent.perspective = firstMatch(text, PERSPECTIVES);
  if (intent.angle === "dutch") intent.roll = DUTCH_ROLL_DEGREES;

  const mentions = orderedMentions(text, doc, characterIds);

  /**
   * "Focus on X" / "close-up of X" names the focal subject. A shot change with
   * no name focuses the beat's own subject, which is what "拉近" after naming
   * her means.
   */
  const focusPhrase = /\bfocus (?:on|to)\b|\bclose[- ]?up (?:of|on)\b|聚焦|对准|镜头拉近|拍/i.test(text);
  if (focusPhrase && mentions.length > 0) intent.focalCharacterId = mentions[0].id;
  else if (intent.shot && subjectId) intent.focalCharacterId = subjectId;

  /**
   * Depth is read CLAUSE BY CLAUSE.
   *
   * "Yuri在前景，Mori站在她身后的街道上" is two statements: one places Yuri, the
   * other relates Mori to a pronoun. Reading the whole fragment at once made
   * the two clauses share their mentions, so "身后" was applied between Yuri and
   * Mori in whichever order they happened to appear — which put the wrong actor
   * in front.
   *
   * Within a clause: the FIRST named character is the subject of the relation,
   * in both "A in front of B" and "A 在 B 前面". A clause naming only one
   * character relates it to the beat's subject, which is who the pronoun means.
   */
  const placements: { characterId: ID; placement: SceneDepth }[] = [];
  const relations: DepthRelation[] = [];

  for (const clause of text.split(/[,，、;；。.]/).map((part) => part.trim()).filter(Boolean)) {
    const named = orderedMentions(clause, doc, characterIds);
    const inFront = IN_FRONT_OF.test(clause);
    const behind = BEHIND.test(clause);

    if (FOREGROUND.test(clause) && named.length > 0) {
      placements.push({ characterId: named[0].id, placement: "foreground" });
      continue;
    }
    if (BACKGROUND.test(clause) && named.length > 0) {
      placements.push({ characterId: named[named.length - 1].id, placement: "background" });
      continue;
    }
    if (!inFront && !behind) continue;

    if (named.length >= 2) {
      const [first, second] = named;
      relations.push(
        inFront
          ? { nearerCharacterId: first.id, fartherCharacterId: second.id }
          : { nearerCharacterId: second.id, fartherCharacterId: first.id },
      );
    } else if (named.length === 1 && subjectId && named[0].id !== subjectId) {
      // "Mori 站在她身后" — the pronoun is the beat's subject.
      relations.push(
        inFront
          ? { nearerCharacterId: named[0].id, fartherCharacterId: subjectId }
          : { nearerCharacterId: subjectId, fartherCharacterId: named[0].id },
      );
    }
  }

  if (placements.length > 0) intent.placements = placements;
  if (relations.length > 0) intent.relations = relations;

  for (const key of Object.keys(intent) as (keyof CameraIntent)[]) {
    if (intent[key] === undefined) delete intent[key];
  }
  return intent;
}

/**
 * Turn a relation into depth placements the stage can execute.
 *
 * Resolved as ORDER, never as coordinates: the nearer actor goes to the
 * foreground band and the farther one behind it, and the existing projection
 * decides what that means in pixels.
 */
export function resolveDepthPlacements(intent: CameraIntent): { characterId: ID; placement: SceneDepth }[] {
  const byCharacter = new Map<ID, SceneDepth>();
  for (const placement of intent.placements ?? []) byCharacter.set(placement.characterId, placement.placement);

  for (const relation of intent.relations ?? []) {
    const near = byCharacter.get(relation.nearerCharacterId);
    const far = byCharacter.get(relation.fartherCharacterId);
    // Respect anything stated absolutely; only fill in what the relation adds.
    if (!near) byCharacter.set(relation.nearerCharacterId, far === "midground" ? "foreground" : "foreground");
    if (!far) byCharacter.set(relation.fartherCharacterId, near === "background" ? "background" : "midground");
  }
  return [...byCharacter].map(([characterId, placement]) => ({ characterId, placement }));
}

/** A creator-facing sentence for the run log. */
export function describeCameraIntent(intent: CameraIntent, doc: ProjectDocument): string[] {
  const lines: string[] = [];
  if (intent.shot) lines.push(`shot: ${intent.shot.replace(/-/g, " ")}`);
  if (intent.angle) lines.push(`angle: ${intent.angle.replace(/-/g, " ")}`);
  if (intent.lens) lines.push(`lens: ${intent.lens}`);
  if (intent.perspective) lines.push(`perspective: ${intent.perspective.replace(/-/g, " ")}`);
  if (intent.focalCharacterId) lines.push(`focus: ${doc.characters[intent.focalCharacterId]?.name ?? intent.focalCharacterId}`);
  for (const placement of resolveDepthPlacements(intent)) {
    lines.push(`${doc.characters[placement.characterId]?.name ?? placement.characterId}: ${placement.placement}`);
  }
  return lines;
}
