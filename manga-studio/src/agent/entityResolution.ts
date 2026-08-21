/**
 * Three-way entity resolution.
 *
 * ## The assumption this removes
 *
 * Resolution used to be binary — found, or fatal. So "The bad guy Roach Man
 * punching to the camera" produced
 *
 *     "…Roach Man does not exist in the project's character inventory, and
 *      creating new characters is forbidden for this run."
 *
 * which is an inventory-constrained command planner talking, not a manga
 * studio. Kumanga's thesis is that AI creates reusable assets and the creator
 * composes them; a missing asset is a REQUIREMENT, not a failure.
 *
 * But the opposite extreme is worse. "Yuri hugs her sister" must never invent a
 * sister: that phrase is a claim about the project's own data, and answering it
 * with a fabrication is how the creator's manga acquires characters they never
 * wrote.
 *
 * ## What actually separates the two
 *
 * Not a creation verb — "the bad guy Roach Man punching" has none. Not the
 * determiner — that phrase starts with "the". The distinction is whether the
 * reference **carries its own identity** or **points into existing data**:
 *
 *   SELF-IDENTIFYING   "Roach Man", "a cockroach superhero", "a new villain",
 *                      "the bad guy Roach Man"
 *                      → contains a name, or a description complete enough to
 *                        draw from. Nothing needs to be looked up. → CREATE
 *
 *   POINTING           "her sister", "the teacher", "that man", "the same
 *                      girl", "the character from panel 1"
 *                      → means nothing without the project. If the project
 *                        cannot answer, the answer is unknown. → UNRESOLVED
 *
 * A pointing reference that the project CAN answer resolves to the existing
 * entity, which is the whole point of grounding.
 */

import type { ID } from "@/domain/types";
import { normalizeReference } from "./grounding";

export type EntityKind = "character" | "object" | "scene" | "tone" | "effect";

export type EntityResolution =
  | { status: "existing"; kind: EntityKind; entityId: ID; name: string }
  | {
      status: "create";
      kind: EntityKind;
      /** Stable handle for this entity within one run, before it has an id. */
      semanticId: string;
      proposedName: string;
      /** The creator's own words, used as the generation description. */
      description: string;
    }
  | { status: "unresolved"; kind: EntityKind; reason: string; blocking: true };

// ─── Reference form ─────────────────────────────────────────────────────────

/** Pronouns and anaphora: they mean whoever the context already established. */
const PRONOUN = /^(?:her|him|she|he|they|them|it|hers|his|theirs|herself|himself|themselves)$/i;

/**
 * Phrases that POINT rather than describe.
 *
 * A possessive relation ("Yuri's sister", "her teacher"), a definite
 * description with no name ("the teacher", "that man"), or an explicit callback
 * ("the same girl", "the character from panel 1"). Each is a claim that the
 * project already contains the answer.
 */
const POSSESSIVE_RELATION = /['’]s\s+\S|^(?:her|his|their|its)\s+\S/i;
const CALLBACK = /\b(?:the\s+same|that\s+same|from\s+panel|in\s+panel|earlier|previous|above)\b/i;
const DEFINITE = /^(?:the|that|this|those|these)\b/i;

/** Determiners that introduce something new rather than point at something. */
const INDEFINITE = /^(?:a|an|another|some|one)\b/i;
const NOVELTY = /\b(?:new|different|another)\b/i;

/**
 * A capitalised token sequence that reads as a name.
 *
 * Deliberately not "any capitalised word": sentence-initial words and common
 * nouns are excluded upstream by the grounder's NOT_A_NAME list, and a name has
 * to survive normalisation as something a person would answer to.
 */
export function containsProperName(surface: string): boolean {
  const withoutLeading = surface.replace(/^(?:the|a|an|that|this)\s+/i, "");
  return /(?:^|\s)[A-Z][\w'’-]+/.test(withoutLeading);
}

export type ReferenceForm = "self-identifying" | "pointing";

/**
 * Classify the FORM of a reference, independently of what the project holds.
 *
 * This runs before any inventory lookup — §3: the subject of a sentence exists
 * whether or not the library has heard of them.
 */
export function classifyReference(surface: string): ReferenceForm {
  const trimmed = surface.trim();
  if (trimmed.length === 0) return "pointing";
  if (PRONOUN.test(trimmed)) return "pointing";
  if (CALLBACK.test(trimmed)) return "pointing";

  /**
   * A possessive relation points even when it contains a name: "Yuri's sister"
   * names Yuri in order to ask about somebody else. Answering it with a
   * fabricated sister is precisely the failure §17 protects.
   */
  if (POSSESSIVE_RELATION.test(trimmed)) return "pointing";

  // An indefinite article introduces: "a robot", "another villain".
  if (INDEFINITE.test(trimmed) || NOVELTY.test(trimmed)) return "self-identifying";

  /**
   * A definite description carries identity only when it also carries a name.
   * "the bad guy Roach Man" introduces Roach Man; "the teacher" asks which one.
   */
  if (DEFINITE.test(trimmed)) return containsProperName(trimmed) ? "self-identifying" : "pointing";

  // A bare name.
  return containsProperName(trimmed) ? "self-identifying" : "pointing";
}

// ─── Naming ─────────────────────────────────────────────────────────────────

const LEADING_ARTICLE = /^(?:the|a|an|that|this)\s+/i;

/**
 * The name to give a new entity.
 *
 * Prefers the proper name the creator actually wrote — "the bad guy Roach Man"
 * becomes "Roach Man", not "The Bad Guy Roach Man". A description with no name
 * ("a cockroach superhero") is title-cased as-is, because that IS what the
 * creator called them.
 */
export function proposedNameFor(surface: string): string {
  const trimmed = surface.trim().replace(/[.,!?;:]+$/, "");
  const named = trimmed.match(/\b(?:named|called)\s+["“']?([A-Za-z][\w'’-]*(?:\s+[A-Z][\w'’-]*)*)/i);
  if (named?.[1]) return titleCase(named[1]);

  // Only the article is dropped blindly. Descriptive words are kept unless the
  // creator also wrote a proper name, in which case that name wins: "the bad
  // guy Roach Man" is Roach Man, but "a cockroach superhero" stays descriptive.
  const withoutArticle = trimmed.replace(LEADING_ARTICLE, "").trim();
  const properRun = withoutArticle.match(/\b[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)*/);
  if (properRun?.[0] && properRun[0].length > 1) return properRun[0];

  return titleCase(withoutArticle || trimmed);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function semanticIdFor(surface: string): string {
  const slug = normalizeReference(proposedNameFor(surface)).replace(/\s+/g, "-");
  return slug.length > 0 ? slug : "entity";
}

/**
 * Turn a failed lookup into the right kind of outcome.
 *
 * Ambiguity is always unresolved: two characters could answer, and picking one
 * is guessing. Otherwise the reference form decides.
 */
export function resolveUnmatched(input: {
  surface: string;
  kind: EntityKind;
  ambiguous?: boolean;
  ambiguityReason?: string;
}): EntityResolution {
  if (input.ambiguous) {
    return {
      status: "unresolved",
      kind: input.kind,
      reason: input.ambiguityReason ?? `"${input.surface}" could mean more than one character.`,
      blocking: true,
    };
  }

  if (classifyReference(input.surface) === "self-identifying") {
    return {
      status: "create",
      kind: input.kind,
      semanticId: semanticIdFor(input.surface),
      proposedName: proposedNameFor(input.surface),
      description: input.surface.trim(),
    };
  }

  return {
    status: "unresolved",
    kind: input.kind,
    reason: `"${input.surface}" refers to something already in this project, and nothing matches it. Say which character you mean.`,
    blocking: true,
  };
}
