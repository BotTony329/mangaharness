import type {
  AssetInstance,
  Character,
  CharacterState,
  ID,
  ProjectDocument,
  SourceAsset,
} from "@/domain/types";
import { DEFAULT_STYLE_PROFILE_ID } from "@/styles/profiles";

export const DEFAULT_CHARACTER_STATE = {
  pose: "standing",
  expression: "neutral",
  outfit: "default outfit",
  view: "front",
} as const;

export type CharacterStatePatch = Partial<Pick<CharacterState, "pose" | "expression" | "outfit" | "view">>;

export function normalizeStateValue(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase() || fallback;
}

export function stateFromAsset(asset: SourceAsset, characterId?: ID): CharacterState | null {
  const id = characterId ?? asset.metadata?.characterId;
  if (!id) return null;
  return {
    characterId: id,
    pose: normalizeStateValue(asset.metadata?.pose, DEFAULT_CHARACTER_STATE.pose),
    expression: normalizeStateValue(asset.metadata?.expression, DEFAULT_CHARACTER_STATE.expression),
    outfit: normalizeStateValue(asset.metadata?.outfit, DEFAULT_CHARACTER_STATE.outfit),
    view: normalizeStateValue(asset.metadata?.view, DEFAULT_CHARACTER_STATE.view),
    assetId: asset.id,
  };
}

export function stateFromInstance(doc: ProjectDocument, instance: AssetInstance): CharacterState | null {
  const asset = doc.assets[instance.sourceAssetId];
  const fallback = asset ? stateFromAsset(asset) : null;
  const stored = instance.characterState;
  if (!stored && !fallback) return null;
  const characterId = stored?.characterId ?? fallback!.characterId;
  return {
    characterId,
    pose: normalizeStateValue(stored?.pose ?? fallback?.pose, DEFAULT_CHARACTER_STATE.pose),
    expression: normalizeStateValue(stored?.expression ?? fallback?.expression, DEFAULT_CHARACTER_STATE.expression),
    outfit: normalizeStateValue(stored?.outfit ?? fallback?.outfit, DEFAULT_CHARACTER_STATE.outfit),
    view: normalizeStateValue(stored?.view ?? fallback?.view, DEFAULT_CHARACTER_STATE.view),
    assetId: instance.sourceAssetId,
  };
}

export function mergeCharacterState(current: CharacterState, patch: CharacterStatePatch): CharacterState {
  return {
    ...current,
    pose: normalizeStateValue(patch.pose, current.pose),
    expression: normalizeStateValue(patch.expression, current.expression),
    outfit: normalizeStateValue(patch.outfit, current.outfit),
    view: normalizeStateValue(patch.view, current.view),
    assetId: undefined,
  };
}

export function sameCharacterState(a: CharacterState, b: CharacterState): boolean {
  return (
    a.characterId === b.characterId &&
    a.pose === b.pose &&
    a.expression === b.expression &&
    a.outfit === b.outfit &&
    a.view === b.view
  );
}

export function characterReferenceId(character: Character): ID | undefined {
  return character.canonicalReferenceAssetId ?? character.referenceAssetId;
}

export function characterIdentityDescription(character: Character): string | undefined {
  const appearance = character.appearance ?? character.description;
  const parts = [
    appearance ? `Appearance: ${appearance}` : "",
    character.personalityNotes ? `Personality and visual identity: ${character.personalityNotes}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

function selectableCharacterAssets(doc: ProjectDocument, character: Character): SourceAsset[] {
  return character.assetIds
    .map((id) => doc.assets[id])
    .filter((asset): asset is SourceAsset => Boolean(asset) && asset.status !== "archived")
    .filter((asset) => asset.metadata?.characterAssetRole !== "canonical");
}

/** Exact full-state cache lookup. Partial matches are never presented as the requested state. */
export function findExactCharacterAsset(
  doc: ProjectDocument,
  character: Character,
  desired: CharacterState,
  excludeAssetId?: ID,
): SourceAsset | undefined {
  return selectableCharacterAssets(doc, character)
    .filter((asset) => asset.id !== excludeAssetId)
    .filter(
      (asset) =>
        (asset.metadata?.styleProfileId ?? DEFAULT_STYLE_PROFILE_ID) ===
        doc.project.settings.artStyle.activeStyleId,
    )
    .filter((asset) => {
      const state = stateFromAsset(asset, character.id);
      return Boolean(state && sameCharacterState(state, desired));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Best cached render for generation guidance only; it is never a semantic substitute. */
export function findCompatibleCharacterAsset(
  doc: ProjectDocument,
  character: Character,
  desired: CharacterState,
): SourceAsset | undefined {
  return selectableCharacterAssets(doc, character)
    .map((asset) => {
      const state = stateFromAsset(asset, character.id)!;
      const score =
        Number(state.pose === desired.pose) * 4 +
        Number(state.expression === desired.expression) * 4 +
        Number(state.outfit === desired.outfit) * 2 +
        Number(state.view === desired.view) * 2;
      return { asset, score };
    })
    .sort((a, b) => b.score - a.score || b.asset.createdAt.localeCompare(a.asset.createdAt))[0]?.asset;
}

export function availableCharacterStateValues(
  doc: ProjectDocument,
  character: Character,
  key: keyof CharacterStatePatch,
): string[] {
  const defaults: Record<keyof CharacterStatePatch, string[]> = {
    pose: ["standing", "walking", "running", "sitting", "jumping", "pointing", "arms crossed", "looking back"],
    expression: ["neutral", "smile", "laugh", "angry", "crying", "shocked", "embarrassed", "worried"],
    outfit: [DEFAULT_CHARACTER_STATE.outfit, "casual outfit", "school uniform", "formal outfit", "battle outfit"],
    view: ["front", "three-quarter", "side", "back"],
  };
  const values = new Set(defaults[key]);
  for (const assetId of character.assetIds) {
    const asset = doc.assets[assetId];
    if (!asset || asset.status === "archived") continue;
    const state = stateFromAsset(asset, character.id);
    if (state) values.add(state[key]);
  }
  return [...values];
}
