"use client";

/**
 * CharacterService — one entry point for character lifecycle operations.
 *
 * "+ New Character" in the library UI and the Agent's create_character tool
 * both call `createCharacter` here; neither dispatches the command nor rolls
 * back reference-upload failures on its own anymore. Asset generation stays in
 * `characters/stateRuntime` (the shared cache-or-generate resolver); this
 * service names the application boundary and owns multi-command
 * orchestration + failure rollback.
 */

import { generateCharacterAssetForState } from "@/characters/stateRuntime";
import { DEFAULT_CHARACTER_STATE, type CharacterStatePatch } from "@/characters/state";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { uploadImageFile } from "@/components/library/uploadAsset";

export interface CreateCharacterInput {
  name: string;
  appearance?: string;
  personalityNotes?: string;
}

/** Create the library character. Returns the stable domain character id. */
export function createCharacter(input: CreateCharacterInput): ID {
  const created = useEditorStore.getState().dispatch({
    type: "create-character",
    name: input.name.trim(),
    appearance: input.appearance?.trim() || undefined,
    personalityNotes: input.personalityNotes?.trim() || undefined,
  });
  if (!created.createdId) throw new Error("Character creation failed");
  return created.createdId;
}

/**
 * Upload a canonical reference photo for a character created moments ago.
 * Atomic with respect to the character: if the upload fails, the just-created
 * character is removed again so the library never holds a reference-less
 * shell the creator did not ask for.
 */
export async function attachCanonicalReferenceFile(characterId: ID, file: File, characterName: string): Promise<ID> {
  try {
    const assetId = await uploadImageFile(file, "character", {
      name: `${characterName} reference`,
      metadata: {
        characterId,
        ...DEFAULT_CHARACTER_STATE,
        characterAssetRole: "canonical",
      },
    });
    useEditorStore.getState().dispatch({ type: "set-character-reference", characterId, assetId });
    return assetId;
  } catch (cause) {
    useEditorStore.getState().dispatch({ type: "delete-character", characterId, mode: "delete-all" });
    throw cause;
  }
}

/** Generate (or regenerate) the canonical reference image. */
export function generateCanonicalReference(characterId: ID) {
  return generateCharacterAssetForState({
    characterId,
    state: { characterId, ...DEFAULT_CHARACTER_STATE },
    role: "canonical",
  });
}

/** Generate one pose/expression/outfit/view state for a character. */
export function generateCharacterState(characterId: ID, state: CharacterStatePatch) {
  return generateCharacterAssetForState({
    characterId,
    state: { characterId, ...DEFAULT_CHARACTER_STATE, ...state },
    role: "state",
  });
}

/** Replace an asset's bytes everywhere it is used. */
export function replaceCharacterAsset(oldAssetId: ID, newAssetId: ID): void {
  useEditorStore.getState().dispatch({ type: "replace-asset", oldAssetId, newAssetId });
}
