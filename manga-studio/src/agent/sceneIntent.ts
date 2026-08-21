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

/**
 * Connectives that mark a NEW beat rather than a second detail of the same one.
 *
 * Chinese carries the same distinction without spaces or word boundaries, so
 * the CJK alternatives are matched literally. 下一格 ("the next panel") is the
 * strongest of them: it names the panel outright.
 *
 * "同时"/"meanwhile" is deliberately absent — it marks SIMULTANEITY, which is
 * one moment, and splitting on it would invent a panel the creator did not ask
 * for. It is listed in SIMULTANEOUS below so it is recognised and ignored.
 */
const SEQUENCE_SPLIT =
  /(?:\b(?:,\s*)?(?:and\s+then|then|after\s+that|afterwards|next)\b)|然后|接着|下一格|下一個格|随后|隨後|之后|之後|再来|再來/i;

/** Marks one moment with two things happening in it. Never splits a beat. */
const SIMULTANEOUS = /\bmeanwhile\b|\bat the same time\b|\bwhile\b|与此同时|與此同時|同时|同時|一边|一邊/i;

/** Explicit panel naming: "第一格", "panel 2", "下一格". */
const PANEL_ORDINALS: [RegExp, number][] = [
  [/第一格|第1格|\bpanel\s*1\b|\bfirst panel\b/i, 1],
  [/第二格|第2格|\bpanel\s*2\b|\bsecond panel\b/i, 2],
  [/第三格|第3格|\bpanel\s*3\b|\bthird panel\b/i, 3],
  [/第四格|第4格|\bpanel\s*4\b|\bfourth panel\b/i, 4],
];

/** The fragment asks for the FOLLOWING panel rather than a numbered one. */
const NEXT_PANEL = /下一格|下一個格|\bnext panel\b|\bthe next frame\b/i;

/** An explicit panel number named in this fragment, when there is one. */
export function panelOrdinalIn(fragment: string): number | undefined {
  for (const [pattern, number] of PANEL_ORDINALS) if (pattern.test(fragment)) return number;
  return undefined;
}

export function namesNextPanel(fragment: string): boolean {
  return NEXT_PANEL.test(fragment);
}

const TOWARD_CAMERA =
  /\b(?:to|toward|towards|into|at)\s+(?:the\s+)?(?:camera|viewer|screen|us|front)\b|\btoward\s+(?:the\s+)?reader\b/i;
const AWAY_FROM_CAMERA = /\b(?:away from|into the distance|to the back|off into)\b/i;

const MOVEMENT_VERBS = ["run", "runs", "running", "walk", "walks", "walking", "dash", "dashes", "rush", "rushes", "charge", "charges", "approach", "approaches", "flee", "flees"];
const SHOUT_VERBS = ["shout", "shouts", "shouting", "yell", "yells", "yelling", "scream", "screams", "screaming", "call", "calls", "calling", "cry out"];
const WHISPER_VERBS = ["whisper", "whispers", "whispering", "murmur", "murmurs"];
const SPEAK_VERBS = ["say", "says", "saying", "speak", "speaks", "tell", "tells", "reply", "replies", "answer", "answers"];

/**
 * Chinese has no word boundaries, so these are matched as substrings rather
 * than through the \b-anchored helper the English lists use.
 */
const ZH_MOVEMENT: [RegExp, string][] = [
  [/跑向|跑到|跑过来|跑過來|奔向/, "running"],
  [/走进来|走進來|走向|走过来|走過來/, "walking"],
  [/跑/, "running"],
  [/走/, "walking"],
  [/坐下|坐着|坐著/, "sitting"],
  [/跳/, "jumping"],
];
const ZH_SHOUT = /喊|叫|大喊|吼|喊道/;
const ZH_WHISPER = /小声|小聲|低语|低語/;
const ZH_SPEAK = /说|說|问|問|回答|告诉|告訴/;
const ZH_LOOK_BACK = /回头看|回頭看|回头|回頭/;
const ZH_EXPRESSION: [RegExp, string][] = [
  [/微笑|笑着|笑著|开心|開心|高兴|高興/, "smile"],
  [/哭|流泪|流淚|伤心|傷心/, "crying"],
  [/生气|生氣|愤怒|憤怒/, "angry"],
  [/震惊|震驚|吃惊|吃驚|惊讶|驚訝/, "shocked"],
  [/害羞|脸红|臉紅|尴尬|尷尬/, "embarrassed"],
  [/担心|擔心|不安/, "worried"],
];

/** Toward-camera phrasing that the English regex cannot see. */
const ZH_TOWARD_CAMERA = /向镜头|向鏡頭|朝镜头|朝鏡頭|跑向.*镜头|向我们|向我們|冲过来|衝過來|跑过来|跑過來|走过来|走過來/;

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

  /**
   * Split on temporal connectives while KEEPING them.
   *
   * A plain split consumed the marker, so "下一格Yuri说你好" produced a fragment
   * that no longer contained 下一格 and the beat lost the one word that said
   * which panel it belonged in. The connective is re-attached to the fragment
   * it introduces, because that is the fragment it is about.
   */
  const parts = prompt.split(new RegExp(`(${SEQUENCE_SPLIT.source})`, "i"));
  const rawFragments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const connective = i === 0 ? "" : (parts[i - 1] ?? "");
    const text = `${connective}${parts[i] ?? ""}`.trim();
    if (text.length > 0) rawFragments.push(text);
  }

  /**
   * "Meanwhile" is not "then".
   *
   * A fragment that announces simultaneity describes the SAME moment as the one
   * before it, so it is folded back into that moment rather than becoming a new
   * beat. Splitting on it would invent a panel the creator never asked for —
   * "Yuri walks in while Mori watches" is one drawing.
   *
   * Folding is done by sharing the previous fragment's source string, because
   * moments are grouped by source downstream.
   */
  const fragments: { text: string; momentKey: string }[] = [];
  for (const fragment of rawFragments) {
    const simultaneous = SIMULTANEOUS.test(fragment) && fragments.length > 0;
    fragments.push({
      text: fragment,
      momentKey: simultaneous ? fragments[fragments.length - 1].momentKey : fragment,
    });
  }

  const beats: SceneBeat[] = [];
  for (const fragment of fragments) {
    const derived = beatsFor(fragment.text, doc, subjectId, grounded);
    /**
     * A moment with no recognised verb is still a moment.
     *
     * "第一格，Yuri在前景，用广角低机位" contains no action at all — it is pure
     * staging — and "下一格她看到Mori" uses a verb we do not model. Dropping
     * those fragments collapsed the sequence and silently discarded the camera
     * direction attached to them. Every fragment yields at least one beat.
     */
    if (derived.length === 0) {
      beats.push({ type: "action", actor: subjectId, source: fragment.momentKey });
    }
    for (const beat of derived) {
      // The source is the MOMENT key, so folded fragments group together.
      beats.push({ ...beat, source: fragment.momentKey });
    }
  }

  const momentCount = new Set(fragments.map((fragment) => fragment.momentKey)).size;

  /**
   * Sequential beats want panel progression. Two beats in one panel is a
   * drawing of somebody running and shouting at the same instant, which is not
   * what "then" asked for.
   */
  const sequential = momentCount > 1 && beats.length > 1;
  const distinctMoments = sequential ? momentCount : 1;

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
  const zhMovement = ZH_MOVEMENT.find(([pattern]) => pattern.test(fragment));
  if (movement || zhMovement) {
    out.push({
      type: "movement",
      actor: subjectId,
      action: zhMovement ? zhMovement[1] : POSE_WORDS[movement!] ?? movement,
      /**
       * "to the camera" is camera intent, not decoration: it means the actor
       * ends up nearer the viewer, which the stage system expresses as depth
       * and framing rather than as an arbitrary scale bump.
       */
      direction: TOWARD_CAMERA.test(fragment) || ZH_TOWARD_CAMERA.test(fragment)
        ? "toward_camera"
        : AWAY_FROM_CAMERA.test(fragment)
          ? "away_from_camera"
          : "unspecified",
      source: fragment,
    });
  }

  if (ZH_LOOK_BACK.test(fragment) && subjectId) {
    out.push({ type: "action", actor: subjectId, action: "looking back", source: fragment });
  }

  const shout = has(fragment, SHOUT_VERBS) || ZH_SHOUT.test(fragment);
  const whisper = has(fragment, WHISPER_VERBS) || ZH_WHISPER.test(fragment);
  const speak = has(fragment, SPEAK_VERBS) || ZH_SPEAK.test(fragment);
  if (shout || whisper || speak) {
    const named = shoutedName(fragment, doc, grounded.filter((id) => id !== subjectId));
    const quoted = fragment.match(/["'\u201c\u2018]([^"'\u201d\u2019]{1,60})["'\u201d\u2019]/);
    /**
     * Dialogue text is editor-native. The image model is never asked to render
     * readable words — it cannot spell reliably, and text baked into pixels
     * stops being editable, translatable or re-typesettable.
     */
    const text = quoted?.[1] ?? (named ? `${doc.characters[named]?.name ?? ""}!` : undefined);
    if (text) {
      out.push({
        type: "dialogue",
        actor: subjectId,
        delivery: shout ? "shout" : whisper ? "whisper" : "normal",
        text,
        references: named ? [named] : undefined,
        source: fragment,
      });
    }
  }

  const expressionWord = Object.keys(EXPRESSION_WORDS).find((word) => new RegExp(`\\b${word}\\b`, "i").test(fragment));
  const zhExpression = ZH_EXPRESSION.find(([pattern]) => pattern.test(fragment));
  if (expressionWord || zhExpression) {
    out.push({
      type: "expression",
      actor: subjectId,
      action: zhExpression ? zhExpression[1] : EXPRESSION_WORDS[expressionWord!],
      source: fragment,
    });
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
    // A staging-only moment has no verb; echoing the whole sentence back as if
    // it were an action reads like the Agent misunderstood it.
    return beat.action ? `${index + 1}. ${who}: ${beat.action}` : `${index + 1}. ${who} — staging and camera`;
  });
}
