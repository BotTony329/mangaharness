import { cloneDoc, touch } from "./docHelpers";
import { pruneCharacterStates } from "./characterStateOps";
import { syncPanelScene } from "./sceneOps";
import { stateFromAsset } from "@/characters/state";
import type { ID, ProjectDocument, SourceAsset } from "./types";

export type AssetUsageKind =
  | "character-reference"
  | "character-state"
  | "panel-instance"
  | "workspace-instance"
  | "generation-history"
  | "scene-background"
  | "style-reference"
  | "asset-provenance";

export interface AssetUsage {
  kind: AssetUsageKind;
  id: ID;
  label: string;
}

export type DeleteAssetMode = "if-unused" | "archive" | "cascade";
export type DeleteCharacterMode = "keep-assets" | "delete-unused-assets" | "delete-all";

export class AssetInUseError extends Error {
  constructor(readonly asset: SourceAsset, readonly usages: AssetUsage[]) {
    super(`Asset "${asset.name}" is used in ${usages.length} place${usages.length === 1 ? "" : "s"}`);
  }
}

export function inspectAssetUsage(doc: ProjectDocument, assetId: ID): AssetUsage[] {
  const usages: AssetUsage[] = [];
  for (const character of Object.values(doc.characters)) {
    if (character.canonicalReferenceAssetId === assetId || character.referenceAssetId === assetId) {
      usages.push({ kind: "character-reference", id: character.id, label: `${character.name} · Canonical reference` });
    } else if (character.assetIds.includes(assetId)) {
      const asset = doc.assets[assetId];
      const state = asset?.metadata;
      usages.push({
        kind: "character-state",
        id: character.id,
        label: `${character.name} · ${[state?.pose, state?.expression].filter(Boolean).join(" + ") || "Visual state"}`,
      });
    }
  }
  for (const item of Object.values(doc.items)) {
    if (item.kind !== "asset" || item.sourceAssetId !== assetId) continue;
    const panel = doc.panels[item.panelId];
    const page = panel ? doc.pages[panel.pageId] : undefined;
    const panelNumber = page ? page.panelIds.indexOf(item.panelId) + 1 : 0;
    usages.push({
      kind: "panel-instance",
      id: item.id,
      label: `${page?.name ?? "Unknown page"} · Panel ${panelNumber || "?"}`,
    });
  }
  for (const item of Object.values(doc.workspaceItems)) {
    if (item.sourceAssetId === assetId) usages.push({ kind: "workspace-instance", id: item.id, label: "Loose workspace item" });
  }
  for (const record of doc.generationHistory) {
    if (record.resultAssetId === assetId) usages.push({ kind: "generation-history", id: record.id, label: "Generation history" });
  }
  for (const scene of Object.values(doc.scenes)) {
    if (scene.backgroundAssetId !== assetId) continue;
    const panel = doc.panels[scene.panelId];
    const page = panel ? doc.pages[panel.pageId] : undefined;
    usages.push({ kind: "scene-background", id: scene.panelId, label: `${page?.name ?? "Scene"} · Background` });
  }
  for (const profile of Object.values(doc.project.settings.artStyle.customProfiles)) {
    if (profile.referenceAssetId === assetId) usages.push({ kind: "style-reference", id: profile.id, label: `${profile.name} · Style reference` });
  }
  for (const dependent of Object.values(doc.assets)) {
    const references = new Set([
      ...(dependent.metadata?.referenceAssetIds ?? []),
      ...(dependent.provenance?.generatedFromAssetIds ?? []),
    ]);
    if (references.has(assetId)) usages.push({ kind: "asset-provenance", id: dependent.id, label: `${dependent.name} · Generation provenance` });
  }
  return usages;
}

export function deleteAsset(doc: ProjectDocument, assetId: ID, mode: DeleteAssetMode): ProjectDocument {
  const asset = doc.assets[assetId];
  if (!asset) return doc;
  const usages = inspectAssetUsage(doc, assetId);
  if (mode === "if-unused" && usages.length > 0) throw new AssetInUseError(asset, usages);
  if (mode === "archive") return setAssetArchived(doc, assetId, true);

  const next = cloneDoc(doc);
  for (const character of Object.values(next.characters)) detachAssetFromCharacterMutable(next, character.id, assetId);

  const affectedPanels = new Set<ID>();
  for (const item of Object.values(next.items)) {
    if (item.kind !== "asset" || item.sourceAssetId !== assetId) continue;
    affectedPanels.add(item.panelId);
    delete next.items[item.id];
    const panel = next.panels[item.panelId];
    if (panel) panel.itemIds = panel.itemIds.filter((id) => id !== item.id);
  }
  for (const item of Object.values(next.workspaceItems)) {
    if (item.sourceAssetId === assetId) delete next.workspaceItems[item.id];
  }
  next.workspaceOrder = next.workspaceOrder.filter((id) => Boolean(next.workspaceItems[id]));
  for (const record of next.generationHistory) {
    if (record.resultAssetId === assetId) delete record.resultAssetId;
  }
  for (const profile of Object.values(next.project.settings.artStyle.customProfiles)) {
    if (profile.referenceAssetId === assetId) delete profile.referenceAssetId;
  }
  for (const dependent of Object.values(next.assets)) {
    if (dependent.metadata?.referenceAssetIds) dependent.metadata.referenceAssetIds = dependent.metadata.referenceAssetIds.filter((id) => id !== assetId);
    if (dependent.provenance?.generatedFromAssetIds) dependent.provenance.generatedFromAssetIds = dependent.provenance.generatedFromAssetIds.filter((id) => id !== assetId);
  }
  delete next.assets[assetId];
  for (const panelId of affectedPanels) syncPanelScene(next, panelId);
  pruneCharacterStates(next);
  touch(next);
  return next;
}

export function setAssetArchived(doc: ProjectDocument, assetId: ID, archived: boolean): ProjectDocument {
  const next = cloneDoc(doc);
  const asset = next.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);
  asset.status = archived ? "archived" : "ready";
  asset.updatedAt = new Date().toISOString();
  touch(next);
  return next;
}

export function renameAsset(doc: ProjectDocument, assetId: ID, name: string): ProjectDocument {
  const next = cloneDoc(doc);
  const asset = next.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);
  const normalized = name.trim();
  if (!normalized) throw new Error("Asset name cannot be empty");
  asset.name = normalized;
  asset.updatedAt = new Date().toISOString();
  touch(next);
  return next;
}

export function renameCharacter(doc: ProjectDocument, characterId: ID, name: string): ProjectDocument {
  const next = cloneDoc(doc);
  const character = next.characters[characterId];
  if (!character) throw new Error(`Unknown Character: ${characterId}`);
  const normalized = name.trim();
  if (!normalized) throw new Error("Character name cannot be empty");
  character.name = normalized;
  character.updatedAt = new Date().toISOString();
  touch(next);
  return next;
}

export function detachCharacterVisual(doc: ProjectDocument, characterId: ID, assetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  detachAssetFromCharacterMutable(next, characterId, assetId);
  for (const item of Object.values(next.items)) {
    if (item.kind !== "asset" || item.sourceAssetId !== assetId) continue;
    delete item.characterState;
    syncPanelScene(next, item.panelId);
  }
  touch(next);
  return next;
}

export function deleteCharacter(doc: ProjectDocument, characterId: ID, mode: DeleteCharacterMode): ProjectDocument {
  const character = doc.characters[characterId];
  if (!character) return doc;
  let next = cloneDoc(doc);
  const assetIds = [...character.assetIds];
  if (mode === "delete-all") {
    // Remove the entity first so its own membership does not block deletion.
    delete next.characters[characterId];
    for (const assetId of assetIds) next = deleteAsset(next, assetId, "cascade");
  } else {
    for (const assetId of assetIds) next = detachCharacterVisual(next, characterId, assetId);
    delete next.characters[characterId];
    if (mode === "delete-unused-assets") {
      for (const assetId of assetIds) {
        if (next.assets[assetId] && inspectAssetUsage(next, assetId).length === 0) next = deleteAsset(next, assetId, "if-unused");
      }
    }
  }
  for (const item of Object.values(next.items)) {
    if (item.kind === "asset" && item.characterState?.characterId === characterId) delete item.characterState;
  }
  for (const panelId of Object.keys(next.panels)) syncPanelScene(next, panelId);
  pruneCharacterStates(next);
  touch(next);
  return next;
}

export function replaceAssetReferences(doc: ProjectDocument, oldAssetId: ID, newAssetId: ID): ProjectDocument {
  if (!doc.assets[oldAssetId] || !doc.assets[newAssetId]) throw new Error("Replacement asset not found");
  const next = cloneDoc(doc);
  for (const item of Object.values(next.items)) {
    if (item.kind === "asset" && item.sourceAssetId === oldAssetId) {
      item.sourceAssetId = newAssetId;
      const state = stateFromAsset(next.assets[newAssetId]);
      if (state) item.characterState = state;
      else delete item.characterState;
    }
  }
  for (const item of Object.values(next.workspaceItems)) {
    if (item.sourceAssetId === oldAssetId) item.sourceAssetId = newAssetId;
  }
  for (const character of Object.values(next.characters)) {
    const owned = character.assetIds.includes(oldAssetId);
    character.assetIds = character.assetIds.map((id) => id === oldAssetId ? newAssetId : id).filter((id, index, ids) => ids.indexOf(id) === index);
    if (character.referenceAssetId === oldAssetId) character.referenceAssetId = newAssetId;
    if (character.canonicalReferenceAssetId === oldAssetId) character.canonicalReferenceAssetId = newAssetId;

    /**
     * Carry the identity onto the replacement.
     *
     * The character's asset list was being repointed at an asset whose own
     * metadata said nothing about that character, which left the identity
     * surviving on the reverse link alone. Anything reading the forward link
     * then saw an anonymous image — that is how a character on the canvas lost
     * its State, Interactions and Details tabs.
     */
    const replacement = next.assets[newAssetId];
    if (owned && replacement && !replacement.metadata?.characterId) {
      replacement.metadata = { ...replacement.metadata, characterId: character.id };
    }
  }

  /**
   * Re-derive instance state AFTER the metadata repair above, so an instance
   * whose asset just regained its identity regains its character state too.
   */
  for (const item of Object.values(next.items)) {
    if (item.kind !== "asset" || item.sourceAssetId !== newAssetId || item.characterState) continue;
    const state = stateFromAsset(next.assets[newAssetId]);
    if (state) item.characterState = state;
  }
  for (const record of next.generationHistory) if (record.resultAssetId === oldAssetId) record.resultAssetId = newAssetId;
  for (const profile of Object.values(next.project.settings.artStyle.customProfiles)) {
    if (profile.referenceAssetId === oldAssetId) profile.referenceAssetId = newAssetId;
  }
  for (const dependent of Object.values(next.assets)) {
    if (dependent.metadata?.referenceAssetIds) dependent.metadata.referenceAssetIds = replaceId(dependent.metadata.referenceAssetIds, oldAssetId, newAssetId);
    if (dependent.provenance?.generatedFromAssetIds) dependent.provenance.generatedFromAssetIds = replaceId(dependent.provenance.generatedFromAssetIds, oldAssetId, newAssetId);
  }
  delete next.assets[oldAssetId];
  for (const panelId of Object.keys(next.panels)) syncPanelScene(next, panelId);
  touch(next);
  return next;
}

function replaceId(ids: ID[], oldAssetId: ID, newAssetId: ID): ID[] {
  return ids.map((id) => id === oldAssetId ? newAssetId : id).filter((id, index, all) => all.indexOf(id) === index);
}

function detachAssetFromCharacterMutable(doc: ProjectDocument, characterId: ID, assetId: ID): void {
  const character = doc.characters[characterId];
  if (!character) return;
  character.assetIds = character.assetIds.filter((id) => id !== assetId);
  if (character.referenceAssetId === assetId || character.canonicalReferenceAssetId === assetId) {
    const replacement = character.assetIds.find((id) => doc.assets[id]?.metadata?.characterAssetRole === "canonical")
      ?? character.assetIds[0];
    character.referenceAssetId = replacement;
    character.canonicalReferenceAssetId = replacement;
  }
  const asset = doc.assets[assetId];
  if (asset?.metadata?.characterId === characterId) {
    delete asset.metadata.characterId;
    delete asset.metadata.characterAssetRole;
    delete asset.metadata.canonicalReferenceAssetId;
  }
  if (asset?.provenance?.characterId === characterId) {
    delete asset.provenance.characterId;
    delete asset.provenance.characterState;
    delete asset.provenance.canonicalReferenceAssetId;
  }
}
