"use client";

/**
 * Turning requirements into real, reusable assets.
 *
 * This is the arrow the Agent was missing: it identified what a request needed
 * and then stopped, because the library did not already contain it. Everything
 * here goes through the SAME services the manual UI uses — `create-character`
 * is the command behind "+ New Character", and `generateCharacterAssetForState`
 * is the function behind the starter pack — so a character the Agent makes is
 * indistinguishable from one the creator made, and is reusable afterwards.
 *
 * There is deliberately no Agent-only generation pipeline. A second path would
 * drift, and the creator would end up with two kinds of character.
 */

import { generateCharacterAssetForState } from "@/characters/stateRuntime";
import { resolveCharacterIdentityReference } from "@/characters/identityReference";
import { DEFAULT_CHARACTER_STATE } from "@/characters/state";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import type { AssetRequirement } from "./assetRequirements";

export interface FulfilmentResult {
  /** Requirement semanticId → the character it now refers to. */
  characterIds: Record<string, ID>;
  created: { characterId: ID; name: string }[];
  generated: number;
  reused: number;
}

/** Provider absence must say what could not be MADE, not what was missing. */
export class RequirementFailure extends Error {
  constructor(public readonly requirement: AssetRequirement, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "generation failed";
    super(`${requirement.label} needs to be generated, but ${lowerFirst(detail)}`);
    this.name = "RequirementFailure";
  }
}

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}

const doc = (): ProjectDocument => {
  const current = useEditorStore.getState().doc;
  if (!current) throw new Error("No open project");
  return current;
};

/**
 * Satisfy every requirement, cheapest first.
 *
 * Runs BEFORE the page transaction. Generated library assets are meant to
 * survive a failed composition — the creator paid for them, and a retry must
 * not pay twice — while the page itself is what rolls back.
 */
export async function fulfilRequirements(requirements: AssetRequirement[]): Promise<FulfilmentResult> {
  const result: FulfilmentResult = { characterIds: {}, created: [], generated: 0, reused: 0 };

  for (const requirement of requirements) {
    switch (requirement.fulfilment.how) {
      case "exact-asset":
      case "compatible-asset": {
        result.reused += 1;
        break;
      }

      case "create-entity": {
        /**
         * The same command "+ New Character" dispatches, then the same
         * canonical-identity generation the starter pack runs. The character
         * appears in the library exactly as a hand-made one does.
         */
        const created = useEditorStore.getState().dispatch({
          type: "create-character",
          name: requirement.fulfilment.proposedName,
          appearance: requirement.fulfilment.description,
        });
        const characterId = created.createdId;
        if (!characterId) throw new Error(`${requirement.fulfilment.proposedName} could not be created`);
        result.characterIds[requirement.semanticId] = characterId;
        result.created.push({ characterId, name: requirement.fulfilment.proposedName });

        try {
          await generateCharacterAssetForState({
            characterId,
            state: { characterId, ...DEFAULT_CHARACTER_STATE },
            role: "canonical",
          });
          result.generated += 1;
        } catch (cause) {
          throw new RequirementFailure(requirement, cause);
        }
        break;
      }

      case "generate-state": {
        const { characterId } = requirement.fulfilment;
        try {
          await generateCharacterAssetForState({
            characterId,
            state: { characterId, ...DEFAULT_CHARACTER_STATE, ...(requirement.state ?? {}) },
            role: "state",
          });
          result.generated += 1;
        } catch (cause) {
          throw new RequirementFailure(requirement, cause);
        }
        break;
      }

      case "generate-asset": {
        /**
         * A state for an entity created earlier in this same run: its id only
         * exists now, so the requirement is resolved against what was just
         * made rather than against the document as it was when planning ran.
         */
        const characterId = result.characterIds[requirement.semanticId] ?? requirement.semanticId;
        if (!doc().characters[characterId]) {
          throw new RequirementFailure(requirement, new Error("the character it belongs to was not created"));
        }
        const identity = resolveCharacterIdentityReference(doc(), characterId);
        if (identity.status !== "resolved") {
          throw new RequirementFailure(requirement, new Error(identity.reason ?? "there is no reference image to draw from"));
        }
        try {
          await generateCharacterAssetForState({
            characterId,
            state: { characterId, ...DEFAULT_CHARACTER_STATE, ...(requirement.state ?? {}) },
            role: "state",
          });
          result.generated += 1;
        } catch (cause) {
          throw new RequirementFailure(requirement, cause);
        }
        break;
      }
    }
  }

  return result;
}
