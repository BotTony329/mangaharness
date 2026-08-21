/**
 * Scene-local co-reference: apposition binding.
 *
 * ## The failure this closes
 *
 * "The supermate is fighting with his rival, the bad character Roachman, in
 * Melbourne" used to ground as THREE references:
 *
 *     Supermate   → existing
 *     his rival   → UNRESOLVED (blocked the run)
 *     Roachman    → create
 *
 * But "his rival" and "the bad character Roachman" are one participant said
 * twice — an apposition. Grammar already carries that fact: a pointing phrase
 * ("his rival", "her sister", "the teacher") immediately followed by a
 * name-carrying phrase ("Roachman", "Mori", "Mr Chen") across a comma or dash
 * is the same person, introduced and renamed in one breath.
 *
 * ## What this module is NOT
 *
 * It is not a list of relationship words with a regex patch each. The rule is
 * structural: exactly one side POINTS (classifyReference → "pointing"), the
 * other side CARRIES A NAME ("self-identifying" with a proper name). Any
 * descriptor vocabulary — rival, sister, teacher, enemy, words never seen
 * before — binds by the same rule, because the classification lives in
 * `entityResolution.ts`, not here.
 *
 * ## Scene-local, never persistent
 *
 * The binding is recorded ON the grounded entity as a scene-local alias and an
 * optional scene-local relation ("rival of Supermate"). It is never written to
 * the project's relationship graph: one sentence of plot must not permanently
 * mutate who two characters ARE.
 */

import { relationshipTypeFromPhrase } from "@/domain/relationships";
import type { ID, RelationshipType } from "@/domain/types";
import { classifyReference, containsProperName } from "./entityResolution";
import { normalizeReference, type GroundedEntity } from "./grounding";

export interface AppositionBinding {
  /** The pointing surface: "his rival", "her sister", "the teacher". */
  aliasSurface: string;
  /** The name-carrying surface: "the bad character Roachman", "Mori". */
  canonicalSurface: string;
  /** Prompt offset of the canonical surface, for reading-order ties. */
  index: number;
  /** The relation the alias asserts, when it names one ("rival", "sister"). */
  relationType?: RelationshipType;
}

/** A comma or dash between two noun phrases is the apposition boundary. */
const SEPARATOR = /[,;]|—|–|\s+-\s+/;

/**
 * The trailing noun phrase of the left segment: the last determiner- or
 * possessive-headed chunk. "…is fighting with his rival" → "his rival";
 * "Yuri hugs Yuri's sister" → "Yuri's sister".
 */
const LEFT_NP =
  /(?:[\w'’]+['’]s|her|his|their|the|a|an|that|this)\s+[A-Za-z][\w'’-]*(?:\s+[A-Za-z][\w'’-]*){0,4}\s*$/i;

/**
 * Linking words that END a noun phrase. "the bad character Roachman in
 * Melbourne" is a participant plus a place; the place is not part of the name.
 * These are closed-class grammar words, not domain vocabulary.
 */
const RIGHT_NP_END = /\s+(?:in|at|on|near|inside|outside|behind|beside|under|over|with|while|and|then|to|from|into)\b/i;

/**
 * Does this side CARRY an introducible name? "Mori" and "the bad character
 * Roachman" do; "in Melbourne" does not, no matter that Melbourne is
 * capitalised — a participant is a person, and a prepositional phrase is not
 * one.
 */
function carriesName(phrase: string): boolean {
  if (RIGHT_NP_END.test(` ${phrase}`) && /^(?:in|at|on|near|inside|outside|behind|beside|under|over|with|while|and|then|to|from|into)\b/i.test(phrase.trim())) {
    return false;
  }
  return classifyReference(phrase) === "self-identifying" && containsProperName(phrase);
}

/** Does this side POINT at someone the sentence expects to exist? */
function pointsAtSomeone(phrase: string): boolean {
  return classifyReference(phrase) === "pointing" && phrase.trim().length > 0;
}

/**
 * Find apposition bindings in a prompt.
 *
 * One structural pass over separator boundaries; no per-relationship-word
 * logic anywhere.
 */
export function findAppositions(prompt: string): AppositionBinding[] {
  const bindings: AppositionBinding[] = [];

  const segments: { text: string; start: number }[] = [];
  let cursor = 0;
  for (const match of prompt.matchAll(new RegExp(SEPARATOR.source, "g"))) {
    segments.push({ text: prompt.slice(cursor, match.index), start: cursor });
    cursor = match.index + match[0].length;
  }
  segments.push({ text: prompt.slice(cursor), start: cursor });

  for (let i = 0; i < segments.length - 1; i += 1) {
    const left = segments[i];
    const right = segments[i + 1];

    const leftMatch = LEFT_NP.exec(left.text);
    const rightRaw = right.text.trim();
    const rightEnd = RIGHT_NP_END.exec(rightRaw);
    const rightNp = (rightEnd ? rightRaw.slice(0, rightEnd.index) : rightRaw).trim().replace(/[.,!?;:]+$/, "");
    const rightIndex = right.start + right.text.indexOf(rightRaw);

    if (!leftMatch || rightNp.length === 0) continue;
    const alias = leftMatch[0].trim();

    // Bind in either order: "his rival, Roachman" and "Roachman, his rival".
    if (pointsAtSomeone(alias) && carriesName(rightNp)) {
      bindings.push({
        aliasSurface: alias,
        canonicalSurface: rightNp,
        index: rightIndex,
        relationType: relationshipTypeFromPhrase(alias) ?? undefined,
      });
    } else if (carriesName(alias) && pointsAtSomeone(rightNp)) {
      bindings.push({
        aliasSurface: rightNp,
        canonicalSurface: alias,
        index: left.start + left.text.lastIndexOf(alias),
        relationType: relationshipTypeFromPhrase(rightNp) ?? undefined,
      });
    }
  }
  return bindings;
}

/**
 * Fold apposition bindings into the grounded entity list.
 *
 * The pointing entity is removed and its surface becomes a scene-local alias
 * of the canonical one, so downstream — SceneIntent, requirements, planner
 * context, validation — sees ONE participant. A pointing phrase with no
 * apposition is untouched: "Yuri hugs her sister" still blocks.
 *
 * Safety rule: if the pointing phrase ALREADY resolves to a different existing
 * character through the relationship graph, the apposition contradicts project
 * data and nothing is merged — the run keeps its block.
 */
export function applyAppositions(
  prompt: string,
  entities: GroundedEntity[],
  selectedCharacterId?: ID,
): void {
  for (const binding of findAppositions(prompt)) {
    const canonicalKey = normalizeReference(binding.canonicalSurface);
    const aliasKey = normalizeReference(binding.aliasSurface);

    const aliasIdx = entities.findIndex((entity) => normalizeReference(entity.surface) === aliasKey);
    // The canonical entity's surface may be just the name ("Roachman") while
    // the apposition carries the whole introduction ("the bad character
    // Roachman") — containment in either direction is the same participant.
    const canonicalIdx = entities.findIndex((entity) => {
      const key = normalizeReference(entity.surface);
      return key.length > 0 && (canonicalKey.includes(key) || key.includes(canonicalKey));
    });
    if (canonicalIdx < 0) continue;

    const canonical = entities[canonicalIdx];
    const alias = aliasIdx >= 0 ? entities[aliasIdx] : undefined;
    if (alias && alias.characterId && alias.characterId !== canonical.characterId) continue;

    if (aliasIdx >= 0) entities.splice(aliasIdx, 1);

    canonical.sceneLocalAliases = [...new Set([...(canonical.sceneLocalAliases ?? []), binding.aliasSurface])];

    if (binding.relationType) {
      /**
       * Whose rival/sister? The possessive ("his", "Yuri's") means the subject
       * the sentence already established — the nearest resolved entity before
       * the alias, falling back to the creator's selection. Never written to
       * the relationship graph.
       */
      const anchor =
        entities
          .filter(
            (entity) =>
              entity.characterId &&
              entity.promptIndex !== undefined &&
              entity.promptIndex < (alias?.promptIndex ?? binding.index),
          )
          .sort((a, b) => (b.promptIndex ?? 0) - (a.promptIndex ?? 0))[0]?.characterId ?? selectedCharacterId;
      canonical.sceneRelation = { type: binding.relationType, anchorCharacterId: anchor };
    }
  }
}
