/**
 * A character must stay a character through every link the document uses.
 *
 * The reported failure: a character selected on the canvas rendered as an
 * anonymous picture — no State tab, no Interactions tab, no Details tab —
 * because the Inspector asked only `asset.metadata.characterId` and this
 * document had the identity on a different link.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { characterActorsInPanel, characterIdOfAsset, characterIdOfInstance } from "./identity";

function seeded() {
  let doc: ProjectDocument = createProjectDocument("Identity");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/y.png",
    processedImageUrl: "https://example.com/y-a.png",
    width: 800,
    height: 1400,
    metadata: { characterId: yuri.characterId, characterAssetRole: "state", pose: "standing" },
  });
  doc = asset.doc;
  const pageId = Object.values(doc.pages)[0].id;
  const panelId = doc.pages[pageId].panelIds[0];
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: asset.assetId });
  return { doc: placed.doc, characterId: yuri.characterId, assetId: asset.assetId, itemId: placed.createdId!, panelId };
}

describe("character identity survives every link", () => {
  it("resolves from asset metadata", () => {
    const s = seeded();
    expect(characterIdOfInstance(s.doc, s.doc.items[s.itemId])).toBe(s.characterId);
  });

  it("resolves from the instance's own state when metadata was lost", () => {
    const s = seeded();
    const doc = structuredClone(s.doc);
    delete doc.assets[s.assetId].metadata!.characterId;
    // The instance still carries the state stamped at placement time.
    expect((doc.items[s.itemId] as AssetInstance).characterState?.characterId).toBe(s.characterId);
    expect(characterIdOfInstance(doc, doc.items[s.itemId])).toBe(s.characterId);
  });

  /**
   * The state that actually broke: metadata lost AND the instance state gone,
   * with only the character's own asset list still pointing back. This is what
   * `replaceAssetReferences` produces when the replacement asset arrives
   * without `characterId` in its metadata.
   */
  it("resolves from the character's asset list when both forward links are gone", () => {
    const s = seeded();
    const doc = structuredClone(s.doc);
    delete doc.assets[s.assetId].metadata!.characterId;
    delete (doc.items[s.itemId] as AssetInstance).characterState;
    expect(doc.characters[s.characterId].assetIds).toContain(s.assetId);

    expect(characterIdOfAsset(doc, s.assetId)).toBe(s.characterId);
    expect(characterIdOfInstance(doc, doc.items[s.itemId])).toBe(s.characterId);
    // And therefore the Inspector shows a character, not a picture in a box.
    expect(characterActorsInPanel(doc, s.panelId).map((a) => a.characterId)).toEqual([s.characterId]);
  });

  it("resolves from the canonical reference link alone", () => {
    const s = seeded();
    const doc = structuredClone(s.doc);
    delete doc.assets[s.assetId].metadata!.characterId;
    delete (doc.items[s.itemId] as AssetInstance).characterState;
    doc.characters[s.characterId].assetIds = [];
    doc.characters[s.characterId].canonicalReferenceAssetId = s.assetId;
    expect(characterIdOfInstance(doc, doc.items[s.itemId])).toBe(s.characterId);
  });

  it("does not invent a character for a prop", () => {
    const s = seeded();
    let doc = s.doc;
    const lamp = addAsset(doc, {
      category: "prop",
      name: "Lamp",
      storageUrl: "https://example.com/l.png",
      width: 100,
      height: 100,
    });
    doc = lamp.doc;
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: s.panelId, assetId: lamp.assetId });
    expect(characterIdOfInstance(placed.doc, placed.doc.items[placed.createdId!])).toBeUndefined();
  });

  it("ignores a dangling id that names no existing character", () => {
    const s = seeded();
    const doc = structuredClone(s.doc);
    doc.assets[s.assetId].metadata!.characterId = "deleted-character" as ID;
    delete (doc.items[s.itemId] as AssetInstance).characterState;
    doc.characters[s.characterId].assetIds = [];
    delete doc.characters[s.characterId].canonicalReferenceAssetId;
    delete doc.characters[s.characterId].referenceAssetId;
    expect(characterIdOfInstance(doc, doc.items[s.itemId])).toBeUndefined();
  });
});
