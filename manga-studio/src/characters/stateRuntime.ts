"use client";

import { callGenerateApi, storeGeneratedAsset } from "@/ai/clientGeneration";
import { buildAssetPrompt, buildCharacterStatePrompt } from "@/ai/promptTemplates";
import { swapInstanceAsset } from "@/domain/itemOps";
import type { Character, CharacterState, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import {
  DEFAULT_CHARACTER_STATE,
  characterReferenceId,
  findCompatibleCharacterAsset,
  findExactCharacterAsset,
  mergeCharacterState,
  stateFromInstance,
  type CharacterStatePatch,
} from "./state";

export type CharacterGenerationRole = "canonical" | "state";

export interface CharacterGenerationProgress {
  stage: "resolving" | "generating" | "saving" | "complete";
  state: CharacterState;
}

async function providerSupportsReference(): Promise<boolean> {
  try {
    const status = await fetch("/api/provider/status").then((response) => response.json());
    return Boolean(status?.capabilities?.referenceImage);
  } catch {
    return false;
  }
}

export async function generateCharacterAssetForState(input: {
  characterId: ID;
  state: CharacterState;
  role?: CharacterGenerationRole;
  instruction?: string;
}): Promise<ID> {
  const doc = useEditorStore.getState().doc;
  const character = doc?.characters[input.characterId];
  if (!doc || !character) throw new Error("Character no longer exists");

  const role = input.role ?? "state";
  const canonicalId = characterReferenceId(character);
  const canonical = canonicalId ? doc.assets[canonicalId] : undefined;
  const compatible = role === "state" ? findCompatibleCharacterAsset(doc, character, input.state) : undefined;
  const useReference = role === "state" && Boolean(canonical) && (await providerSupportsReference());
  const referenceAssets = useReference
    ? [canonical, compatible].filter((asset, index, list) =>
        Boolean(asset) && list.findIndex((candidate) => candidate?.id === asset?.id) === index,
      )
    : [];
  const assetType = role === "canonical" ? "character" : "character-pose";
  const prompt =
    role === "canonical"
      ? buildAssetPrompt({
          assetType: "character",
          characterName: character.name,
          characterDescription: character.description,
          description: input.instruction,
        })
      : buildCharacterStatePrompt({
          characterName: character.name,
          characterDescription: character.description,
          ...input.state,
          description: input.instruction,
          hasReference: useReference,
        });

  const result = await callGenerateApi({
    assetType,
    prompt,
    size: "portrait",
    referenceUrls: referenceAssets.length > 0 ? referenceAssets.map((asset) => asset!.storageUrl) : undefined,
  });
  return storeGeneratedAsset({
    result,
    assetType,
    category: "character",
    name:
      role === "canonical"
        ? `${character.name} canonical reference`
        : `${character.name} · ${input.state.pose} · ${input.state.expression} · ${input.state.outfit} · ${input.state.view}`,
    prompt,
    metadata: {
      characterId: character.id,
      pose: input.state.pose,
      expression: input.state.expression,
      outfit: input.state.outfit,
      view: input.state.view,
      characterAssetRole: role,
      canonicalReferenceAssetId: role === "canonical" ? undefined : canonicalId,
      referenceAssetIds: referenceAssets.length > 0 ? referenceAssets.map((asset) => asset!.id) : undefined,
    },
  });
}

export async function applyCharacterStateToInstance(input: {
  instanceId: ID;
  patch: CharacterStatePatch;
  generateIfMissing?: boolean;
  forceRegenerate?: boolean;
  instruction?: string;
  onProgress?: (progress: CharacterGenerationProgress) => void;
}): Promise<{
  assetId: ID;
  state: CharacterState;
  source: "cache" | "generated";
  previousAssetId: ID;
  previousState: CharacterState;
}> {
  const initialDoc = useEditorStore.getState().doc;
  const instance = initialDoc?.items[input.instanceId];
  if (!initialDoc || !instance || instance.kind !== "asset") throw new Error("Character instance not found");
  const current = stateFromInstance(initialDoc, instance);
  if (!current) throw new Error("The selected asset is not a character");
  const character = initialDoc.characters[current.characterId];
  if (!character) throw new Error("Character no longer exists");
  const desired = mergeCharacterState(current, input.patch);
  input.onProgress?.({ stage: "resolving", state: desired });

  const exact = input.forceRegenerate
    ? undefined
    : findExactCharacterAsset(initialDoc, character, desired);
  let assetId: ID;
  let source: "cache" | "generated";
  if (exact) {
    assetId = exact.id;
    source = "cache";
  } else {
    if (input.generateIfMissing === false) {
      throw new Error(`No cached ${desired.pose} + ${desired.expression} character state`);
    }
    input.onProgress?.({ stage: "generating", state: desired });
    assetId = await generateCharacterAssetForState({
      characterId: character.id,
      state: desired,
      role: "state",
      instruction: input.instruction,
    });
    source = "generated";
    input.onProgress?.({ stage: "saving", state: desired });
  }

  useEditorStore.getState().commit((doc) => swapInstanceAsset(doc, input.instanceId, assetId));
  input.onProgress?.({ stage: "complete", state: { ...desired, assetId } });
  return {
    assetId,
    state: { ...desired, assetId },
    source,
    previousAssetId: instance.sourceAssetId,
    previousState: current,
  };
}

export function starterPackStates(character: Character): CharacterState[] {
  const base = { characterId: character.id, ...DEFAULT_CHARACTER_STATE };
  return [
    base,
    { ...base, pose: "walking" },
    { ...base, pose: "running" },
    { ...base, pose: "sitting" },
    { ...base, expression: "happy" },
    { ...base, expression: "angry" },
    { ...base, expression: "crying" },
    { ...base, expression: "surprised" },
  ];
}
