/**
 * Deterministic Entity Grounding — the layer that runs BEFORE creative
 * planning and decides, without a model, which real project entities a prompt
 * refers to.
 *
 * The production failure this exists to end: the agent addressed characters by
 * free-text name, every executor call site independently ran a bidirectional
 * substring match (`name.includes(query) || query.includes(name)`), that match
 * returned the FIRST arbitrary hit with no ambiguity detection, and when it
 * found nothing the planner was free to invent a persistent Character instead.
 * Grounding replaces all of that with one resolver whose only outcomes are
 * RESOLVED, AMBIGUOUS, and NOT_FOUND — and NOT_FOUND never means create.
 *
 * Nothing here is heuristic about *meaning*. It matches names, stored aliases,
 * and the user's own selection. It will not decide that "best friend" is Cute
 * Girl, because that relationship is not structured project data.
 */

import type { Character, ID, ProjectDocument, RelationshipType } from "@/domain/types";
import { relatedCharacters, relationshipTypeFromPhrase } from "@/domain/relationships";
import { resolveUnmatched, type EntityResolution } from "./entityResolution";
import { applyAppositions } from "./coreference";
import { ACTION_VERBS, MOVEMENT_VERBS, SHOUT_VERBS, SPEAK_VERBS, WHISPER_VERBS } from "./sceneIntent";

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Case, spacing, punctuation and diacritics are noise; word identity is not.
 * "  YURI  " and "Yuri" are the same reference. "Yu ri" is not — see
 * `compactKey`, which is deliberately kept out of the auto-resolve ladder.
 */
export function normalizeReference(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalized with all separators removed. Used only to *suspect* a typo. */
function compactKey(value: string): string {
  return normalizeReference(value).replace(/ /g, "");
}

function tokens(value: string): string[] {
  const normalized = normalizeReference(value);
  return normalized.length > 0 ? normalized.split(" ") : [];
}

// ─── Result types ───────────────────────────────────────────────────────────

export type CharacterMatchType =
  | "id"
  | "relationship"
  | "exact-name"
  | "normalized-name"
  | "alias"
  | "selected-instance"
  | "recent-operation"
  | "sole-scene-character"
  | "unique-token";

export interface CharacterCandidate {
  characterId: ID;
  name: string;
  matchType: CharacterMatchType;
  /** Why this candidate is only a candidate. Surfaced verbatim in the UI. */
  note?: string;
}

export type CharacterResolution =
  | {
      status: "resolved";
      characterId: ID;
      name: string;
      confidence: number;
      matchType: CharacterMatchType;
    }
  | { status: "ambiguous"; query: string; candidates: CharacterCandidate[]; reason: string }
  | { status: "not-found"; query: string };

export interface CharacterReferenceInput {
  query: string;
  projectCharacters: Character[];
  /**
   * The project's relationship graph, and whose relationships to read.
   *
   * "her best friend" is resolvable ONLY when that edge exists as structured
   * project data. Without it the phrase stays unresolved — inferring who
   * someone's best friend probably is would be exactly the guessing this
   * resolver was built to eliminate.
   */
  relationships?: RelationshipLookup;
  /** The character behind the user's current selection — the pronoun anchor. */
  selectedCharacterId?: ID;
  selectedInstanceId?: ID;
  /** Last character this agent run acted on (§13 priority 2). */
  recentCharacterId?: ID;
  /** Characters present in the scoped panel (§13 priority 3). */
  sceneCharacterIds?: ID[];
}

const PRONOUNS = new Set([
  "her",
  "him",
  "she",
  "he",
  "them",
  "they",
  "hers",
  "his",
  "theirs",
  "herself",
  "himself",
  "themselves",
  "the character",
  "this character",
  "that character",
  "the girl",
  "the boy",
  "this one",
  "it",
]);

/**
 * Leading determiners mark a *description*, not a name. "the black-haired
 * girl" must never token-match its way onto a character called "Girl A" —
 * descriptions are resolved only by an explicitly stored alias, otherwise they
 * are reported ambiguous so a human decides.
 */
const DETERMINERS = new Set(["the", "a", "an", "that", "this", "her", "his", "their", "its", "one", "some"]);

const MIN_TOKEN_MATCH_LENGTH = 3;

/**
 * The one canonical character resolver. Every agent path — grounding, plan
 * validation, and each executor step — goes through this function, so there is
 * exactly one definition of "which character did they mean".
 */
export function resolveCharacterReference(input: CharacterReferenceInput): CharacterResolution {
  const { projectCharacters } = input;
  const raw = input.query.trim();
  if (raw.length === 0) return { status: "not-found", query: input.query };

  const byId = projectCharacters.find((character) => character.id === raw);
  if (byId) return resolved(byId, 1, "id");

  /**
   * A character with no usable name cannot be matched by name, and must not be
   * allowed to take grounding down with it.
   *
   * One malformed record used to throw inside this filter, which meant the
   * Understanding step failed for EVERY prompt in the project — a data problem
   * presenting as a total Agent outage. Nameless characters are simply not
   * name-matchable; they remain reachable by id and by selection.
   */
  const named = projectCharacters.filter(
    (character) => typeof character.name === "string" && character.name.trim().length > 0,
  );

  // 1. Exact name, byte for byte.
  const exact = named.filter((character) => character.name.trim() === raw);
  if (exact.length === 1) return resolved(exact[0], 1, "exact-name");
  if (exact.length > 1) return duplicateNames(raw, exact, "exact-name");

  const query = normalizeReference(raw);

  // 2. Normalized name: case, spacing, punctuation and diacritics folded.
  const normalized = named.filter((character) => normalizeReference(character.name) === query);
  if (normalized.length === 1) return resolved(normalized[0], 0.98, "normalized-name");
  if (normalized.length > 1) return duplicateNames(raw, normalized, "normalized-name");

  // 3. Explicitly stored aliases — structured project data, never inference.
  const aliased = projectCharacters.filter((character) =>
    (character.aliases ?? []).some((alias) => typeof alias === "string" && normalizeReference(alias) === query),
  );
  if (aliased.length === 1) return resolved(aliased[0], 0.95, "alias");
  if (aliased.length > 1) return duplicateNames(raw, aliased, "alias");

  // 4. Pronouns resolve to context, in the priority order of §13.
  if (PRONOUNS.has(query)) return resolvePronoun(input, raw);

  // 5. Explicit relationships: "her best friend" → whoever that edge names.
  const related = resolveByRelationship(input, raw);
  if (related) return related;

  const queryTokens = tokens(raw);

  /**
   * A description is not a name. Returning AMBIGUOUS here — rather than
   * picking the most plausible character — is the entire point: "the
   * black-haired girl" with three black-haired characters has no deterministic
   * answer, and guessing one is exactly the bug being fixed.
   */
  // "Yuri's friend" names a relationship, not Yuri. Resolving it to Yuri would
  // be the same class of error as resolving "best friend" to Cute Girl.
  const relational = /['\u2019]s\s+\S/.test(raw);
  if (relational || (queryTokens.length > 1 && DETERMINERS.has(queryTokens[0]))) {
    return projectCharacters.length === 0
      ? { status: "not-found", query: raw }
      : {
          status: "ambiguous",
          query: raw,
          reason: relational
            ? `"${raw}" describes a character by relationship, which is not recorded project data. Name the character directly.`
            : `"${raw}" describes a character rather than naming one. Say which character you mean.`,
          candidates: projectCharacters.map((character) => ({
            characterId: character.id,
            name: character.name,
            matchType: "unique-token" as const,
            note: "description could refer to any character",
          })),
        };
  }

  // 5. Safe close match: whole-token containment in either direction, accepted
  //    ONLY when exactly one character matches. "Yuri" finds "Yuri Tanaka";
  //    "Yuri-chan" finds "Yuri". Two matches is ambiguous, never first-wins.
  const tokenMatches = named.filter((character) => tokenContained(queryTokens, tokens(character.name)));
  if (tokenMatches.length === 1) return resolved(tokenMatches[0], 0.8, "unique-token");
  if (tokenMatches.length > 1) {
    return {
      status: "ambiguous",
      query: raw,
      reason: `"${raw}" matches ${tokenMatches.length} characters.`,
      candidates: tokenMatches.map((character) => ({
        characterId: character.id,
        name: character.name,
        matchType: "unique-token" as const,
      })),
    };
  }

  /**
   * 6. Suspected typo/split ("Yu ri" → "yuri"). Deliberately NOT auto-resolved:
   *    a misspelling is the user's mistake to confirm, and silently binding it
   *    to a persistent character is how the wrong character gets used. Reported
   *    as AMBIGUOUS with the suspicion attached, so the UI can offer it.
   */
  const compact = compactKey(raw);
  const compactMatches = named.filter(
    (character) =>
      compactKey(character.name) === compact ||
      (character.aliases ?? []).some((alias) => typeof alias === "string" && compactKey(alias) === compact),
  );
  if (compactMatches.length > 0) {
    return {
      status: "ambiguous",
      query: raw,
      reason: `"${raw}" is not a character name. Did you mean ${compactMatches.map((c) => `"${c.name}"`).join(" or ")}?`,
      candidates: compactMatches.map((character) => ({
        characterId: character.id,
        name: character.name,
        matchType: "normalized-name" as const,
        note: "spelling differs — confirm before using",
      })),
    };
  }

  return { status: "not-found", query: raw };
}

function resolved(character: Character, confidence: number, matchType: CharacterMatchType): CharacterResolution {
  return { status: "resolved", characterId: character.id, name: character.name, confidence, matchType };
}

/**
 * Two characters sharing a name is a real schema possibility. It resolves to
 * AMBIGUOUS rather than to whichever was created first.
 */
function duplicateNames(query: string, matches: Character[], matchType: CharacterMatchType): CharacterResolution {
  return {
    status: "ambiguous",
    query,
    reason: `${matches.length} characters are named "${query}".`,
    candidates: matches.map((character) => ({
      characterId: character.id,
      name: character.name,
      matchType,
      note: "duplicate name",
    })),
  };
}

/**
 * Whole-token containment, anchored on the name's leading token.
 *
 * Never substring — "Yu" must not match "Yuri". And never a trailing generic
 * noun: "Girl" must not match "Cute Girl", because the distinguishing part of
 * the name is the part the query left out. Requiring the leading token keeps
 * the useful cases ("Yuri" → "Yuri Tanaka", "Yuri-chan" → "Yuri") and drops
 * the guesses ("Girl", "Tanaka", "Chan").
 */
function tokenContained(queryTokens: string[], nameTokens: string[]): boolean {
  if (queryTokens.length === 0 || nameTokens.length === 0) return false;
  if (!queryTokens.includes(nameTokens[0])) return false;
  const [shorter, longer] =
    queryTokens.length <= nameTokens.length ? [queryTokens, nameTokens] : [nameTokens, queryTokens];
  if (shorter.some((token) => token.length < MIN_TOKEN_MATCH_LENGTH)) return false;
  const pool = new Set(longer);
  return shorter.every((token) => pool.has(token));
}

/** §13 priority order. Nothing here guesses; each step is a stated fact. */
function resolvePronoun(input: CharacterReferenceInput, raw: string): CharacterResolution {
  const find = (id: ID | undefined) => input.projectCharacters.find((character) => character.id === id);

  const selected = find(input.selectedCharacterId);
  if (selected) return resolved(selected, 0.95, "selected-instance");

  const recent = find(input.recentCharacterId);
  if (recent) return resolved(recent, 0.85, "recent-operation");

  const sceneIds = [...new Set(input.sceneCharacterIds ?? [])];
  if (sceneIds.length === 1) {
    const sole = find(sceneIds[0]);
    if (sole) return resolved(sole, 0.8, "sole-scene-character");
  }
  const sceneCharacters = sceneIds.map(find).filter((character): character is Character => Boolean(character));
  if (sceneCharacters.length > 1) {
    return {
      status: "ambiguous",
      query: raw,
      reason: `"${raw}" could be any of the characters in this panel. Select one first.`,
      candidates: sceneCharacters.map((character) => ({
        characterId: character.id,
        name: character.name,
        matchType: "sole-scene-character" as const,
      })),
    };
  }
  return { status: "not-found", query: raw };
}

// ─── Creation intent (§6) ───────────────────────────────────────────────────

export interface CreationAuthorization {
  /** True only when the user asked, in this prompt, for a NEW character. */
  allowed: boolean;
  /** Names the user explicitly asked to create; empty means "unnamed new character". */
  requestedNames: string[];
  reason: string;
}

const CREATION_VERB = /\b(create|design|invent|introduce|add|make|generate)\b/i;
const NEW_ENTITY =
  /\b(new|another|second|additional)\s+(?:[a-z-]+\s+){0,2}(character|girl|boy|woman|man|guy|lady|villain|hero|heroine|teacher|student|rival|friend|protagonist|antagonist|kid|child|cast\s+member)\b/i;
const NAMED_AS = /\b(?:named|called)\s+["“”']?([A-Za-z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/g;

/**
 * Persistent Character creation is privileged, so it is gated by an explicit
 * request — not by whether resolution happened to fail. "Yuri walks into the
 * room" can never authorize creating Yuri, which is precisely the production
 * failure. The gate is runtime policy; the model's opinion does not enter.
 */
export function detectCreationIntent(prompt: string): CreationAuthorization {
  const hasVerb = CREATION_VERB.test(prompt);
  const hasNewEntity = NEW_ENTITY.test(prompt);
  const names: string[] = [];
  for (const match of prompt.matchAll(NAMED_AS)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  const allowed = hasVerb && (hasNewEntity || names.length > 0);
  return {
    allowed,
    requestedNames: names,
    reason: allowed
      ? `Prompt explicitly requests a new character${names.length > 0 ? ` (${names.join(", ")})` : ""}.`
      : "Prompt does not request creating a new character.",
  };
}

// ─── Prompt grounding ───────────────────────────────────────────────────────

export interface GroundedEntity {
  /** The reference exactly as the user wrote it. */
  surface: string;
  type: "character";
  status: CharacterResolution["status"];
  characterId?: ID;
  name?: string;
  matchType?: CharacterMatchType;
  confidence?: number;
  /**
   * Where this reference appeared in the prompt.
   *
   * Reading order decides who the SUBJECT is: "Cute Girl … shouts Yuri's name"
   * is about Cute Girl. Entities used to come out in whichever order the
   * characters happened to be created in, which made the subject depend on
   * project history rather than on the sentence.
   */
  promptIndex?: number;
  candidates?: CharacterCandidate[];
  reason?: string;
  /**
   * Scene-local aliases bound by apposition ("his rival, the bad character
   * Roachman" → both name THIS participant). See `coreference.ts`. These are
   * not stored aliases and never reach the relationship graph.
   */
  sceneLocalAliases?: string[];
  /**
   * The relation an apposition alias asserts ("rival of Supermate"), anchored
   * to the subject the sentence already established. Scene-local only.
   */
  sceneRelation?: { type: RelationshipType; anchorCharacterId?: ID };
  /**
   * What should HAPPEN about this reference.
   *
   * Separate from `status`, which only says whether the library recognised it.
   * A name the library has never heard of is not a failure — it is a character
   * the creator just introduced, and it becomes an asset requirement.
   */
  resolution?: EntityResolution;
}

export interface GroundingReport {
  entities: GroundedEntity[];
  creation: CreationAuthorization;
  selectedCharacterId?: ID;
  selectedInstanceId?: ID;
  sceneCharacterIds: ID[];
  /**
   * Reasons the run must not start. Non-empty means: mutate nothing, generate
   * nothing, ask the user. A partially executed run is how the wrong character
   * ended up in the panel.
   */
  blocking: string[];
}

/** Look up an entity the plan named, by its surface form. */
export function groundedCharacterId(report: GroundingReport, surface: string): ID | undefined {
  const wanted = normalizeReference(surface);
  return report.entities.find(
    (entity) =>
      entity.status === "resolved" &&
      (normalizeReference(entity.surface) === wanted ||
        (entity.sceneLocalAliases ?? []).some((alias) => normalizeReference(alias) === wanted)),
  )?.characterId;
}

/**
 * Capitalized words that start manga instructions and are not character names.
 * A false positive here would block a legitimate run, so the list is generous.
 */
const NOT_A_NAME = new Set(
  [
    "a", "add", "adjust", "after", "an", "and", "angle", "another", "apply", "arrange", "as", "at",
    "background", "be", "before", "bubble", "build", "but", "by",
    "camera", "can", "change", "character", "close", "compose", "create", "crop",
    "delete", "design", "dialogue", "do", "draw", "dutch",
    "each", "effect", "every", "expression", "extreme",
    "face", "finally", "first", "focus", "for", "from", "full",
    "generate", "give", "have", "he", "her", "here", "hers", "him", "his", "how",
    "i", "if", "in", "insert", "into", "invent", "is", "it", "its",
    "keep", "left", "let", "line", "lines", "low", "make", "manga", "medium", "move",
    "narration", "new", "next", "no", "not", "now",
    "of", "on", "one", "only", "or", "out", "page", "panel", "panels", "place", "please", "pose",
    "prop", "put", "reframe", "remove", "replace", "reuse", "right",
    "scene", "screentone", "second", "set", "she", "shot", "show", "shout", "so", "speech", "speed",
    "start", "story", "style", "swap", "switch",
    "take", "that", "the", "their", "them", "then", "there", "these", "they", "third", "this",
    "three", "to", "tone", "turn", "two", "up", "use", "using",
    "we", "when", "where", "which", "while", "who", "why", "with", "without",
    "yonkoma", "you", "your", "zoom",
  ],
);

/** Character-frame evidence: words that introduce a person. */
const PERSON_DESCRIPTOR =
  /\b(?:guy|man|woman|girl|boy|kid|child|person|hero|heroine|villain|bad guy|enemy|rival|friend|stranger|robot|android|monster|creature|cat|dog|knight|ninja|samurai|witch|wizard|detective|student|teacher|character|protagonist|antagonist)\b/i;

/** Verbs that only a subject can perform, in any of the beat vocabularies. */
const ACTS_LIKE_A_CHARACTER = new RegExp(
  `\\b(?:${[...MOVEMENT_VERBS, ...ACTION_VERBS, ...SHOUT_VERBS, ...WHISPER_VERBS, ...SPEAK_VERBS].join("|")})\\b`,
  "i",
);

/** Spans of the prompt that are quoted dialogue text. */
function quotedRanges(prompt: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of prompt.matchAll(/["\u201c\u2018']([^"\u201d\u2019']{0,120})["\u201d\u2019']/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * Does the sentence treat this surface as a character?
 *
 * Either it is introduced as a person ("the bad guy Roach Man", "a robot named
 * Kumo") or it does something only a character can do ("Roach Man punches").
 */
function hasCharacterFrame(prompt: string, surface: string): boolean {
  const at = prompt.indexOf(surface);
  if (at < 0) return false;
  const before = prompt.slice(Math.max(0, at - 40), at);
  const after = prompt.slice(at + surface.length, at + surface.length + 40);
  if (PERSON_DESCRIPTOR.test(before)) return true;
  if (/\b(?:named|called)\s+$/i.test(before)) return true;
  return ACTS_LIKE_A_CHARACTER.test(after) || ACTS_LIKE_A_CHARACTER.test(before);
}

/**
 * Proper nouns the user wrote that match no character. These are what turn a
 * silent substitution into an explicit "I could not find Yuri".
 *
 * A capitalised word directly after a place/linking preposition ("in
 * Melbourne", "at home") is a LOCATION, not a person — unless the sentence
 * otherwise treats it as a character. Without this, every named city became a
 * character the run tried to create.
 */
const LOCATION_PREP = new Set(["in", "at", "on", "near", "inside", "outside", "behind", "beside", "under", "over", "to", "from", "into"]);

function unmatchedProperNouns(prompt: string, matchedSurfaces: Set<string>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const quoted = quotedRanges(prompt);
  // Sequences of capitalized words, so "Cute Girl" is one reference, not two.
  for (const match of prompt.matchAll(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)*\b/g)) {
    const surface = match[0];
    // Words inside quotes are the creator's dialogue text, not references to
    // anyone: 'a bubble saying "Hello Yuri"' names no one.
    if (quoted.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const key = normalizeReference(surface);
    if (seen.has(key) || matchedSurfaces.has(key)) continue;
    // A run of capitalized words is only ignored when EVERY word is a stopword,
    // so "Panel 2" is skipped but "The Hana" still surfaces "Hana".
    const words = key.split(" ");
    const meaningful = words.filter((word) => !NOT_A_NAME.has(word));
    if (meaningful.length === 0) continue;
    // "in Melbourne" names a place; "his rival, Roachman" names a person.
    const preceding = normalizeReference(prompt.slice(Math.max(0, match.index - 16), match.index)).split(" ").pop();
    if (preceding && LOCATION_PREP.has(preceding)) continue;
    seen.add(key);
    found.push(meaningful.join(" ") === key ? surface : meaningful.join(" "));
  }
  return found;
}

export interface GroundPromptInput {
  doc: ProjectDocument;
  prompt: string;
  selectedCharacterId?: ID;
  selectedInstanceId?: ID;
  sceneCharacterIds?: ID[];
}

/**
 * Turn a free-text prompt into resolved entities BEFORE the planner sees it.
 * The planner then operates on stable IDs instead of guessing identity, and
 * anything the grounder could not resolve is reported rather than invented.
 */
export function groundPrompt(input: GroundPromptInput): GroundingReport {
  const projectCharacters = Object.values(input.doc.characters);
  const creation = detectCreationIntent(input.prompt);
  const sceneCharacterIds = input.sceneCharacterIds ?? [];
  const entities: GroundedEntity[] = [];
  const matchedSurfaces = new Set<string>();

  // Every project character named in the prompt, matched on word boundaries so
  // "Mio" does not match inside "Miori".
  for (const character of projectCharacters) {
    for (const surface of [character.name, ...(character.aliases ?? [])]) {
      if (typeof surface !== "string" || surface.trim().length === 0) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(surface)}(?![\\p{L}\\p{N}])`, "iu");
      const hit = pattern.exec(input.prompt);
      if (!hit) continue;
      matchedSurfaces.add(normalizeReference(hit[0]));
      if (entities.some((entity) => entity.characterId === character.id)) continue;
      const resolution = resolveCharacterReference({
        query: hit[0],
        projectCharacters,
        selectedCharacterId: input.selectedCharacterId,
        recentCharacterId: undefined,
        sceneCharacterIds,
      });
      entities.push({ ...toEntity(hit[0], resolution), promptIndex: hit.index });
    }
  }

  /**
   * Reading order, not creation order.
   *
   * Whoever the sentence mentions first is the subject; sorting here is what
   * makes "let Cute Girl run … shouting Yuri's name" a request about Cute Girl
   * regardless of which character the project happened to store first.
   */
  entities.sort((a, b) => (a.promptIndex ?? Number.MAX_SAFE_INTEGER) - (b.promptIndex ?? Number.MAX_SAFE_INTEGER));

  // Names the user wrote that resolve to nothing. Unless creation was
  // explicitly requested for them, these block the run.
  const authorizedNames = new Set(creation.requestedNames.map(normalizeReference));
  for (const surface of unmatchedProperNouns(input.prompt, matchedSurfaces)) {
    const at = input.prompt.indexOf(surface);
    const resolution = resolveCharacterReference({ query: surface, projectCharacters });
    if (resolution.status === "resolved") {
      if (!entities.some((entity) => entity.characterId === resolution.characterId)) {
        entities.push({ ...toEntity(surface, resolution), promptIndex: at >= 0 ? at : undefined });
      }
      continue;
    }
    /**
     * GROUNDING IS NOT A CREATION GATE.
     *
     * A name the creator introduced in this very prompt ("a new robot named
     * Kumo") used to be skipped here, on the theory that creation was handled
     * elsewhere. Nothing handled it, so the entity vanished and the plan had
     * no one to act. An introduced name is a REQUIREMENT TO CREATE, and the
     * only way downstream stages can fulfil it is if it is on this list.
     */
    if (authorizedNames.has(normalizeReference(surface))) {
      entities.push({ ...toEntity(surface, resolution), promptIndex: at >= 0 ? at : undefined });
      continue;
    }
    /**
     * An unmatched capitalized word is only a CHARACTER when the sentence
     * treats it as one. In a project with no characters yet there is nothing to
     * corroborate against, so the sentence has to say so itself — through a
     * descriptor ("the bad guy Roach Man") or by having them do something
     * ("Roach Man punches"). Without that, a capitalized word is prose, and
     * creating a character from it would put a stranger in the creator's
     * library. This used to drop the name unconditionally, which is why the
     * brief's own example produced nothing at all in a fresh project.
     */
    if (projectCharacters.length === 0 && !creation.allowed && !hasCharacterFrame(input.prompt, surface)) continue;
    entities.push({ ...toEntity(surface, resolution), promptIndex: at >= 0 ? at : undefined });
  }

  /**
   * Relationship phrases resolve LAST, because the anchor is usually a
   * character named earlier in the same sentence: "Yuri hugs her best friend"
   * needs Yuri resolved before "her best friend" means anything.
   */
  const anchorId = input.selectedCharacterId ?? entities.find((entity) => entity.status === "resolved")?.characterId;
  if (anchorId) {
    for (const phrase of relationshipPhrases(input.prompt)) {
      if (entities.some((entity) => normalizeReference(entity.surface) === normalizeReference(phrase))) continue;
      const resolution = resolveCharacterReference({
        query: phrase,
        projectCharacters,
        selectedCharacterId: input.selectedCharacterId,
        sceneCharacterIds,
        relationships: {
          anchorCharacterId: anchorId,
          related: relatedCharacters(input.doc, anchorId).map((entry) => ({
            characterId: entry.characterId,
            type: entry.relationship.type,
            label: entry.relationship.label,
          })),
        },
      });
      // Only report a phrase the graph had an opinion about; an unrelated
      // "the room" must not become a blocking unresolved entity.
      const at = input.prompt.toLowerCase().indexOf(phrase.toLowerCase());
      if (resolution.status === "resolved" || resolution.status === "ambiguous" || relationshipTypeFromPhrase(phrase)) {
        entities.push({ ...toEntity(phrase, resolution), promptIndex: at >= 0 ? at : undefined });
        /**
         * Longest match wins.
         *
         * A project may contain a character literally called "friend", and
         * "her close friend" contains that word. Both matched, so the request
         * appeared to be about two people — the relationship partner AND an
         * unrelated character who happens to share a noun with the phrase.
         * A name swallowed by a longer relationship phrase at the same position
         * is part of that phrase, not a separate reference.
         */
        if (at >= 0) {
          const end = at + phrase.length;
          for (let i = entities.length - 2; i >= 0; i -= 1) {
            const other = entities[i];
            if (other.matchType === "relationship") continue;
            const start = other.promptIndex;
            if (start === undefined) continue;
            if (start >= at && start + other.surface.length <= end) entities.splice(i, 1);
          }
        }
      }
    }
  }

  entities.sort((a, b) => (a.promptIndex ?? Number.MAX_SAFE_INTEGER) - (b.promptIndex ?? Number.MAX_SAFE_INTEGER));

  /**
   * Co-reference BEFORE resolution decides outcomes.
   *
   * "his rival, the bad character Roachman" is one participant said twice.
   * Folding the apposition here is what stops the pointing half from blocking
   * the run while the named half is created — without weakening the rule that
   * a bare pointing reference ("her sister", no name attached) still blocks.
   */
  applyAppositions(input.prompt, entities, input.selectedCharacterId);

  /**
   * Decide what each unmatched reference MEANS before deciding whether to stop.
   *
   * Grounding prefers what already exists; it is not a creation gate. A
   * self-identifying reference ("Roach Man", "a cockroach superhero") becomes a
   * requirement to create. A pointing reference ("her sister", "the teacher")
   * that the project cannot answer is the only thing that blocks, because
   * inventing an answer to it would put a character in the creator's manga that
   * they never wrote.
   */
  for (const entity of entities) {
    if (entity.status === "resolved" && entity.characterId) {
      entity.resolution = {
        status: "existing",
        kind: "character",
        entityId: entity.characterId,
        name: entity.name ?? entity.surface,
      };
      continue;
    }
    const resolution = resolveUnmatched({
      surface: entity.surface,
      kind: "character",
      ambiguous: entity.status === "ambiguous",
      ambiguityReason: entity.reason,
    });
    /**
     * "Kumo" is the name; "a new robot named Kumo" is the character. The bare
     * proper noun is what the prompt scanner sees, but the phrase around it is
     * what an artist would need in order to draw them, so the description keeps
     * the whole introduction.
     */
    if (resolution.status === "create") {
      const phrase = introducingPhrase(input.prompt, resolution.proposedName);
      if (phrase) resolution.description = phrase;
    }
    entity.resolution = resolution;
  }

  const blocking = entities
    .filter((entity) => entity.resolution?.status === "unresolved")
    .map((entity) =>
      entity.resolution?.status === "unresolved"
        ? entity.resolution.reason
        : `Could not resolve "${entity.surface}".`,
    );

  return {
    entities,
    creation,
    selectedCharacterId: input.selectedCharacterId,
    selectedInstanceId: input.selectedInstanceId,
    sceneCharacterIds,
    blocking,
  };
}

/**
 * The noun phrase that introduced a name, if the creator wrote one.
 *
 * "Yuri hugs a new robot named Kumo" → "a new robot named Kumo".
 */
function introducingPhrase(prompt: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b(?:a|an|the|this)\\s+(?:[\\w'\u2019-]+\\s+){0,4}?(?:named|called)\\s+["\u201c']?${escapeRegex(name)}`,
    "i",
  );
  const hit = pattern.exec(prompt);
  return hit?.[0]?.replace(/["\u201c']$/, "").trim();
}

function toEntity(surface: string, resolution: CharacterResolution): GroundedEntity {
  if (resolution.status === "resolved") {
    return {
      surface,
      type: "character",
      status: "resolved",
      characterId: resolution.characterId,
      name: resolution.name,
      matchType: resolution.matchType,
      confidence: resolution.confidence,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      surface,
      type: "character",
      status: "ambiguous",
      candidates: resolution.candidates,
      reason: resolution.reason,
    };
  }
  return { surface, type: "character", status: "not-found" };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The grounding block injected into planner context. Stable IDs, one line per
 * entity — the planner is told the answer instead of asked to infer it.
 */
export function groundingContext(report: GroundingReport): string[] {
  const lines: string[] = ["", "RESOLVED ENTITIES (authoritative — use these IDs, never re-guess a name):"];
  const resolvedEntities = report.entities.filter((entity) => entity.status === "resolved");
  if (resolvedEntities.length === 0) lines.push("- none referenced by name");
  for (const entity of resolvedEntities) {
    const aliases = entity.sceneLocalAliases?.length
      ? ` — also answers to ${entity.sceneLocalAliases.map((a) => `"${a}"`).join(", ")} in this scene${
          entity.sceneRelation ? ` (${entity.sceneRelation.type})` : ""
        }`
      : "";
    lines.push(`- "${entity.surface}" → character ${entity.characterId} (${entity.name})${aliases}`);
  }
  /**
   * What the planner is told about everyone else.
   *
   * This block is the direct cause of the refusal this architecture exists to
   * remove. It used to say "CHARACTER CREATION: FORBIDDEN for this run" for
   * every prompt that did not contain a creation verb, and the model dutifully
   * answered "Roach Man does not exist … creating new characters is forbidden
   * for this run" — the runtime never even ran. A character the creator
   * introduced is not a forbidden creation; they are a character who will
   * exist by the time these steps run, and the planner must compose with them.
   */
  const beingCreated = report.entities.filter((entity) => entity.resolution?.status === "create");
  for (const entity of beingCreated) {
    const resolution = entity.resolution as Extract<EntityResolution, { status: "create" }>;
    const aliases = entity.sceneLocalAliases?.length
      ? ` The phrase${entity.sceneLocalAliases.length > 1 ? "s" : ""} ${entity.sceneLocalAliases
          .map((a) => `"${a}"`)
          .join(", ")} refer to them — do not treat those as separate people.`
      : "";
    lines.push(
      `- "${entity.surface}" → NEW CHARACTER "${resolution.proposedName}" (${resolution.description}). ` +
        "They are being created and drawn BEFORE your steps run, so plan with them exactly as with an existing " +
        `character: refer to them as "${resolution.proposedName}". Do NOT refuse, and do NOT substitute anyone else.${aliases}`,
    );
  }
  for (const entity of report.entities.filter((e) => e.resolution?.status === "unresolved")) {
    lines.push(`- "${entity.surface}" → UNRESOLVED. Do not substitute another character and do not create one.`);
  }
  const authorized = [
    ...report.creation.requestedNames,
    ...beingCreated.map((entity) => (entity.resolution as Extract<EntityResolution, { status: "create" }>).proposedName),
  ];
  lines.push(
    authorized.length > 0 || report.creation.allowed
      ? `CHARACTER CREATION: AUTHORIZED for this run${authorized.length > 0 ? ` (${[...new Set(authorized)].join(", ")})` : ""}.`
      : "CHARACTER CREATION: FORBIDDEN for this run. create_character and reference generation will be rejected by the runtime.",
  );
  return lines;
}

// ─── Relationship-based resolution ──────────────────────────────────────────

/**
 * Read a relationship phrase against the project's relationship graph.
 *
 * The anchor is whoever the phrase belongs to — the selected character, or a
 * character named earlier in the same prompt. Exactly one match resolves;
 * several is AMBIGUOUS, and none is not-found. A relationship that was never
 * recorded is never invented.
 */
export interface RelationshipLookup {
  /** Whose relationships to read: the selection, or a character named in the prompt. */
  anchorCharacterId?: ID;
  /** Candidates related to the anchor, already filtered to existing characters. */
  related: { characterId: ID; type: string; label?: string }[];
}

const RELATIONSHIP_PHRASE = /\b(?:her|his|their|the)\s+([a-z][a-z\s-]{2,30})$/i;

function resolveByRelationship(input: CharacterReferenceInput, raw: string): CharacterResolution | null {
  const lookup = input.relationships;
  if (!lookup || lookup.related.length === 0) return null;

  const phrase = RELATIONSHIP_PHRASE.exec(raw.trim());
  if (!phrase) return null;
  const wantedType = relationshipTypeFromPhrase(phrase[1]);
  if (!wantedType) return null;

  const matches = lookup.related.filter((entry) => entry.type === wantedType);
  if (matches.length === 1) {
    const character = input.projectCharacters.find((candidate) => candidate.id === matches[0].characterId);
    if (character) return resolved(character, 0.9, "relationship");
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      query: raw,
      reason: `${matches.length} characters match "${raw}". Say which one.`,
      candidates: matches.map((entry) => ({
        characterId: entry.characterId,
        name: input.projectCharacters.find((c) => c.id === entry.characterId)?.name ?? entry.characterId,
        matchType: "relationship" as const,
        note: entry.label,
      })),
    };
  }
  /**
   * The phrase names a real relationship KIND that this character does not
   * have. "Yuri hugs her sister" with no sibling recorded must fail, not fall
   * through to a token match that might hit someone unrelated.
   */
  return { status: "not-found", query: raw };
}

/**
 * Relationship phrases in a prompt, e.g. "her best friend", "his sister".
 *
 * Only possessive forms count. A bare "the teacher" is a description, and the
 * description branch already refuses to guess at those.
 */
function relationshipPhrases(prompt: string): string[] {
  const found: string[] = [];
  for (const match of prompt.matchAll(/\b(her|his|their)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)/gi)) {
    const phrase = `${match[1]} ${match[2]}`.trim();
    if (relationshipTypeFromPhrase(match[2])) found.push(phrase);
  }
  return [...new Set(found)];
}
