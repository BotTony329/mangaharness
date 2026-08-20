"use client";

import { callGenerateApi, storeGeneratedAsset } from "@/ai/clientGeneration";
import { buildAssetPrompt, buildCharacterStatePrompt } from "@/ai/promptTemplates";
import { swapInstanceAsset } from "@/domain/itemOps";
import type { Character, CharacterState, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import {
  DEFAULT_CHARACTER_STATE,
  characterReferenceId,
  characterIdentityDescription,
  findCompatibleCharacterAsset,
  findExactCharacterAsset,
  mergeCharacterState,
  stateFromInstance,
  type CharacterStatePatch,
} from "./state";
import { getStyleGenerationContext, styleMetadata } from "@/styles/generation";
import { assetRenderUrl } from "@/assets/renderSource";

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
  continuityFrom?: CharacterState;
  changedDimensions?: (keyof CharacterStatePatch)[];
}): Promise<ID> {
  const doc = useEditorStore.getState().doc;
  const character = doc?.characters[input.characterId];
  if (!doc || !character) throw new Error("Character no longer exists");

  const role = input.role ?? "state";
  const style = getStyleGenerationContext(doc);
  const canonicalId = characterReferenceId(character);
  const canonical = canonicalId ? doc.assets[canonicalId] : undefined;
  const compatible = role === "state" ? findCompatibleCharacterAsset(doc, character, input.state) : undefined;
  const supportsReference = await providerSupportsReference();
  const useIdentityReference = role === "state" && Boolean(canonical) && supportsReference;
  const referenceAssets = supportsReference
    ? [role === "state" ? canonical : undefined, role === "state" ? compatible : undefined, style.referenceAsset].filter((asset, index, list) =>
        Boolean(asset) && list.findIndex((candidate) => candidate?.id === asset?.id) === index,
      )
    : [];
  const continuity = buildContinuityInstruction(input.continuityFrom, input.state, input.changedDimensions);
  const assetType = role === "canonical" ? "character" : "character-pose";
  const prompt =
    role === "canonical"
      ? buildAssetPrompt({
          assetType: "character",
          characterName: character.name,
          characterDescription: characterIdentityDescription(character),
          description: [input.instruction, continuity].filter(Boolean).join(" ") || undefined,
          style: style.profile,
        })
      : buildCharacterStatePrompt({
          characterName: character.name,
          characterDescription: characterIdentityDescription(character),
          ...input.state,
          description: [continuity, input.instruction].filter(Boolean).join(" ") || undefined,
          hasReference: useIdentityReference,
          style: style.profile,
        });

  const result = await callGenerateApi({
    assetType,
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "portrait",
    referenceUrls: referenceAssets.length > 0 ? referenceAssets.map((asset) => assetRenderUrl(asset)!).filter(Boolean) : undefined,
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
      ...styleMetadata(style),
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
      continuityFrom: current,
      changedDimensions: (Object.keys(input.patch) as (keyof CharacterStatePatch)[]).filter(
        (key) => input.patch[key] !== undefined,
      ),
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

function buildContinuityInstruction(
  current: CharacterState | undefined,
  desired: CharacterState,
  changed: (keyof CharacterStatePatch)[] | undefined,
): string | undefined {
  if (!current || !changed || changed.length === 0) return undefined;
  const preserved = (["pose", "expression", "outfit", "view"] as (keyof CharacterStatePatch)[]).filter(
    (key) => !changed.includes(key),
  );
  return [
    preserved.length > 0
      ? `Preserve the current ${preserved.map((key) => `${key} (${desired[key]})`).join(", ")}.`
      : "",
    `Change only ${changed.map((key) => `${key} to ${desired[key]}`).join(" and ")} as much as possible.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function starterPackStates(character: Character): CharacterState[] {
  const base = { characterId: character.id, ...DEFAULT_CHARACTER_STATE };
  return [
    base,
    { ...base, pose: "walking" },
    { ...base, pose: "running" },
    { ...base, pose: "sitting" },
    { ...base, pose: "jumping" },
    { ...base, pose: "pointing" },
    { ...base, pose: "arms crossed" },
    { ...base, pose: "looking back" },
    { ...base, expression: "smile" },
    { ...base, expression: "laugh" },
    { ...base, expression: "angry" },
    { ...base, expression: "crying" },
    { ...base, expression: "shocked" },
    { ...base, expression: "embarrassed" },
    { ...base, expression: "worried" },
  ];
}
