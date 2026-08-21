/**
 * What the plan NEEDS, and where each of those things will come from.
 *
 * ## The arrow that was missing
 *
 * The Agent understood the request and then went straight to editor commands.
 * If a character was not in the library the run simply stopped — an
 * inventory-constrained command planner, not a studio whose whole thesis is
 * that AI makes the assets and the creator composes them.
 *
 * This layer sits between the semantic plan and execution and answers, for
 * every entity the plan mentions: do we already have this, can we make it from
 * something we have, or must it be made from nothing?
 *
 * ## Economy is a rule, not an optimisation
 *
 * Requirements resolve in a fixed order, cheapest first:
 *
 *   1. an EXACT existing asset            — free
 *   2. a COMPATIBLE existing asset        — free
 *   3. existing identity + generate state — one render
 *   4. create the entity outright         — identity render, then state render
 *
 * A character who exists but has no punching pose must never be re-created;
 * that would spend a generation AND fork their identity.
 */

import { resolveCharacterIdentityReference } from "@/characters/identityReference";
import { DEFAULT_CHARACTER_STATE, findExactCharacterAsset } from "@/characters/state";
import type { ID, ProjectDocument } from "@/domain/types";
import type { SequencePlan } from "./sequencePlan";
import type { NewSubject } from "./subject";

export type RequirementKind = "character-identity" | "character-state" | "object" | "scene" | "tone";

/** Cheapest first — see the ladder above. */
export type FulfilmentPlan =
  | { how: "exact-asset"; assetId: ID }
  | { how: "compatible-asset"; assetId: ID; note: string }
  | { how: "generate-state"; characterId: ID; referenceAssetId: ID }
  | { how: "create-entity"; proposedName: string; description: string }
  | { how: "generate-asset"; description: string };

export interface AssetRequirement {
  kind: RequirementKind;
  /** Stable handle within the run — a character id, or a new entity's slug. */
  semanticId: string;
  label: string;
  /** The semantic state a character render must satisfy. */
  state?: RequiredState;
  fulfilment: FulfilmentPlan;
  /** True when satisfying this costs a provider call. */
  needsGeneration: boolean;
  /** Panel this requirement is needed in, when it is placed. */
  panelNumber?: number;
}

export interface RequirementReport {
  requirements: AssetRequirement[];
  /** Requirements that cannot be met without a provider. */
  generationCount: number;
  /** One line per requirement, for the run log. */
  lines: string[];
}

type RequiredState = { pose: string; expression: string; outfit: string; view: string };

function stateFor(pose: string | undefined, expression: string | undefined): RequiredState {
  return {
    pose: (pose ?? DEFAULT_CHARACTER_STATE.pose).toLowerCase(),
    expression: (expression ?? DEFAULT_CHARACTER_STATE.expression).toLowerCase(),
    outfit: DEFAULT_CHARACTER_STATE.outfit,
    view: DEFAULT_CHARACTER_STATE.view,
  };
}

/**
 * Derive requirements from the sequence plan.
 *
 * Reads the document, never mutates it: the report is shown to the creator
 * BEFORE anything is spent, so "this will cost two renders" is knowable in
 * advance rather than discovered afterwards.
 */
export function deriveAssetRequirements(input: {
  doc: ProjectDocument;
  plan: SequencePlan;
  newCharacters: NewSubject[];
}): RequirementReport {
  const { doc, plan, newCharacters } = input;
  const requirements: AssetRequirement[] = [];
  const seen = new Set<string>();

  /** Entities the creator introduced need an identity before anything else. */
  for (const entity of newCharacters) {
    const key = `identity:${entity.semanticId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      kind: "character-identity",
      semanticId: entity.semanticId,
      label: entity.proposedName,
      fulfilment: { how: "create-entity", proposedName: entity.proposedName, description: entity.description },
      needsGeneration: true,
    });
  }

  for (const beat of plan.beats) {
    const state = stateFor(beat.action, beat.expression);

    for (const characterId of beat.subjects) {
      const character = doc.characters[characterId];
      if (!character) continue;
      const key = `state:${characterId}:${state.pose}:${state.expression}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // 1. An exact render of this state already exists.
      const exact = findExactCharacterAsset(doc, character, { characterId, ...state });
      if (exact) {
        requirements.push({
          kind: "character-state",
          semanticId: characterId,
          label: `${character.name} · ${state.pose}`,
          state,
          fulfilment: { how: "exact-asset", assetId: exact.id },
          needsGeneration: false,
          panelNumber: beat.panelNumber,
        });
        continue;
      }

      /**
       * 3. The character exists; only the STATE is missing. Generate it from
       * their canonical identity — never re-create the character, which would
       * both cost more and fork who they are.
       */
      const identity = resolveCharacterIdentityReference(doc, characterId);
      requirements.push({
        kind: "character-state",
        semanticId: characterId,
        label: `${character.name} · ${state.pose}`,
        state,
        fulfilment:
          identity.status === "resolved" && identity.assetId
            ? { how: "generate-state", characterId, referenceAssetId: identity.assetId }
            : { how: "generate-asset", description: `${character.name}, ${state.pose}` },
        needsGeneration: true,
        panelNumber: beat.panelNumber,
      });
    }

    /** A new entity also needs the state the beat asks of them. */
    for (const entity of newCharacters) {
      const key = `newstate:${entity.semanticId}:${state.pose}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requirements.push({
        kind: "character-state",
        semanticId: entity.semanticId,
        label: `${entity.proposedName} · ${state.pose}`,
        state,
        fulfilment: { how: "generate-asset", description: `${entity.description}, ${state.pose}` },
        needsGeneration: true,
        panelNumber: beat.panelNumber,
      });
    }
  }

  const lines = requirements.map((requirement) => describeRequirement(requirement));
  return {
    requirements,
    generationCount: requirements.filter((requirement) => requirement.needsGeneration).length,
    lines,
  };
}

export function describeRequirement(requirement: AssetRequirement): string {
  switch (requirement.fulfilment.how) {
    case "exact-asset":
      return `${requirement.label} — already in the library`;
    case "compatible-asset":
      return `${requirement.label} — reusing ${requirement.fulfilment.note}`;
    case "generate-state":
      return `${requirement.label} — generate this state from their reference`;
    case "create-entity":
      return `${requirement.label} — not in the library, create the character`;
    case "generate-asset":
      return `${requirement.label} — generate`;
  }
}
