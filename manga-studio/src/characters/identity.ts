/**
 * Which character does this asset or instance belong to?
 *
 * ## Why this is a module and not an expression
 *
 * A character can be linked to an asset three different ways, and different
 * parts of the app were each checking a different one:
 *
 *   1. `instance.characterState.characterId` — set when the asset was placed
 *   2. `asset.metadata.characterId`          — set when the asset was created
 *   3. `character.assetIds` / the canonical reference — the reverse link
 *
 * They usually agree. They do not always: `replaceAssetReferences` rewrites
 * `character.assetIds` to the new asset and re-derives `characterState` from
 * the new asset's metadata, so an asset that arrives without `characterId` in
 * its metadata ends up owned by a character (link 3) while links 1 and 2 are
 * both empty. `repairableAssetIds` already knew this and checked both
 * directions; the Inspector checked only link 2, so a character in that state
 * was rendered as an anonymous picture: no State, no Interactions, no Details.
 *
 * One resolver, checked in confidence order, used everywhere. A character whose
 * identity survives in ANY of the three links is a character.
 */

import type { AssetInstance, Character, ID, ProjectDocument } from "@/domain/types";

/** The character that owns this asset, by any surviving link. */
export function characterIdOfAsset(doc: ProjectDocument, assetId: ID | undefined): ID | undefined {
  if (!assetId) return undefined;
  const direct = doc.assets[assetId]?.metadata?.characterId;
  if (direct && doc.characters[direct]) return direct;

  /**
   * Reverse lookup. Deliberately last: it is O(characters) and only matters for
   * documents whose forward link was lost, but without it those documents are
   * permanently un-editable as characters.
   */
  for (const character of Object.values(doc.characters)) {
    if (character.assetIds?.includes(assetId)) return character.id;
    if (character.canonicalReferenceAssetId === assetId || character.referenceAssetId === assetId) {
      return character.id;
    }
  }
  return undefined;
}

/** The character this placed instance represents, by any surviving link. */
export function characterIdOfInstance(
  doc: ProjectDocument,
  item: { kind: string; sourceAssetId?: ID; characterState?: { characterId?: ID } } | undefined,
): ID | undefined {
  if (!item || item.kind !== "asset") return undefined;
  const fromState = item.characterState?.characterId;
  if (fromState && doc.characters[fromState]) return fromState;
  return characterIdOfAsset(doc, item.sourceAssetId);
}

export function characterOfInstance(doc: ProjectDocument, item: AssetInstance | undefined): Character | undefined {
  const id = characterIdOfInstance(doc, item);
  return id ? doc.characters[id] : undefined;
}

/** Every character actor placed in a panel, in stacking order. */
export function characterActorsInPanel(
  doc: ProjectDocument,
  panelId: ID | undefined,
): { item: AssetInstance; characterId: ID }[] {
  const out: { item: AssetInstance; characterId: ID }[] = [];
  for (const itemId of (panelId && doc.panels[panelId]?.itemIds) || []) {
    const item = doc.items[itemId];
    if (item?.kind !== "asset") continue;
    const characterId = characterIdOfInstance(doc, item);
    if (characterId) out.push({ item, characterId });
  }
  return out;
}
