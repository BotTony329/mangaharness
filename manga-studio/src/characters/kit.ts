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

import type { Character, CharacterState, CharacterStateRecord, ID, ProjectDocument } from "@/domain/types";
import {
  describeRecord,
  findNearestRenderedState,
  findRenderedStateRecord,
  knownProps,
  renderedStateRecords,
} from "./stateGraph";
import { propsAfterDrop } from "./stateResolver";
import {
  DEFAULT_CHARACTER_STATE,
  availableCharacterStateValues,
  characterReferenceId,
  type CharacterStateValueKey,
} from "./state";

export type KitDimension = CharacterStateValueKey;

export const KIT_DIMENSIONS: KitDimension[] = ["pose", "expression", "outfit", "view"];

/**
 * Availability of one kit option, relative to the state being viewed (§4).
 *
 * "cached" is deliberately strict: it means the EXACT state exists as a render.
 * A value that appears in some other combination is "available" — offered, but
 * honestly marked as requiring generation. Conflating the two is what makes a
 * product pretend a semantic state exists when only a compatible image does.
 */
export type KitAvailability = "cached" | "available" | "new";

export interface KitOption {
  value: string;
  label: string;
  availability: KitAvailability;
  /** A ready render exists for this value combined with the current state. */
  cached: boolean;
  /** Any ready render uses this value, in some other state combination. */
  known: boolean;
  previewAssetId?: ID;
  /** Nearest render that would anchor generating this option, when not cached. */
  referenceLabel?: string;
}

export interface CharacterKit {
  characterId: ID;
  name: string;
  canonicalAssetId?: ID;
  defaultOutfit: string;
  /** The state the kit is being viewed against; option caching is relative to it. */
  state: CharacterState;
  dimensions: Record<KitDimension, KitOption[]>;
  /** Props this character has been rendered holding. */
  props: KitOption[];
  /** Every rendered node in this character's state graph, newest first. */
  renderedStates: CharacterStateRecord[];
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
  const rendered = renderedStateRecords(doc, character.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const optionFor = (candidate: CharacterState, value: string, known: boolean): KitOption => {
    const exact = findRenderedStateRecord(doc, candidate);
    if (exact?.assetId) {
      return {
        value,
        label: toLabel(value),
        availability: "cached",
        cached: true,
        known: true,
        previewAssetId: exact.assetId,
      };
    }
    const nearest = findNearestRenderedState(doc, candidate);
    return {
      value,
      label: toLabel(value),
      availability: known ? "available" : "new",
      cached: false,
      known,
      referenceLabel: nearest ? describeRecord(nearest.record) : undefined,
    };
  };

  const dimensions = {} as Record<KitDimension, KitOption[]>;
  for (const dimension of KIT_DIMENSIONS) {
    const values = availableCharacterStateValues(doc, character, dimension);
    dimensions[dimension] = values.map((value) =>
      optionFor(
        { ...current, [dimension]: value, assetId: undefined, stateId: undefined },
        value,
        rendered.some((record) => record[dimension] === value),
      ),
    );
  }

  const props = knownProps(doc, character).map((prop) =>
    optionFor(
      { ...current, props: propsAfterDrop(current.props, prop), assetId: undefined, stateId: undefined },
      prop,
      true,
    ),
  );

  return {
    characterId: character.id,
    name: character.name,
    canonicalAssetId: characterReferenceId(character),
    defaultOutfit: character.defaultOutfit?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.outfit,
    state: current,
    dimensions,
    props,
    renderedStates: rendered,
    renderedStateCount: rendered.length,
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
