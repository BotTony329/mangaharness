import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { placeAsset, removeItem } from "./itemOps";
import { addWorkspaceItem } from "./workspaceOps";
import { createInteraction, recordInteractionRender } from "./interactions";
import {
  AssetInUseError,
  deleteAsset,
  deleteCharacter,
  detachCharacterVisual,
  inspectAssetUsage,
  setAssetArchived,
} from "./assetLifecycle";

function characterProject() {
  let doc = createProjectDocument("Lifecycle");
  const character = addCharacter(doc, "Mio");
  doc = character.doc;
  const reference = addAsset(doc, {
    category: "character",
    name: "Mio reference",
    storageUrl: "https://example.com/mio.png",
    width: 800,
    height: 1600,
    metadata: { characterId: character.characterId, characterAssetRole: "canonical" },
  });
  doc = reference.doc;
  const walking = addAsset(doc, {
    category: "character",
    name: "Mio walking",
    storageUrl: "https://example.com/mio-walking.png",
    width: 800,
    height: 1600,
    metadata: { characterId: character.characterId, characterAssetRole: "state", pose: "walking" },
  });
  return { doc: walking.doc, characterId: character.characterId, referenceId: reference.assetId, walkingId: walking.assetId };
}

describe("asset lifecycle", () => {
  it("deletes an unused background or prop safely", () => {
    let doc = createProjectDocument("Unused");
    const background = addAsset(doc, { category: "background", name: "Street", storageUrl: "street.png", width: 100, height: 100 });
    doc = background.doc;
    const prop = addAsset(doc, { category: "prop", name: "Bag", storageUrl: "bag.png", width: 100, height: 100 });
    doc = deleteAsset(prop.doc, background.assetId, "if-unused");
    doc = deleteAsset(doc, prop.assetId, "if-unused");
    expect(doc.assets[background.assetId]).toBeUndefined();
    expect(doc.assets[prop.assetId]).toBeUndefined();
  });

  it("refuses an unsafe delete until the caller chooses archive or cascade", () => {
    const seeded = characterProject();
    const panelId = Object.keys(seeded.doc.panels)[0];
    const placed = placeAsset(seeded.doc, panelId, seeded.walkingId);
    expect(() => deleteAsset(placed.doc, seeded.walkingId, "if-unused")).toThrow(AssetInUseError);
    expect(inspectAssetUsage(placed.doc, seeded.walkingId).map((usage) => usage.kind)).toContain("panel-instance");
    const archived = setAssetArchived(placed.doc, seeded.walkingId, true);
    expect(archived.assets[seeded.walkingId].status).toBe("archived");
    expect(archived.items[placed.itemId]).toBeDefined();
    expect(setAssetArchived(archived, seeded.walkingId, false).assets[seeded.walkingId].status).toBe("ready");
  });

  it("cascade deletion removes panel/workspace/character/history references without broken IDs", () => {
    const seeded = characterProject();
    const panelId = Object.keys(seeded.doc.panels)[0];
    let doc = placeAsset(seeded.doc, panelId, seeded.walkingId).doc;
    doc = addWorkspaceItem(doc, seeded.walkingId, { x: 50, y: 50 }).doc;
    doc.generationHistory.push({ id: "generation", status: "succeeded", assetType: "character-pose", prompt: "walk", resultAssetId: seeded.walkingId, createdAt: new Date().toISOString() });
    const deleted = deleteAsset(doc, seeded.walkingId, "cascade");
    expect(deleted.assets[seeded.walkingId]).toBeUndefined();
    expect(Object.values(deleted.items).some((item) => item.kind === "asset" && item.sourceAssetId === seeded.walkingId)).toBe(false);
    expect(Object.values(deleted.workspaceItems).some((item) => item.sourceAssetId === seeded.walkingId)).toBe(false);
    expect(deleted.characters[seeded.characterId].assetIds).not.toContain(seeded.walkingId);
    expect(deleted.generationHistory[0].resultAssetId).toBeUndefined();
  });

  it("deleting an instance never deletes its source asset", () => {
    const seeded = characterProject();
    const panelId = Object.keys(seeded.doc.panels)[0];
    const placed = placeAsset(seeded.doc, panelId, seeded.walkingId);
    const next = removeItem(placed.doc, placed.itemId);
    expect(next.assets[seeded.walkingId]).toBeDefined();
  });

  it("removes one visual state without deleting the Character or its other assets", () => {
    const seeded = characterProject();
    const next = deleteAsset(seeded.doc, seeded.walkingId, "cascade");
    expect(next.characters[seeded.characterId]).toBeDefined();
    expect(next.assets[seeded.referenceId]).toBeDefined();
    expect(next.assets[seeded.walkingId]).toBeUndefined();
  });

  it("detaches a visual while retaining it as a generic reusable source", () => {
    const seeded = characterProject();
    const next = detachCharacterVisual(seeded.doc, seeded.characterId, seeded.walkingId);
    expect(next.assets[seeded.walkingId]).toBeDefined();
    expect(next.assets[seeded.walkingId].metadata?.characterId).toBeUndefined();
    expect(next.characters[seeded.characterId].assetIds).not.toContain(seeded.walkingId);
  });

  it("deletes a Character while keeping assets or removes everything explicitly", () => {
    const kept = characterProject();
    const keepAssets = deleteCharacter(kept.doc, kept.characterId, "keep-assets");
    expect(keepAssets.characters[kept.characterId]).toBeUndefined();
    expect(keepAssets.assets[kept.referenceId]).toBeDefined();
    expect(keepAssets.assets[kept.referenceId].metadata?.characterId).toBeUndefined();

    const removed = characterProject();
    const deleteAll = deleteCharacter(removed.doc, removed.characterId, "delete-all");
    expect(deleteAll.characters[removed.characterId]).toBeUndefined();
    expect(deleteAll.assets[removed.referenceId]).toBeUndefined();
    expect(deleteAll.assets[removed.walkingId]).toBeUndefined();
  });

  it("deleting a character removes their interactions and render ledger entries", () => {
    const seeded = characterProject();
    const second = addCharacter(seeded.doc, "Ren");
    let doc = second.doc;
    const panelId = Object.keys(doc.panels)[0];
    const created = createInteraction(doc, {
      panelId,
      participantIds: [seeded.characterId, second.characterId],
      type: "hug",
    });
    doc = created.doc;
    const rendered = recordInteractionRender(doc, {
      interactionId: created.interactionId,
      participantCharacterIds: [seeded.characterId, second.characterId],
      participantReferenceAssetIds: [seeded.referenceId],
      generatedAssetId: seeded.walkingId,
      cacheKey: "test-cache-key",
    });
    doc = rendered.doc;

    const deleted = deleteCharacter(doc, second.characterId, "keep-assets");
    expect(deleted.interactions[created.interactionId]).toBeUndefined();
    expect(deleted.interactionRenders[rendered.renderId]).toBeUndefined();
  });

  it("deleting a prop removes object interactions that used it", () => {
    const seeded = characterProject();
    let doc = seeded.doc;
    const panelId = Object.keys(doc.panels)[0];
    const bowl = addAsset(doc, { category: "prop", name: "Ramen bowl", storageUrl: "ramen.png", width: 100, height: 100 });
    doc = bowl.doc;
    const created = createInteraction(doc, {
      panelId,
      participantIds: [seeded.characterId],
      participants: [
        { id: seeded.characterId, kind: "character", role: "initiator" },
        { id: bowl.assetId, kind: "object", role: "target" },
      ],
      type: "eat",
    });
    doc = created.doc;

    const deleted = deleteAsset(doc, bowl.assetId, "cascade");
    expect(deleted.interactions[created.interactionId]).toBeUndefined();
  });

  it("interactions between surviving participants are kept", () => {
    const seeded = characterProject();
    const second = addCharacter(seeded.doc, "Ren");
    let doc = second.doc;
    const panelId = Object.keys(doc.panels)[0];
    const created = createInteraction(doc, {
      panelId,
      participantIds: [seeded.characterId, second.characterId],
      type: "hug",
    });
    doc = created.doc;

    // Deleting an unrelated asset leaves the interaction intact.
    const unrelated = addAsset(doc, { category: "prop", name: "Bag", storageUrl: "bag.png", width: 10, height: 10 });
    const deleted = deleteAsset(unrelated.doc, unrelated.assetId, "if-unused");
    expect(deleted.interactions[created.interactionId]).toBeDefined();
  });
});
