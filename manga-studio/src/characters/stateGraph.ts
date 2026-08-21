/**
 * The character state graph (D33).
 *
 * A character stops being a folder of renders and becomes a graph of semantic
 * states, each knowing which state it was derived FROM and which image actually
 * anchored its generation. That lineage is what makes drift traceable and what
 * lets a new state be generated as a delta from the nearest existing render
 * instead of always re-anchoring to the canonical image.
 *
 * Nodes are semantic; assets are the immutable renders they point at. Keeping
 * them separate is deliberate: a state can be requested before it has a render,
 * and a render can be replaced without losing the state's history.
 */

import type {
  Character,
  CharacterState,
  CharacterStateDelta,
  CharacterStateDimension,
  CharacterStateRecord,
  ID,
  ProjectDocument,
  SourceAsset,
} from "@/domain/types";
import { DEFAULT_CHARACTER_STATE, normalizeStateValue } from "./state";

export const STATE_DIMENSIONS: CharacterStateDimension[] = ["pose", "expression", "outfit", "view"];

/**
 * Dimension weights for nearest-state search.
 *
 * Outfit and view dominate because they change the largest area of the drawing:
 * re-posing a character in the same outfit preserves far more of the reference
 * than keeping the pose while swapping the outfit. Expression is cheapest to
 * change because it touches only the face.
 */
const DIMENSION_WEIGHT: Record<CharacterStateDimension, number> = {
  outfit: 8,
  view: 6,
  pose: 4,
  expression: 2,
};

const PROPS_WEIGHT = 3;

/** Props normalized to a stable, comparable form. */
export function normalizeProps(props: string[] | undefined): string[] {
  if (!props || props.length === 0) return [];
  return [...new Set(props.map((prop) => prop.trim().toLowerCase()).filter(Boolean))].sort();
}

export function sameProps(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = normalizeProps(a);
  const right = normalizeProps(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Full semantic identity of a state, ignoring which asset happens to render it. */
export function stateKey(state: Pick<CharacterState, CharacterStateDimension | "characterId" | "props">): string {
  return [
    state.characterId,
    ...STATE_DIMENSIONS.map((dimension) => normalizeStateValue(state[dimension], DEFAULT_CHARACTER_STATE[dimension])),
    normalizeProps(state.props).join("+"),
  ].join("|");
}

export function recordKey(record: CharacterStateRecord): string {
  return stateKey(record);
}

export function stateFromRecord(record: CharacterStateRecord): CharacterState {
  return {
    characterId: record.characterId,
    pose: record.pose,
    expression: record.expression,
    outfit: record.outfit,
    view: record.view,
    props: record.props.length > 0 ? [...record.props] : undefined,
    assetId: record.assetId,
    stateId: record.id,
  };
}

/** Every graph node belonging to one character. */
export function characterStateRecords(doc: ProjectDocument, characterId: ID): CharacterStateRecord[] {
  return Object.values(doc.characterStates).filter((record) => record.characterId === characterId);
}

/** Nodes that actually have a usable render, in the project's current style. */
export function renderedStateRecords(doc: ProjectDocument, characterId: ID): CharacterStateRecord[] {
  const activeStyleId = doc.project.settings.artStyle.activeStyleId;
  return characterStateRecords(doc, characterId).filter((record) => {
    if (!record.assetId) return false;
    const asset: SourceAsset | undefined = doc.assets[record.assetId];
    if (!asset || asset.status === "archived") return false;
    // A render from another art style is not a usable reference for this one.
    return record.styleProfileId === activeStyleId;
  });
}

export function findStateRecord(
  doc: ProjectDocument,
  desired: CharacterState,
): CharacterStateRecord | undefined {
  const key = stateKey(desired);
  return characterStateRecords(doc, desired.characterId).find((record) => recordKey(record) === key);
}

/** Exact rendered match — the only thing that may be presented AS the requested state. */
export function findRenderedStateRecord(
  doc: ProjectDocument,
  desired: CharacterState,
  excludeAssetId?: ID,
): CharacterStateRecord | undefined {
  const key = stateKey(desired);
  return renderedStateRecords(doc, desired.characterId)
    .filter((record) => record.assetId !== excludeAssetId)
    .filter((record) => recordKey(record) === key)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export interface StateDistance {
  record: CharacterStateRecord;
  /** Sum of the weights of every differing dimension. 0 means identical. */
  cost: number;
  changed: CharacterStateDimension[];
  propsChanged: boolean;
}

/** How far one rendered state is from a requested state. */
export function stateDistance(record: CharacterStateRecord, desired: CharacterState): StateDistance {
  const changed: CharacterStateDimension[] = [];
  let cost = 0;
  for (const dimension of STATE_DIMENSIONS) {
    const wanted = normalizeStateValue(desired[dimension], DEFAULT_CHARACTER_STATE[dimension]);
    if (record[dimension] !== wanted) {
      changed.push(dimension);
      cost += DIMENSION_WEIGHT[dimension];
    }
  }
  const propsChanged = !sameProps(record.props, desired.props);
  if (propsChanged) cost += PROPS_WEIGHT;
  return { record, cost, changed, propsChanged };
}

/**
 * The closest rendered state to work FROM.
 *
 * Returns undefined when nothing is close enough to help. `maxCost` exists so a
 * wildly different render is not used as a reference just because it is the
 * only one — re-anchoring to canonical is better than inheriting the wrong
 * outfit and view.
 */
export function findNearestRenderedState(
  doc: ProjectDocument,
  desired: CharacterState,
  options: { excludeAssetId?: ID; maxCost?: number } = {},
): StateDistance | undefined {
  const maxCost = options.maxCost ?? DIMENSION_WEIGHT.outfit + DIMENSION_WEIGHT.view;
  return renderedStateRecords(doc, desired.characterId)
    .filter((record) => record.assetId !== options.excludeAssetId)
    .map((record) => stateDistance(record, desired))
    .filter((candidate) => candidate.cost > 0 && candidate.cost <= maxCost)
    .sort((a, b) => a.cost - b.cost || b.record.createdAt.localeCompare(a.record.createdAt))[0];
}

export function buildDelta(parent: CharacterStateRecord | undefined, desired: CharacterState): CharacterStateDelta {
  if (!parent) {
    return {
      changed: [...STATE_DIMENSIONS],
      propsChanged: normalizeProps(desired.props).length > 0,
      to: Object.fromEntries(
        STATE_DIMENSIONS.map((dimension) => [
          dimension,
          normalizeStateValue(desired[dimension], DEFAULT_CHARACTER_STATE[dimension]),
        ]),
      ),
    };
  }
  const distance = stateDistance(parent, desired);
  return {
    changed: distance.changed,
    propsChanged: distance.propsChanged,
    from: Object.fromEntries(distance.changed.map((dimension) => [dimension, parent[dimension]])),
    to: Object.fromEntries(
      distance.changed.map((dimension) => [
        dimension,
        normalizeStateValue(desired[dimension], DEFAULT_CHARACTER_STATE[dimension]),
      ]),
    ),
  };
}

/**
 * Walk a node's ancestry back to its root.
 *
 * Cycles cannot occur through normal creation (a parent always predates its
 * child), but the guard keeps a corrupted or hand-edited document from hanging
 * the editor.
 */
export function lineageOf(doc: ProjectDocument, stateId: ID): CharacterStateRecord[] {
  const chain: CharacterStateRecord[] = [];
  const seen = new Set<ID>();
  let current: CharacterStateRecord | undefined = doc.characterStates[stateId];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentStateId ? doc.characterStates[current.parentStateId] : undefined;
  }
  return chain;
}

/** Human-readable state label, e.g. "Walking · Shocked". */
export function describeState(state: Pick<CharacterState, CharacterStateDimension | "props">): string {
  const parts = [state.pose, state.expression];
  const outfit = normalizeStateValue(state.outfit, DEFAULT_CHARACTER_STATE.outfit);
  if (outfit !== DEFAULT_CHARACTER_STATE.outfit) parts.push(outfit);
  const view = normalizeStateValue(state.view, DEFAULT_CHARACTER_STATE.view);
  if (view !== DEFAULT_CHARACTER_STATE.view) parts.push(view);
  const props = normalizeProps(state.props);
  if (props.length > 0) parts.push(`+${props.join(", ")}`);
  return parts.map(titleCase).join(" · ");
}

export function describeRecord(record: CharacterStateRecord): string {
  return describeState(record);
}

/** All prop values this character has ever been rendered with. */
export function knownProps(doc: ProjectDocument, character: Character): string[] {
  const values = new Set<string>();
  for (const record of characterStateRecords(doc, character.id)) {
    for (const prop of record.props) values.add(prop);
  }
  return [...values].sort();
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
