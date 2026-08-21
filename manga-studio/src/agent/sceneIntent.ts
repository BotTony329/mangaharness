/**
 * Scene intent — the semantic layer between a sentence and editor commands.
 *
 * ## Why this exists
 *
 * The Agent used to go straight from LLM text to low-level tool calls, which
 * made three things impossible:
 *
 *   - **Explaining a failure.** "The scoped object is not a character asset"
 *     was the whole story. There was no recorded notion of who the subject was
 *     or what was being asked, so nothing better could be printed.
 *   - **Temporal language.** "Cute Girl runs to the camera and THEN shouts" is
 *     two beats. Flattened into one panel it becomes a single confused image.
 *     Manga expresses time through panel progression; a plan that has no
 *     concept of a beat cannot choose to use one.
 *   - **Camera intent.** "Run to the camera" is not `pose = running`. It says
 *     the actor moves toward the viewer, which has framing consequences the
 *     stage system already knows how to express — but only if the intent
 *     survives long enough to reach it.
 *
 * This module produces a `SceneIntent` deterministically from the prompt and
 * the grounding report, BEFORE the planner is asked for tools. It is derived
 * from the user's own words: it never invents an actor, and an unrecognised
 * sentence yields one plain beat rather than a guess.
 */

import type { ID, InteractionType, ProjectDocument } from "@/domain/types";
import { INTERACTION_LABELS, interactionTypeFromPhrase } from "@/domain/interactions";
import type { GroundingReport } from "./grounding";
import type { AgentRunScope } from "./scope";
import type { SubjectResolution } from "./subject";

export type BeatType = "movement" | "dialogue" | "expression" | "interaction" | "action";

/** Where the actor moves relative to the viewer — camera intent, not a pose. */
export type MovementDirection = "toward_camera" | "away_from_camera" | "lateral" | "unspecified";

export interface SceneBeat {
  type: BeatType;
  /** The character performing this beat. */
  actor?: ID;
  /** The verb, in the user's words, normalised to lower case. */
  action?: string;
  direction?: MovementDirection;
  /** Dialogue delivery — decides the bubble type. */
  delivery?: "normal" | "shout" | "whisper" | "thought";
  /** Editor-native text. NEVER sent to an image model to render. */
  text?: string;
  /** Characters this beat refers to without acting on them. */
  references?: ID[];
  /** For an interaction beat: the other participant. */
  partner?: ID;
  /** The interaction the phrase named, when it named one. */
  interaction?: InteractionType;
  /** The user's fragment this beat came from, for the run log. */
  source: string;
}

export interface SceneIntent {
  scope: { pageId: ID; panelIds: ID[]; label: string };
  participants: { characterId: ID; role: "subject" | "referenced" }[];
  beats: SceneBeat[];
  /** True when the beats are sequential and need panel progression. */
  sequential: boolean;
  /** How many panels the beats want. */
  panelsRequested: number;
}

// ─── Language ───────────────────────────────────────────────────────────────

/** Connectives that mark a NEW beat rather than a second detail of the same one. */
const SEQUENCE_SPLIT = /\b(?:,\s*)?(?:and\s+then|then|after\s+that|afterwards|next)\b/i;

const TOWARD_CAMERA =
  /\b(?:to|toward|towards|into|at)\s+(?:the\s+)?(?:camera|viewer|screen|us|front)\b|\btoward\s+(?:the\s+)?reader\b/i;
const AWAY_FROM_CAMERA = /\b(?:away from|into the distance|to the back|off into)\b/i;

const MOVEMENT_VERBS = ["run", "runs", "running", "walk", "walks", "walking", "dash", "dashes", "rush", "rushes", "charge", "charges", "approach", "approaches", "flee", "flees"];
const SHOUT_VERBS = ["shout", "shouts", "shouting", "yell", "yells", "yelling", "scream", "screams", "screaming", "call", "calls", "calling", "cry out"];
const WHISPER_VERBS = ["whisper", "whispers", "whispering", "murmur", "murmurs"];
const SPEAK_VERBS = ["say", "says", "saying", "speak", "speaks", "tell", "tells", "reply", "replies", "answer", "answers"];

const EXPRESSION_WORDS: Record<string, string> = {
  smile: "smile", smiles: "smile", smiling: "smile", happy: "smile", happily: "smile",
  cry: "crying", cries: "crying", crying: "crying", sad: "crying",
  angry: "angry", angrily: "angry", furious: "angry",
  shocked: "shocked", surprised: "shocked", startled: "shocked",
  embarrassed: "embarrassed", blushing: "embarrassed",
  worried: "worried", nervous: "worried",
  laugh: "laugh", laughs: "laugh", laughing: "laugh",
};

const POSE_WORDS: Record<string, string> = {
  run: "running", runs: "running", running: "running",
  walk: "walking", walks: "walking", walking: "walking",
  sit: "sitting", sits: "sitting", sitting: "sitting",
  jump: "jumping", jumps: "jumping", jumping: "jumping",
  stand: "standing", stands: "standing", standing: "standing",
  point: "pointing", points: "pointing", pointing: "pointing",
};

function has(fragment: string, words: string[]): string | undefined {
  const lower = fragment.toLowerCase();
  return words.find((word) => new RegExp(`\\b${word}\\b`).test(lower));
}

/**
 * Whose name is being SHOUTED, as opposed to who is shouting.
 *
 * "shouting Yuri's name" means the dialogue is "Yuri!" and Yuri is referenced,
 * not that Yuri speaks. Getting this backwards puts the line in the wrong
 * character's mouth.
 */
function shoutedName(fragment: string, doc: ProjectDocument, candidates: ID[]): ID | undefined {
  const lower = fragment.toLowerCase();
  return candidates.find((id) => {
    const name = doc.characters[id]?.name;
    if (!name) return false;
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return new RegExp(`\\b${n}(?:'s|’s)?\\s+name\\b`).test(lower) || new RegExp(`["'“]${n}`).test(lower);
  });
}

// ─── Derivation ─────────────────────────────────────────────────────────────

/**
 * Build the semantic plan.
 *
 * Deterministic and offline: it runs before the planner, so the creator sees
 * what the Agent understood even when the model call later fails, and so a
 * wrong understanding is visible instead of being buried in a tool list.
 */
export function deriveSceneIntent(input: {
  doc: ProjectDocument;
  prompt: string;
  grounding: GroundingReport;
  subject: SubjectResolution;
  scope: AgentRunScope;
}): SceneIntent {
  const { doc, prompt, grounding, subject, scope } = input;

  const page = doc.pages[scope.pageId];
  const panelIds = scope.panelId ? [scope.panelId] : (page?.panelIds ?? []);

  const grounded = grounding.entities
    .filter((entity) => entity.status === "resolved" && entity.characterId)
    .map((entity) => entity.characterId as ID);

  const subjectId = subject.characterIds[0];
  const participants: SceneIntent["participants"] = [];
  for (const id of grounded) {
    if (participants.some((p) => p.characterId === id)) continue;
    participants.push({ characterId: id, role: id === subjectId ? "subject" : "referenced" });
  }

  const fragments = prompt
    .split(SEQUENCE_SPLIT)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);

  const beats: SceneBeat[] = [];
  for (const fragment of fragments) {
    beats.push(...beatsFor(fragment, doc, subjectId, grounded));
  }

  // An unrecognised sentence still gets one honest beat rather than silence.
  if (beats.length === 0 && subjectId) {
    beats.push({ type: "action", actor: subjectId, action: prompt.trim().toLowerCase(), source: prompt.trim() });
  }

  /**
   * Sequential beats want panel progression. Two beats in one panel is a
   * drawing of somebody running and shouting at the same instant, which is not
   * what "then" asked for.
   */
  const sequential = fragments.length > 1 && beats.length > 1;
  const distinctMoments = sequential ? fragments.length : 1;

  return {
    scope: { pageId: scope.pageId, panelIds, label: scope.label },
    participants,
    beats,
    sequential,
    panelsRequested: Math.max(1, distinctMoments),
  };
}

function beatsFor(fragment: string, doc: ProjectDocument, subjectId: ID | undefined, grounded: ID[]): SceneBeat[] {
  const out: SceneBeat[] = [];

  /**
   * A coordinated action between two characters is ONE beat with two
   * participants, never two independent poses. Splitting "Yuri hugs Mori" into
   * "Yuri: hug" and "Mori: hug" is what produces two renders whose arms miss
   * each other — see `domain/interactions`.
   */
  const interaction = interactionTypeFromPhrase(fragment);
  const partner = grounded.find((id) => id !== subjectId);
  if (interaction && subjectId && partner) {
    out.push({
      type: "interaction",
      actor: subjectId,
      partner,
      interaction,
      action: INTERACTION_LABELS[interaction].toLowerCase(),
      source: fragment,
    });
  }

  const movement = has(fragment, MOVEMENT_VERBS);
  if (movement) {
    out.push({
      type: "movement",
      actor: subjectId,
      action: POSE_WORDS[movement] ?? movement,
      /**
       * "to the camera" is camera intent, not decoration: it means the actor
       * ends up nearer the viewer, which the stage system expresses as depth
       * and framing rather than as an arbitrary scale bump.
       */
      direction: TOWARD_CAMERA.test(fragment)
        ? "toward_camera"
        : AWAY_FROM_CAMERA.test(fragment)
          ? "away_from_camera"
          : "unspecified",
      source: fragment,
    });
  }

  const shout = has(fragment, SHOUT_VERBS);
  const whisper = has(fragment, WHISPER_VERBS);
  const speak = has(fragment, SPEAK_VERBS);
  if (shout || whisper || speak) {
    const named = shoutedName(fragment, doc, grounded.filter((id) => id !== subjectId));
    const quoted = fragment.match(/["'“]([^"'”]{1,60})["'”]/);
    /**
     * Dialogue text is editor-native. The image model is never asked to render
     * readable words — it cannot spell reliably, and text baked into pixels
     * stops being editable, translatable or re-typesettable.
     */
    const text = quoted?.[1] ?? (named ? `${doc.characters[named]?.name ?? ""}!` : undefined);
    out.push({
      type: "dialogue",
      actor: subjectId,
      delivery: shout ? "shout" : whisper ? "whisper" : "normal",
      text,
      references: named ? [named] : undefined,
      source: fragment,
    });
  }

  const expressionWord = Object.keys(EXPRESSION_WORDS).find((word) => new RegExp(`\\b${word}\\b`, "i").test(fragment));
  if (expressionWord) {
    out.push({ type: "expression", actor: subjectId, action: EXPRESSION_WORDS[expressionWord], source: fragment });
  }

  return out;
}

/** One-line-per-beat summary for the run log. */
export function describeIntent(intent: SceneIntent, doc: ProjectDocument): string[] {
  return intent.beats.map((beat, index) => {
    const who = beat.actor ? (doc.characters[beat.actor]?.name ?? "someone") : "the panel";
    if (beat.type === "movement") {
      const where = beat.direction === "toward_camera" ? " toward the camera" : beat.direction === "away_from_camera" ? " away from the camera" : "";
      return `${index + 1}. ${who} ${beat.action}${where}`;
    }
    if (beat.type === "dialogue") {
      const verb = beat.delivery === "shout" ? "shouts" : beat.delivery === "whisper" ? "whispers" : "says";
      return `${index + 1}. ${who} ${verb}${beat.text ? ` "${beat.text}"` : ""}`;
    }
    if (beat.type === "interaction") {
      const other = beat.partner ? (doc.characters[beat.partner]?.name ?? "someone") : "someone";
      return `${index + 1}. ${who} + ${other}: ${beat.action}`;
    }
    if (beat.type === "expression") return `${index + 1}. ${who} looks ${beat.action}`;
    return `${index + 1}. ${who}: ${beat.action ?? beat.source}`;
  });
}
