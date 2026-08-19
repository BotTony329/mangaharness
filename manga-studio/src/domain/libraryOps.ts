/** Mutations for source assets, characters, and generation history. */

import { cloneDoc, touch } from "./docHelpers";
import { newId, now } from "./factory";
import type {
  AssetCategory,
  AssetGenerationMetadata,
  Character,
  GenerationRecord,
  ID,
  ProjectDocument,
  SourceAsset,
} from "./types";

export interface NewAssetInput {
  category: AssetCategory;
  name: string;
  storageUrl: string;
  width: number;
  height: number;
  mimeType?: string;
  hasAlpha?: boolean;
  metadata?: AssetGenerationMetadata;
}

export function addAsset(doc: ProjectDocument, input: NewAssetInput): { doc: ProjectDocument; assetId: ID } {
  const next = cloneDoc(doc);
  const asset: SourceAsset = {
    id: newId(),
    projectId: next.project.id,
    createdAt: now(),
    ...input,
  };
  next.assets[asset.id] = asset;
  // Character-tagged assets also join their character's library.
  const characterId = input.metadata?.characterId;
  if (characterId && next.characters[characterId]) {
    next.characters[characterId].assetIds.push(asset.id);
    if (!next.characters[characterId].referenceAssetId) {
      next.characters[characterId].referenceAssetId = asset.id;
    }
  }
  touch(next);
  return { doc: next, assetId: asset.id };
}

/**
 * Removing a source asset removes every instance of it — the only case where
 * library changes cascade into panels. The inverse never happens.
 */
export function removeAsset(doc: ProjectDocument, assetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  delete next.assets[assetId];
  for (const character of Object.values(next.characters)) {
    character.assetIds = character.assetIds.filter((id) => id !== assetId);
    if (character.referenceAssetId === assetId) character.referenceAssetId = character.assetIds[0];
  }
  const orphaned = Object.values(next.items).filter(
    (item) => item.kind === "asset" && item.sourceAssetId === assetId,
  );
  for (const item of orphaned) {
    delete next.items[item.id];
    const panel = next.panels[item.panelId];
    if (panel) panel.itemIds = panel.itemIds.filter((id) => id !== item.id);
  }
  touch(next);
  return next;
}

export function addCharacter(
  doc: ProjectDocument,
  name: string,
  description?: string,
): { doc: ProjectDocument; characterId: ID } {
  const next = cloneDoc(doc);
  const character: Character = {
    id: newId(),
    projectId: next.project.id,
    name,
    description,
    assetIds: [],
    createdAt: now(),
  };
  next.characters[character.id] = character;
  touch(next);
  return { doc: next, characterId: character.id };
}

export function setCharacterReference(doc: ProjectDocument, characterId: ID, assetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const character = next.characters[characterId];
  if (!character) throw new Error(`Unknown character: ${characterId}`);
  if (!next.assets[assetId]) throw new Error(`Unknown asset: ${assetId}`);
  character.referenceAssetId = assetId;
  touch(next);
  return next;
}

export function addGenerationRecord(doc: ProjectDocument, record: Omit<GenerationRecord, "id" | "createdAt">): ProjectDocument {
  const next = cloneDoc(doc);
  next.generationHistory.push({ id: newId(), createdAt: now(), ...record });
  touch(next);
  return next;
}
