/**
 * Semantic asset resolution: the agent addresses assets by meaning
 * ("Akari, running, crying"), the resolver maps that onto real library
 * assets using slot metadata — never filenames. Every explicitly requested
 * dimension must match. Unspecified dimensions prefer neutral/default values
 * so "walking" does not unpredictably select a specialized angry/crying slot.
 */

import { DEFAULT_CHARACTER_STATE, stateFromAsset } from "@/characters/state";
import type { AssetCategory, Character, CharacterState, ProjectDocument, SourceAsset } from "@/domain/types";

export function findCharacter(doc: ProjectDocument, name: string): Character | null {
  const wanted = name.trim().toLowerCase();
  const characters = Object.values(doc.characters);
  return (
    characters.find((c) => c.id === name) ??
    characters.find((c) => c.name.toLowerCase() === wanted) ??
    characters.find((c) => c.name.toLowerCase().includes(wanted) || wanted.includes(c.name.toLowerCase())) ??
    null
  );
}

export interface CharacterAssetQuery {
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
}

export function resolveCharacterAsset(
  doc: ProjectDocument,
  character: Character,
  query: CharacterAssetQuery,
): SourceAsset | null {
  const assets = characterAssets(doc, character);
  if (assets.length === 0) return null;

  if (query.pose || query.expression || query.outfit || query.view) {
    const requested = Object.entries(query).filter((entry): entry is [keyof CharacterAssetQuery, string] => Boolean(entry[1]));
    return (
      assets
        .filter((asset) => asset.metadata?.characterAssetRole !== "canonical")
        .map((asset) => {
          const state = stateFromAsset(asset, character.id);
          if (!state || !requested.every(([key, value]) => state[key] === value.trim().toLowerCase())) return null;
          const defaultScore =
            Number(state.pose === DEFAULT_CHARACTER_STATE.pose) +
            Number(state.expression === DEFAULT_CHARACTER_STATE.expression) +
            Number(state.outfit === DEFAULT_CHARACTER_STATE.outfit) +
            Number(state.view === DEFAULT_CHARACTER_STATE.view);
          return { asset, defaultScore };
        })
        .filter((entry): entry is { asset: SourceAsset; defaultScore: number } => Boolean(entry))
        .sort((a, b) => b.defaultScore - a.defaultScore || b.asset.createdAt.localeCompare(a.asset.createdAt))[0]?.asset ?? null
    );
  }

  // No slot matched — fall back to the identity reference, then anything.
  const referenceId = character.canonicalReferenceAssetId ?? character.referenceAssetId;
  const reference = referenceId ? doc.assets[referenceId] : undefined;
  return reference ?? assets[assets.length - 1];
}

function characterAssets(doc: ProjectDocument, character: Character): SourceAsset[] {
  const ids = new Set(character.assetIds);
  for (const asset of Object.values(doc.assets)) {
    if (asset.metadata?.characterId === character.id) ids.add(asset.id);
  }
  return [...ids].map((id) => doc.assets[id]).filter((asset): asset is SourceAsset => Boolean(asset));
}

export function requestedCharacterState(characterId: string, query: CharacterAssetQuery): CharacterState {
  return {
    characterId,
    pose: query.pose?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.pose,
    expression: query.expression?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.expression,
    outfit: query.outfit?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.outfit,
    view: query.view?.trim().toLowerCase() || DEFAULT_CHARACTER_STATE.view,
  };
}

export type CharacterStateResolution =
  | { status: "character-not-found"; character: null; asset: null; desired: null }
  | { status: "cached" | "missing-state"; character: Character; asset: SourceAsset | null; desired: CharacterState };

/** Typed semantic lookup used by agent placement; display names are never asset identity. */
export function resolveCharacterState(
  doc: ProjectDocument,
  characterNameOrId: string,
  query: CharacterAssetQuery,
): CharacterStateResolution {
  const character = findCharacter(doc, characterNameOrId);
  if (!character) return { status: "character-not-found", character: null, asset: null, desired: null };
  const asset = resolveCharacterAsset(doc, character, query);
  return {
    status: asset ? "cached" : "missing-state",
    character,
    asset,
    desired: requestedCharacterState(character.id, query),
  };
}

export interface LibraryAssetQuery {
  assetName?: string;
  category?: AssetCategory;
}

export function resolveLibraryAsset(doc: ProjectDocument, query: LibraryAssetQuery): SourceAsset | null {
  let candidates = Object.values(doc.assets);
  if (query.category) candidates = candidates.filter((a) => a.category === query.category);
  if (candidates.length === 0) return null;

  if (query.assetName) {
    const wanted = query.assetName.toLowerCase();
    const byName =
      candidates.find((a) => a.name.toLowerCase() === wanted) ??
      candidates.find((a) => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase())) ??
      candidates.find((a) => a.metadata?.prompt?.toLowerCase().includes(wanted));
    if (byName) return byName;
    // A named request that matches nothing should fail rather than grab a
    // random asset — unless the category alone was the point.
    if (!query.category) return null;
  }
  // Latest asset of the category (most recently generated wins).
  return candidates[candidates.length - 1];
}
