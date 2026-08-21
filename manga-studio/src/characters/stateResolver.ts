/**
 * The one place that answers "what should this character look like now?" (§4).
 *
 *   semantic state → cached render? → reuse : generate → cache
 *
 * Every caller — the inspector dropdowns, a socket drop, the Agent — asks this
 * module rather than deciding for itself. That is what stops the product from
 * regenerating an image every time the creator changes something, and what
 * keeps a missing render from silently substituting a different state.
 *
 * The resolver only DECIDES. It performs no mutation and no generation, so it
 * stays pure, testable, and usable from both the UI and the Agent.
 */

import type { Character, CharacterState, ID, ProjectDocument, SourceAsset } from "@/domain/types";
import {
  characterReferenceId,
  findCompatibleCharacterAsset,
  findExactCharacterAsset,
  mergeCharacterState,
  sameCharacterState,
  stateFromInstance,
  type CharacterStatePatch,
} from "./state";
import { defaultCharacterState } from "./kit";
import { SOCKET_DIMENSION, type SocketDragPayload } from "./sockets";
import type { CharacterSocket } from "@/domain/types";

export type StateResolution =
  | { status: "character-not-found"; characterId: ID }
  | { status: "cached"; state: CharacterState; assetId: ID; asset: SourceAsset }
  | {
      status: "needs-generation";
      state: CharacterState;
      /** Canonical identity anchor for the render. */
      canonicalAssetId?: ID;
      /** Closest existing render, for generation guidance only — never a substitute. */
      guidanceAssetId?: ID;
    };

/**
 * Resolve a desired state against the library.
 *
 * `excludeAssetId` lets a "regenerate this variant" flow avoid resolving back
 * to the asset it is trying to replace.
 */
export function resolveCharacterState(
  doc: ProjectDocument,
  desired: CharacterState,
  options: { excludeAssetId?: ID } = {},
): StateResolution {
  const character = doc.characters[desired.characterId];
  if (!character) return { status: "character-not-found", characterId: desired.characterId };

  const exact = findExactCharacterAsset(doc, character, desired, options.excludeAssetId);
  if (exact) {
    return { status: "cached", state: { ...desired, assetId: exact.id }, assetId: exact.id, asset: exact };
  }

  return {
    status: "needs-generation",
    state: { ...desired, assetId: undefined },
    canonicalAssetId: characterReferenceId(character),
    guidanceAssetId: findCompatibleCharacterAsset(doc, character, desired)?.id,
  };
}

/** Resolve a patch applied to an instance's current state. */
export function resolveInstancePatch(
  doc: ProjectDocument,
  instanceId: ID,
  patch: CharacterStatePatch,
): { current: CharacterState; desired: CharacterState; resolution: StateResolution } | null {
  const instance = doc.items[instanceId];
  if (!instance || instance.kind !== "asset") return null;
  const current = stateFromInstance(doc, instance);
  if (!current) return null;
  const desired = mergeCharacterState(current, patch);
  return { current, desired, resolution: resolveCharacterState(doc, desired) };
}

/**
 * Translate a socket drop into a state patch (§5/§6).
 *
 * A socket may only touch its own dimension. Dropping an expression on the face
 * changes the expression and nothing else — this is the guarantee that makes
 * the character behave like one actor rather than a stack of layers.
 */
export function patchForSocketDrop(socket: CharacterSocket, payload: SocketDragPayload): CharacterStatePatch | null {
  const dimension = SOCKET_DIMENSION[socket];
  if (payload.dimension !== dimension) return null;
  return { [dimension]: payload.value } as CharacterStatePatch;
}

/** Which sockets a drag payload is allowed to land on. */
export function acceptableSockets(payload: SocketDragPayload): CharacterSocket[] {
  return (Object.keys(SOCKET_DIMENSION) as CharacterSocket[]).filter(
    (socket) => SOCKET_DIMENSION[socket] === payload.dimension,
  );
}

/**
 * Whether a state change is a no-op.
 *
 * Checked before dispatching so dragging "Angry" onto an already-angry
 * character does not create an undo entry or trigger a generation.
 */
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

/**
 * How much of a set of states already exists.
 *
 * The Agent uses this to report generation cost before running, so a plan can
 * be confirmed on real numbers instead of a guess.
 */
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
