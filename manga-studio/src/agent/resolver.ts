/**
 * Semantic asset resolution: the agent addresses assets by meaning
 * ("Akari, running, crying"), the resolver maps that onto real library
 * assets using slot metadata — never filenames. Exact slot matches win;
 * compatible near-matches are acceptable (a running-neutral asset can serve
 * a running-crying request rather than forcing a regeneration).
 */

import type { AssetCategory, Character, ProjectDocument, SourceAsset } from "@/domain/types";

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
}

export function resolveCharacterAsset(
  doc: ProjectDocument,
  character: Character,
  query: CharacterAssetQuery,
): SourceAsset | null {
  const assets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean) as SourceAsset[];
  if (assets.length === 0) return null;

  const scored = assets
    .map((asset) => ({ asset, score: slotScore(asset, query) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > 0) return scored[0].asset;

  // No slot matched — fall back to the identity reference, then anything.
  const reference = character.referenceAssetId ? doc.assets[character.referenceAssetId] : undefined;
  return reference ?? assets[assets.length - 1];
}

function slotScore(asset: SourceAsset, query: CharacterAssetQuery): number {
  let score = 0;
  // Expression outweighs pose: when only one can match, the emotional read
  // of a panel depends on the face more than the body (crop can hide a pose,
  // it can't change an expression).
  score += fieldScore(asset.metadata?.pose, query.pose) * 2;
  score += fieldScore(asset.metadata?.expression, query.expression) * 3;
  return score;
}

function fieldScore(actual: string | undefined, wanted: string | undefined): number {
  if (!wanted) return 0;
  if (!actual) return 0;
  const a = actual.toLowerCase();
  const w = wanted.toLowerCase();
  if (a === w) return 2;
  if (a.includes(w) || w.includes(a)) return 1;
  return 0;
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
