"use client";

import { callGenerateApi, storeGeneratedAsset } from "@/ai/clientGeneration";
import { buildAssetPrompt, buildCharacterStatePrompt } from "@/ai/promptTemplates";
import type { Character, CharacterState, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import {
  DEFAULT_CHARACTER_STATE,
  characterReferenceId,
  characterIdentityDescription,
  mergeCharacterState,
  stateFromInstance,
  type CharacterStatePatch,
} from "./state";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import { resolveCharacterState, type ResolveOptions } from "./stateResolver";
import { describePoseRig } from "./poseRig";
import { assetRenderUrl, isAssetReadyForComposition } from "@/assets/renderSource";

export type CharacterGenerationRole = "canonical" | "state";

export interface CharacterGenerationProgress {
  stage: "resolving" | "generating" | "saving" | "complete";
  state: CharacterState;
}

interface ImageProviderCapabilities {
  referenceImage: boolean;
  nativeTransparency: boolean;
}

/**
 * Capabilities decide how the prompt asks for an isolated subject. Defaulting
 * `nativeTransparency` to false is the safe direction: it asks for a keyable
 * flat colour field, which every provider can render, instead of asking an
 * opaque model for alpha it cannot produce.
 */
async function imageProviderCapabilities(): Promise<ImageProviderCapabilities> {
  try {
    const status = await fetch("/api/provider/status").then((response) => response.json());
    return {
      referenceImage: Boolean(status?.capabilities?.referenceImage),
      nativeTransparency: Boolean(status?.capabilities?.supportsTransparentBackground),
    };
  } catch {
    return { referenceImage: false, nativeTransparency: false };
  }
}

export async function generateCharacterAssetForState(input: {
  characterId: ID;
  state: CharacterState;
  role?: CharacterGenerationRole;
  instruction?: string;
  continuityFrom?: CharacterState;
  changedDimensions?: (keyof CharacterStatePatch)[];
  /** Explicit reference chosen in the selector; omit to use the resolver's pick. */
  referenceOverride?: ResolveOptions["referenceOverride"];
}): Promise<ID> {
  const doc = useEditorStore.getState().doc;
  const character = doc?.characters[input.characterId];
  if (!doc || !character) throw new Error("Character no longer exists");

  const role = input.role ?? "state";
  const style = getStyleGenerationContext(doc);
  const canonicalId = characterReferenceId(character);
  const canonicalCandidate = canonicalId ? doc.assets[canonicalId] : undefined;
  const canonical = isAssetReadyForComposition(canonicalCandidate) ? canonicalCandidate : undefined;
  const capabilities = await imageProviderCapabilities();
  const supportsReference = capabilities.referenceImage;

  // The resolver names the identity anchor; this function does not re-derive
  // it. Whatever the selector shows is what actually reaches the provider (§3).
  const resolution =
    role === "state"
      ? resolveCharacterState(doc, input.state, {
          forceRegenerate: true,
          referenceOverride: input.referenceOverride,
        })
      : undefined;
  const chosen = resolution?.status === "needs-generation" ? resolution.reference : undefined;
  const chosenAsset = chosen?.assetId ? doc.assets[chosen.assetId] : undefined;
  const chosenUsable = isAssetReadyForComposition(chosenAsset) ? chosenAsset : undefined;

  const useIdentityReference = role === "state" && Boolean(chosenUsable ?? canonical) && supportsReference;
  const referenceAssets = supportsReference
    ? [
        // Chosen reference first: providers weight earlier images more heavily.
        role === "state" ? chosenUsable : undefined,
        // Canonical always accompanies a derived reference so identity cannot
        // drift further with each generation down a lineage chain.
        role === "state" && chosenUsable?.id !== canonical?.id ? canonical : undefined,
        role === "canonical" ? undefined : style.referenceAsset,
      ].filter((asset, index, list) => Boolean(asset) && list.findIndex((candidate) => candidate?.id === asset?.id) === index)
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
          supportsNativeTransparency: capabilities.nativeTransparency,
          monochrome: isMonochromeStyle(style.profile),
        })
      : buildCharacterStatePrompt({
          characterName: character.name,
          characterDescription: characterIdentityDescription(character),
          ...input.state,
          pose: describePoseRig(input.state.poseRig, input.state.pose),
          description: [continuity, input.instruction].filter(Boolean).join(" ") || undefined,
          hasReference: useIdentityReference,
          style: style.profile,
          supportsNativeTransparency: capabilities.nativeTransparency,
          monochrome: isMonochromeStyle(style.profile),
        });

  const result = await callGenerateApi({
    assetType,
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "portrait",
    expectMonochrome: isMonochromeStyle(style.profile),
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
      // Lineage: which node this render descends from, and what changed.
      parentStateId: resolution?.status === "needs-generation" ? resolution.parentStateId : undefined,
      stateDelta: resolution?.status === "needs-generation" ? resolution.delta : undefined,
      props: input.state.props,
      poseRig: input.state.poseRig,
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
  referenceOverride?: ResolveOptions["referenceOverride"];
  onProgress?: (progress: CharacterGenerationProgress) => void;
}): Promise<{
  assetId: ID;
  state: CharacterState;
  source: "cache" | "generated";
  previousAssetId: ID;
  previousState: CharacterState;
  /** What anchored the generation, so the UI can report it honestly. */
  reference?: { kind: string; label: string; assetId?: ID };
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

  // One resolver for cache-or-generate, shared with the Agent and the kit UI.
  const resolution = resolveCharacterState(initialDoc, desired, {
    forceRegenerate: input.forceRegenerate,
    referenceOverride: input.referenceOverride,
  });
  let assetId: ID;
  let source: "cache" | "generated";
  let reference: { kind: string; label: string; assetId?: ID } | undefined;
  if (resolution.status === "cached") {
    assetId = resolution.assetId;
    source = "cache";
  } else {
    if (resolution.status === "character-not-found") throw new Error("Character no longer exists");
    reference = { kind: resolution.reference.kind, label: resolution.reference.label, assetId: resolution.reference.assetId };
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
      referenceOverride: input.referenceOverride,
    });
    source = "generated";
    input.onProgress?.({ stage: "saving", state: desired });
  }

  useEditorStore.getState().dispatch({ type: "swap-instance-asset", instanceId: input.instanceId, assetId });
  input.onProgress?.({ stage: "complete", state: { ...desired, assetId } });
  return {
    assetId,
    state: { ...desired, assetId },
    source,
    previousAssetId: instance.sourceAssetId,
    previousState: current,
    reference,
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
