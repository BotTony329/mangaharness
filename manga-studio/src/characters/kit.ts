/**
 * Character Kit — one character presented as an actor, not a pile of files (§3).
 *
 * This is a PROJECTION over the existing document, computed on demand. The
 * character's dimensions (poses, expressions, outfits, views) are derived from
 * the union of sensible defaults and whatever states the project has actually
 * rendered, so a kit needs no migration, cannot drift from the assets, and
 * cannot become a second source of truth.
 *
 * Each option knows whether a render already exists for it, which is what lets
 * the UI show "Walking" as available-now versus generate-on-demand without the
 * component reaching into the asset table itself.
 */

import type { Character, CharacterState, ID, ProjectDocument, SourceAsset } from "@/domain/types";
import {
  DEFAULT_CHARACTER_STATE,
  availableCharacterStateValues,
  characterReferenceId,
  findExactCharacterAsset,
  stateFromAsset,
  type CharacterStatePatch,
} from "./state";

export type KitDimension = keyof CharacterStatePatch;

export const KIT_DIMENSIONS: KitDimension[] = ["pose", "expression", "outfit", "view"];

export interface KitOption {
  value: string;
  label: string;
  /** A ready render exists for this value combined with the current state. */
  cached: boolean;
  /** Any ready render uses this value, in some other state combination. */
  known: boolean;
  previewAssetId?: ID;
}

export interface CharacterKit {
  characterId: ID;
  name: string;
  canonicalAssetId?: ID;
  defaultOutfit: string;
  /** The state the kit is being viewed against; option caching is relative to it. */
  state: CharacterState;
  dimensions: Record<KitDimension, KitOption[]>;
  /** Every ready, non-canonical render belonging to this character. */
  renderedStateCount: number;
}

const DIMENSION_LABELS: Record<KitDimension, string> = {
  pose: "Pose",
  expression: "Face",
  outfit: "Outfit",
  view: "View",
};

export function kitDimensionLabel(dimension: KitDimension): string {
  return DIMENSION_LABELS[dimension];
}

export function defaultCharacterState(characterId: ID, character?: Character): CharacterState {
  return {
    characterId,
    pose: DEFAULT_CHARACTER_STATE.pose,
    expression: DEFAULT_CHARACTER_STATE.expression,
    outfit: character?.defaultOutfit?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.outfit,
    view: DEFAULT_CHARACTER_STATE.view,
  };
}

/**
 * Build the kit for a character, relative to a state.
 *
 * `state` defaults to the character's own defaults; pass a placed instance's
 * state to get options describing what switching THAT instance would cost.
 */
export function buildCharacterKit(
  doc: ProjectDocument,
  character: Character,
  state?: CharacterState,
): CharacterKit {
  const current = state ?? defaultCharacterState(character.id, character);
  const renders = character.assetIds
    .map((id) => doc.assets[id])
    .filter((asset): asset is SourceAsset => Boolean(asset))
    .filter((asset) => asset.status !== "archived")
    .filter((asset) => asset.metadata?.characterAssetRole !== "canonical");

  const dimensions = {} as Record<KitDimension, KitOption[]>;
  for (const dimension of KIT_DIMENSIONS) {
    const values = availableCharacterStateValues(doc, character, dimension);
    dimensions[dimension] = values.map((value) => {
      // "Cached" means: switching only this dimension lands on a real render.
      const candidate: CharacterState = { ...current, [dimension]: value, assetId: undefined };
      const exact = findExactCharacterAsset(doc, character, candidate);
      const known = renders.some((asset) => stateFromAsset(asset, character.id)?.[dimension] === value);
      return {
        value,
        label: toLabel(value),
        cached: Boolean(exact),
        known,
        previewAssetId: exact?.id,
      };
    });
  }

  return {
    characterId: character.id,
    name: character.name,
    canonicalAssetId: characterReferenceId(character),
    defaultOutfit: character.defaultOutfit?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.outfit,
    state: current,
    dimensions,
    renderedStateCount: renders.length,
  };
}

export function kitOption(kit: CharacterKit, dimension: KitDimension, value: string): KitOption | undefined {
  return kit.dimensions[dimension].find((option) => option.value === value);
}

function toLabel(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
