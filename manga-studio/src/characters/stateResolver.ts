/**
 * The one place that answers "what should this character look like now?" and,
 * when a render is missing, "what should we generate it FROM?" (§2).
 *
 *   requested state
 *     → exact cached state?          reuse, no generation
 *     → nearest compatible render?   generate the delta from it
 *     → canonical reference?         generate anchored on identity
 *     → nothing                      generate from description alone
 *
 * A compatible render is NEVER returned as though it were the requested state.
 * It is only ever offered as a reference to generate from, and the choice is
 * surfaced so the creator can see and override it (§3).
 *
 * The resolver only DECIDES. It performs no mutation and no generation, which
 * keeps it pure, testable, and identical for the UI and the Agent.
 */

import type {
  Character,
  CharacterState,
  CharacterStateDelta,
  CharacterStateRecord,
  ID,
  ProjectDocument,
  SourceAsset,
} from "@/domain/types";
import { characterReferenceId, mergeCharacterState, sameCharacterState, stateFromInstance, type CharacterStatePatch } from "./state";
import { defaultCharacterState } from "./kit";
import { SOCKET_DIMENSION, type SocketDragPayload } from "./sockets";
import type { CharacterSocket } from "@/domain/types";
import {
  buildDelta,
  describeRecord,
  findNearestRenderedState,
  findRenderedStateRecord,
  normalizeProps,
} from "./stateGraph";

/** Where the identity anchor for a generation comes from. */
export type ReferenceKind = "nearest-state" | "canonical" | "current" | "explicit" | "none";

export interface ReferenceChoice {
  kind: ReferenceKind;
  assetId?: ID;
  /** The graph node the reference came from, when it was a rendered state. */
  stateId?: ID;
  /** How far that state is from the request; 0 for canonical/none. */
  cost: number;
  /** Shown in the reference selector, e.g. "Auto — Yuri Walking". */
  label: string;
}

export type StateResolution =
  | { status: "character-not-found"; characterId: ID }
  | {
      status: "cached";
      state: CharacterState;
      assetId: ID;
      asset: SourceAsset;
      record: CharacterStateRecord;
    }
  | {
      status: "needs-generation";
      state: CharacterState;
      reference: ReferenceChoice;
      /** Which dimensions must change relative to the reference. */
      delta: CharacterStateDelta;
      parentStateId?: ID;
      canonicalAssetId?: ID;
    };

export interface ResolveOptions {
  excludeAssetId?: ID;
  /** Force a specific reference instead of the automatic choice (§3 advanced). */
  referenceOverride?: { kind: Exclude<ReferenceKind, "nearest-state">; assetId?: ID; stateId?: ID };
  /** Skip the cache and resolve as if the exact state did not exist. */
  forceRegenerate?: boolean;
}

/**
 * Resolve a desired state against the state graph.
 *
 * The returned `reference` is authoritative: whatever it names is what must be
 * sent to the provider. Callers do not re-derive it.
 */
export function resolveCharacterState(
  doc: ProjectDocument,
  desired: CharacterState,
  options: ResolveOptions = {},
): StateResolution {
  const character = doc.characters[desired.characterId];
  if (!character) return { status: "character-not-found", characterId: desired.characterId };

  const normalized: CharacterState = { ...desired, props: normalizeProps(desired.props) };
  if (normalized.props!.length === 0) delete normalized.props;

  if (!options.forceRegenerate) {
    const exact = findRenderedStateRecord(doc, normalized, options.excludeAssetId);
    const asset = exact?.assetId ? doc.assets[exact.assetId] : undefined;
    if (exact && asset) {
      return {
        status: "cached",
        state: { ...normalized, assetId: asset.id, stateId: exact.id },
        assetId: asset.id,
        asset,
        record: exact,
      };
    }
  }

  const canonicalAssetId = characterReferenceId(character);
  const reference = chooseReference(doc, character, normalized, canonicalAssetId, options);
  const parentRecord = reference.stateId ? doc.characterStates[reference.stateId] : undefined;

  return {
    status: "needs-generation",
    state: { ...normalized, assetId: undefined, stateId: undefined },
    reference,
    delta: buildDelta(parentRecord, normalized),
    parentStateId: parentRecord?.id,
    canonicalAssetId,
  };
}

function chooseReference(
  doc: ProjectDocument,
  character: Character,
  desired: CharacterState,
  canonicalAssetId: ID | undefined,
  options: ResolveOptions,
): ReferenceChoice {
  const override = options.referenceOverride;
  if (override) {
    if (override.kind === "none") return { kind: "none", cost: 0, label: "No reference" };
    const record = override.stateId ? doc.characterStates[override.stateId] : undefined;
    const assetId = override.assetId ?? record?.assetId;
    if (assetId && doc.assets[assetId]) {
      return {
        kind: override.kind,
        assetId,
        stateId: record?.id,
        cost: record ? 0 : 0,
        label:
          override.kind === "canonical"
            ? `${character.name} canonical`
            : record
              ? `${character.name} ${describeRecord(record)}`
              : doc.assets[assetId].name,
      };
    }
    // A stale override must not silently become "no reference".
  }

  const nearest = findNearestRenderedState(doc, desired, { excludeAssetId: options.excludeAssetId });
  if (nearest?.record.assetId && doc.assets[nearest.record.assetId]) {
    return {
      kind: "nearest-state",
      assetId: nearest.record.assetId,
      stateId: nearest.record.id,
      cost: nearest.cost,
      label: `${character.name} ${describeRecord(nearest.record)}`,
    };
  }

  if (canonicalAssetId && doc.assets[canonicalAssetId]) {
    return { kind: "canonical", assetId: canonicalAssetId, cost: 0, label: `${character.name} canonical` };
  }
  return { kind: "none", cost: 0, label: "No reference yet" };
}

/** Every reference the selector may offer, automatic choice first (§3). */
export interface ReferenceOption {
  kind: ReferenceKind;
  assetId?: ID;
  stateId?: ID;
  label: string;
  /** True for the entry the resolver would pick on its own. */
  automatic: boolean;
}

export function referenceOptions(
  doc: ProjectDocument,
  desired: CharacterState,
  currentAssetId?: ID,
): ReferenceOption[] {
  const character = doc.characters[desired.characterId];
  if (!character) return [];
  const auto = resolveCharacterState(doc, desired, { forceRegenerate: true });
  const automatic = auto.status === "needs-generation" ? auto.reference : undefined;

  const options: ReferenceOption[] = [
    {
      kind: "nearest-state",
      assetId: automatic?.assetId,
      stateId: automatic?.stateId,
      label: automatic ? `Auto — ${automatic.label}` : "Auto",
      automatic: true,
    },
  ];

  const canonicalAssetId = characterReferenceId(character);
  if (canonicalAssetId && doc.assets[canonicalAssetId]) {
    options.push({ kind: "canonical", assetId: canonicalAssetId, label: `${character.name} canonical`, automatic: false });
  }
  if (currentAssetId && doc.assets[currentAssetId]) {
    options.push({ kind: "current", assetId: currentAssetId, label: "Current state", automatic: false });
  }
  for (const record of Object.values(doc.characterStates)) {
    if (record.characterId !== character.id || !record.assetId) continue;
    if (!doc.assets[record.assetId]) continue;
    if (record.assetId === canonicalAssetId || record.assetId === currentAssetId) continue;
    options.push({
      kind: "explicit",
      assetId: record.assetId,
      stateId: record.id,
      label: describeRecord(record),
      automatic: false,
    });
  }
  options.push({ kind: "none", label: "No reference (description only)", automatic: false });
  return options;
}

/** Resolve a patch applied to an instance's current state. */
export function resolveInstancePatch(
  doc: ProjectDocument,
  instanceId: ID,
  patch: CharacterStatePatch,
  options: ResolveOptions = {},
): { current: CharacterState; desired: CharacterState; resolution: StateResolution } | null {
  const instance = doc.items[instanceId];
  if (!instance || instance.kind !== "asset") return null;
  const current = stateFromInstance(doc, instance);
  if (!current) return null;
  const desired = mergeCharacterState(current, patch);
  return { current, desired, resolution: resolveCharacterState(doc, desired, options) };
}

/**
 * Translate a socket drop into a state patch (§5).
 *
 * A socket may only touch its own dimension. Dropping an expression on the face
 * changes the expression and nothing else — the guarantee that makes the
 * character behave like one actor rather than a stack of layers.
 */
export function patchForSocketDrop(socket: CharacterSocket, payload: SocketDragPayload): CharacterStatePatch | null {
  const dimension = SOCKET_DIMENSION[socket];
  if (payload.dimension !== dimension) return null;
  if (dimension === "props") return null; // props are a list; use propsPatchForDrop
  return { [dimension]: payload.value } as CharacterStatePatch;
}

/** Props are additive rather than replacing, so a drop appends to the held set. */
export function propsAfterDrop(current: string[] | undefined, value: string): string[] {
  return normalizeProps([...(current ?? []), value]);
}

/** Which sockets a drag payload is allowed to land on. */
export function acceptableSockets(payload: SocketDragPayload): CharacterSocket[] {
  return (Object.keys(SOCKET_DIMENSION) as CharacterSocket[]).filter(
    (socket) => SOCKET_DIMENSION[socket] === payload.dimension,
  );
}

/** Whether a state change is a no-op, checked before dispatching anything. */
export function isNoOpChange(current: CharacterState, desired: CharacterState): boolean {
  return sameCharacterState(current, desired);
}

/** The state a fresh placement of this character should start in. */
export function initialStateFor(doc: ProjectDocument, characterId: ID): CharacterState | null {
  const character: Character | undefined = doc.characters[characterId];
  if (!character) return null;
  return defaultCharacterState(characterId, character);
}

export interface StateCoverage {
  requested: number;
  cached: number;
  missing: CharacterState[];
}

/** How much of a set of states already exists, so cost can be shown up front. */
export function stateCoverage(doc: ProjectDocument, states: CharacterState[]): StateCoverage {
  const missing: CharacterState[] = [];
  let cached = 0;
  for (const state of states) {
    const resolution = resolveCharacterState(doc, state);
    if (resolution.status === "cached") cached += 1;
    else if (resolution.status === "needs-generation") missing.push(resolution.state);
  }
  return { requested: states.length, cached, missing };
}
