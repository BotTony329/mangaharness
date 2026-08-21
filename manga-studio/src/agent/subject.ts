/**
 * Subject resolution — what the user is talking about.
 *
 * ## The distinction this module exists to enforce
 *
 * SCOPE answers "where may the Agent make changes?" — a panel, a page, the
 * project. SUBJECT answers "which entity does the user mean?" — Cute Girl,
 * Yuri, the lamp, this panel.
 *
 * They were conflated. A selected object was treated as the authoritative
 * subject, so "let Cute girl run to the camera" — with a lamp selected —
 * resolved its subject to the lamp and failed with "the scoped object is not a
 * character asset". Entity grounding had already answered the question
 * correctly; scope resolution then overruled it.
 *
 * A selection is EVIDENCE, never authority. It resolves "her". It does not
 * outrank a name the user typed.
 *
 * ## Precedence
 *
 *   1. EXPLICIT GROUNDED ENTITY     — the user named a character
 *   2. EXPLICIT RELATIONSHIP        — "her close friend", resolved from the graph
 *   3. PRONOUN FROM CONTEXT         — "her", resolved from selection or scene
 *   4. SELECTED OBJECT              — nothing was named; the selection is the subject
 *   5. NONE                         — no subject; the operation is about a panel or page
 *
 * Level 5 is not a failure. "Make this panel more dramatic" has no character
 * subject and must not be forced to invent one.
 */

import type { ID, ProjectDocument } from "@/domain/types";
import type { CharacterMatchType, GroundingReport } from "./grounding";
import type { EntityResolution } from "./entityResolution";

export type SubjectBasis =
  | "explicit-name"
  | "relationship"
  | "pronoun"
  | "selection"
  | "none";

export interface NewSubject {
  semanticId: string;
  proposedName: string;
  description: string;
}

export interface SubjectResolution {
  /** Characters the user named or implied, subject first. */
  characterIds: ID[];
  /**
   * Characters the creator introduced that the project does not have yet.
   *
   * A subject exists whether or not the library has heard of them — §3. These
   * used to vanish at inventory lookup, which is why "The bad guy Roach Man
   * punching to the camera" reported "No character subject".
   */
  newCharacters: NewSubject[];
  /** How the subject was decided — shown in the run log so failures are debuggable. */
  basis: SubjectBasis;
  /** Whether the current selection was used as the subject. */
  usedSelection: boolean;
  /** One line for the run log, in the creator's terms. */
  explanation: string;
}

/**
 * Decide the subject from grounding plus context.
 *
 * Deliberately reads only the grounding report and the document: no prompt
 * re-parsing, no second guess at identity. Grounding already answered "who",
 * and asking twice is how two answers appear.
 */
export function resolveSubject(input: {
  doc: ProjectDocument;
  grounding: GroundingReport;
}): SubjectResolution {
  const { doc, grounding } = input;
  const name = (id: ID) => doc.characters[id]?.name ?? id;

  const resolvedEntities = grounding.entities.filter(
    (entity): entity is typeof entity & { characterId: ID } =>
      entity.status === "resolved" && Boolean(entity.characterId),
  );

  /**
   * Entities the creator introduced, in reading order. They are subjects in
   * exactly the same sense as existing characters; the only difference is that
   * they still need to be made.
   */
  const introduced: NewSubject[] = grounding.entities
    .filter((entity) => entity.resolution?.status === "create")
    .map((entity) => {
      const resolution = entity.resolution as Extract<EntityResolution, { status: "create" }>;
      return {
        semanticId: resolution.semanticId,
        proposedName: resolution.proposedName,
        description: resolution.description,
      };
    });

  /**
   * Ordered by where they appeared in the prompt, so "Cute Girl … Yuri's name"
   * makes Cute Girl the subject and Yuri the referenced party. Grounding
   * preserves prompt order, which is the only ordering signal available without
   * re-parsing.
   */
  const byMatch = (types: CharacterMatchType[]) =>
    resolvedEntities.filter((entity) => entity.matchType && types.includes(entity.matchType));

  /** The user typed a name (or an id, or a stored alias). Nothing outranks this. */
  const explicit = byMatch(["exact-name", "normalized-name", "alias", "unique-token", "id"]);
  if (explicit.length > 0 || introduced.length > 0) {
    const names = [
      ...explicit.map((entity) => name(entity.characterId)),
      ...introduced.map((entity) => entity.proposedName),
    ];
    return {
      characterIds: explicit.map((entity) => entity.characterId),
      newCharacters: introduced,
      basis: "explicit-name",
      usedSelection: false,
      explanation: `${names.join(", ")} — named explicitly, so the current selection is not the subject`,
    };
  }


  const relational = byMatch(["relationship"]);
  if (relational.length > 0) {
    return {
      characterIds: relational.map((entity) => entity.characterId),
      newCharacters: introduced,
      basis: "relationship",
      usedSelection: false,
      explanation: `${relational.map((entity) => name(entity.characterId)).join(", ")} — resolved through a stored relationship`,
    };
  }

  const pronoun = byMatch(["selected-instance", "sole-scene-character", "recent-operation"]);
  if (pronoun.length > 0) {
    const usedSelection = pronoun.some((entity) => entity.characterId === grounding.selectedCharacterId);
    return {
      characterIds: pronoun.map((entity) => entity.characterId),
      newCharacters: introduced,
      basis: "pronoun",
      usedSelection,
      explanation: `${pronoun.map((entity) => name(entity.characterId)).join(", ")} — a pronoun resolved from ${usedSelection ? "the selection" : "the scene"}`,
    };
  }

  /**
   * Nothing was named. NOW the selection may be the subject — and only if it
   * actually is a character. A selected lamp means the request is about the
   * lamp or about the panel, not about a character nobody mentioned.
   */
  if (grounding.selectedCharacterId) {
    return {
      characterIds: [grounding.selectedCharacterId],
      newCharacters: introduced,
      basis: "selection",
      usedSelection: true,
      explanation: `${name(grounding.selectedCharacterId)} — nothing was named, so the selected character is the subject`,
    };
  }

  return {
    characterIds: [],
    newCharacters: introduced,
    basis: "none",
    usedSelection: false,
    explanation: "No character subject — the request is about a panel, an object, or the page",
  };
}

/**
 * Should the selection still narrow WHERE the run may write?
 *
 * Yes for a request about the selected thing. No when the user named somebody
 * else: locking the run to the selected object would forbid every edit the
 * request actually asks for, which is precisely the reported failure.
 */
export function selectionIsAuthoritativeTarget(subject: SubjectResolution, selectedCharacterId?: ID): boolean {
  if (subject.basis === "none" || subject.usedSelection) return true;
  return selectedCharacterId !== undefined && subject.characterIds.includes(selectedCharacterId);
}
