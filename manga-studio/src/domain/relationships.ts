/**
 * Character relationships: who these people are to each other.
 *
 * Deliberately separate from interactions. A relationship is a persistent
 * project fact ("Mio is Yuri's close friend"); an interaction is what two
 * characters are doing in one panel right now ("Yuri hugs Mio"). Collapsing
 * them would mean a hug in panel 3 implies a permanent bond, and a friendship
 * implies a pose.
 *
 * The reason this is structured data rather than something the model infers:
 * "her best friend" must resolve to a stable character id or fail. Letting an
 * LLM decide who someone's best friend probably is, is the same class of defect
 * as the substring matcher that used to swap Yuri for Cute Girl.
 */

import { newId, now } from "./factory";
import { cloneDoc, touch } from "./docHelpers";
import type { CharacterRelationship, ID, ProjectDocument, RelationshipType } from "./types";

/** Types that mean the same thing in both directions. */
const SYMMETRIC: RelationshipType[] = [
  "friend",
  "close_friend",
  "sibling",
  "coworker",
  "rival",
  "enemy",
  "romantic",
  "acquaintance",
];

export function isSymmetric(type: RelationshipType): boolean {
  return SYMMETRIC.includes(type);
}

/**
 * Words a creator might use for a relationship, mapped to its type.
 *
 * Only explicit synonyms — "bestie" is a close friend, "bro" is not
 * automatically a sibling. Anything not listed resolves to nothing rather than
 * being guessed at.
 */
const RELATIONSHIP_TERMS: { terms: string[]; type: RelationshipType }[] = [
  { terms: ["best friend", "closest friend", "bestie", "close friend"], type: "close_friend" },
  { terms: ["friend", "buddy", "pal"], type: "friend" },
  { terms: ["sister", "brother", "sibling"], type: "sibling" },
  { terms: ["mother", "father", "mom", "mum", "dad", "parent", "son", "daughter", "child"], type: "parent_child" },
  { terms: ["teacher", "sensei", "student", "pupil"], type: "teacher_student" },
  { terms: ["coworker", "colleague", "workmate"], type: "coworker" },
  { terms: ["rival"], type: "rival" },
  { terms: ["enemy", "nemesis"], type: "enemy" },
  { terms: ["girlfriend", "boyfriend", "partner", "lover"], type: "romantic" },
  { terms: ["acquaintance"], type: "acquaintance" },
];

/**
 * Which relationship type a phrase refers to, or null.
 *
 * Longest match first, so "best friend" is a close friend rather than a friend.
 */
export function relationshipTypeFromPhrase(phrase: string): RelationshipType | null {
  const text = phrase.toLowerCase();
  const matches = RELATIONSHIP_TERMS.flatMap((entry) =>
    entry.terms.filter((term) => text.includes(term)).map((term) => ({ term, type: entry.type })),
  ).sort((a, b) => b.term.length - a.term.length);
  return matches[0]?.type ?? null;
}

export function addRelationship(
  doc: ProjectDocument,
  input: { characterAId: ID; characterBId: ID; type: RelationshipType; label?: string },
): { doc: ProjectDocument; relationshipId: ID } {
  if (input.characterAId === input.characterBId) {
    throw new Error("A character cannot have a relationship with themselves");
  }
  const next = cloneDoc(doc);
  for (const id of [input.characterAId, input.characterBId]) {
    if (!next.characters[id]) throw new Error(`Unknown character: ${id}`);
  }
  // One edge per pair per type; re-adding updates the label rather than forking.
  const existing = Object.values(next.relationships).find(
    (relationship) =>
      relationship.type === input.type && connects(relationship, input.characterAId, input.characterBId),
  );
  if (existing) {
    existing.label = input.label ?? existing.label;
    touch(next);
    return { doc: next, relationshipId: existing.id };
  }

  const relationship: CharacterRelationship = {
    id: newId(),
    projectId: next.project.id,
    characterAId: input.characterAId,
    characterBId: input.characterBId,
    type: input.type,
    label: input.label,
    createdAt: now(),
  };
  next.relationships[relationship.id] = relationship;
  touch(next);
  return { doc: next, relationshipId: relationship.id };
}

export function removeRelationship(doc: ProjectDocument, relationshipId: ID): ProjectDocument {
  if (!doc.relationships[relationshipId]) return doc;
  const next = cloneDoc(doc);
  delete next.relationships[relationshipId];
  touch(next);
  return next;
}

/** Does this edge connect these two characters, in either direction? */
function connects(relationship: CharacterRelationship, a: ID, b: ID): boolean {
  return (
    (relationship.characterAId === a && relationship.characterBId === b) ||
    (relationship.characterAId === b && relationship.characterBId === a)
  );
}

export interface RelatedCharacter {
  characterId: ID;
  relationship: CharacterRelationship;
}

/**
 * Everyone related to a character, optionally filtered by type.
 *
 * Direction matters for asymmetric types: for `parent_child`, A is the parent.
 * A symmetric type reads the same from either side.
 */
export function relatedCharacters(
  doc: ProjectDocument,
  characterId: ID,
  type?: RelationshipType,
): RelatedCharacter[] {
  return Object.values(doc.relationships ?? {})
    .filter((relationship) => !type || relationship.type === type)
    .flatMap((relationship) => {
      if (relationship.characterAId === characterId) {
        return [{ characterId: relationship.characterBId, relationship }];
      }
      if (relationship.characterBId === characterId) {
        // An asymmetric edge still describes this pair; the caller decides
        // whether the direction matters for the phrase being resolved.
        return [{ characterId: relationship.characterAId, relationship }];
      }
      return [];
    })
    .filter((entry) => Boolean(doc.characters[entry.characterId]));
}

/** Every relationship touching a character, for the editor list. */
export function relationshipsFor(doc: ProjectDocument, characterId: ID): CharacterRelationship[] {
  return Object.values(doc.relationships ?? {}).filter(
    (relationship) => relationship.characterAId === characterId || relationship.characterBId === characterId,
  );
}

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  friend: "Friend",
  close_friend: "Close Friend",
  sibling: "Sibling",
  parent_child: "Parent / Child",
  teacher_student: "Teacher / Student",
  coworker: "Coworker",
  rival: "Rival",
  enemy: "Enemy",
  romantic: "Romantic",
  acquaintance: "Acquaintance",
  custom: "Custom",
};
