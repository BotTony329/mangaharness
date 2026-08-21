import type {
  AssetInstance,
  Character,
  CharacterState,
  ID,
  ProjectDocument,
  SourceAsset,
} from "@/domain/types";
import { DEFAULT_STYLE_PROFILE_ID } from "@/styles/profiles";
import { isAssetReadyForComposition } from "@/assets/renderSource";
import { normalizeProps, sameProps } from "./stateGraph";
import { poseRigKey } from "./poseRig";
import { characterIdOfInstance } from "./identity";

export const DEFAULT_CHARACTER_STATE = {
  pose: "standing",
  expression: "neutral",
  outfit: "default outfit",
  view: "front",
} as const;

export type CharacterStatePatch = Partial<
  Pick<CharacterState, "pose" | "expression" | "outfit" | "view" | "props" | "poseRig">
>;

export function normalizeStateValue(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase() || fallback;
}

export function stateFromAsset(asset: SourceAsset, characterId?: ID): CharacterState | null {
  const id = characterId ?? asset.metadata?.characterId;
  if (!id) return null;
  // Every dimension the render declares must be read back, or swapping an
  // instance to this asset would silently drop the ones we forgot — which is
  // exactly how props and an authored pose went missing after a swap.
  const props = normalizeProps(asset.provenance?.characterState?.props ?? asset.metadata?.props);
  return {
    characterId: id,
    pose: normalizeStateValue(asset.metadata?.pose, DEFAULT_CHARACTER_STATE.pose),
    expression: normalizeStateValue(asset.metadata?.expression, DEFAULT_CHARACTER_STATE.expression),
    outfit: normalizeStateValue(asset.metadata?.outfit, DEFAULT_CHARACTER_STATE.outfit),
    view: normalizeStateValue(asset.metadata?.view, DEFAULT_CHARACTER_STATE.view),
    props: props.length > 0 ? props : undefined,
    poseRig: asset.metadata?.poseRig,
    assetId: asset.id,
  };
}

export function stateFromInstance(doc: ProjectDocument, instance: AssetInstance): CharacterState | null {
  const asset = doc.assets[instance.sourceAssetId];
  /**
   * Resolve identity through every link before giving up.
   *
   * Reading only the instance's stored state and the asset's metadata meant a
   * character whose identity survived on the reverse link alone had no state at
   * all — the Inspector showed the tabs but the Pose, Expression, Outfit and
   * View controls silently vanished, which is a worse failure than showing
   * nothing because it looks like the character simply has no states.
   */
  const resolvedId = characterIdOfInstance(doc, instance);
  const fallback = asset ? stateFromAsset(asset, resolvedId) : null;
  const stored = instance.characterState;
  if (!stored && !fallback) return null;
  const characterId = stored?.characterId ?? fallback!.characterId;
  return {
    characterId,
    pose: normalizeStateValue(stored?.pose ?? fallback?.pose, DEFAULT_CHARACTER_STATE.pose),
    expression: normalizeStateValue(stored?.expression ?? fallback?.expression, DEFAULT_CHARACTER_STATE.expression),
    outfit: normalizeStateValue(stored?.outfit ?? fallback?.outfit, DEFAULT_CHARACTER_STATE.outfit),
    view: normalizeStateValue(stored?.view ?? fallback?.view, DEFAULT_CHARACTER_STATE.view),
    props: stored?.props,
    poseRig: stored?.poseRig,
    assetId: instance.sourceAssetId,
  };
}

export function mergeCharacterState(current: CharacterState, patch: CharacterStatePatch): CharacterState {
  const props = normalizeProps(patch.props ?? current.props);
  const pose = normalizeStateValue(patch.pose, current.pose);
  // Switching preset discards an authored edit built on the old preset: a
  // preset is a starting pose (§8), and "walking, arm raised" says nothing
  // about where the arm should be while running.
  const poseRig =
    patch.poseRig !== undefined
      ? patch.poseRig
      : patch.pose !== undefined && pose !== current.pose
        ? undefined
        : current.poseRig;
  return {
    ...current,
    pose,
    expression: normalizeStateValue(patch.expression, current.expression),
    outfit: normalizeStateValue(patch.outfit, current.outfit),
    view: normalizeStateValue(patch.view, current.view),
    props: props.length > 0 ? props : undefined,
    poseRig,
    assetId: undefined,
    stateId: undefined,
  };
}

export function sameCharacterState(a: CharacterState, b: CharacterState): boolean {
  return (
    a.characterId === b.characterId &&
    a.pose === b.pose &&
    a.expression === b.expression &&
    a.outfit === b.outfit &&
    a.view === b.view &&
    sameProps(a.props, b.props) &&
    poseRigKey(a.poseRig) === poseRigKey(b.poseRig)
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
    .filter((asset): asset is SourceAsset => Boolean(asset) && isAssetReadyForComposition(asset))
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

/** The string-valued dimensions. `props` is a list and is handled separately. */
export type CharacterStateValueKey = "pose" | "expression" | "outfit" | "view";

export function availableCharacterStateValues(
  doc: ProjectDocument,
  character: Character,
  key: CharacterStateValueKey,
): string[] {
  const defaults: Record<CharacterStateValueKey, string[]> = {
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
