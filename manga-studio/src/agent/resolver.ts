/**
 * Semantic asset resolution: the agent addresses assets by meaning
 * ("Akari, running, crying"), the resolver maps that onto real library
 * assets using slot metadata — never filenames. Exact slot matches win;
 * compatible near-matches are acceptable (a running-neutral asset can serve
 * a running-crying request rather than forcing a regeneration).
 */

import { DEFAULT_CHARACTER_STATE, findExactCharacterAsset } from "@/characters/state";
import type { AssetCategory, Character, CharacterState, ProjectDocument, SourceAsset } from "@/domain/types";

export function findCharacter(doc: ProjectDocument, name: string): Character | null {
  const wanted = name.trim().toLowerCase();
  const characters = Object.values(doc.characters);
  return (
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
  const assets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean) as SourceAsset[];
  if (assets.length === 0) return null;

  if (query.pose || query.expression || query.outfit || query.view) {
    const desired: CharacterState = {
      characterId: character.id,
      pose: query.pose?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.pose,
      expression: query.expression?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.expression,
      outfit: query.outfit?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.outfit,
      view: query.view?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.view,
    };
    const exact = findExactCharacterAsset(doc, character, desired);
    if (exact) return exact;
    return null;
  }

  // No slot matched — fall back to the identity reference, then anything.
  const referenceId = character.canonicalReferenceAssetId ?? character.referenceAssetId;
  const reference = referenceId ? doc.assets[referenceId] : undefined;
  return reference ?? assets[assets.length - 1];
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
