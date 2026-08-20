import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { applyDomainCommand } from "./commands";

describe("panel scene graph and continuity", () => {
  it("tracks background identity, Character semantics and relationships", () => {
    let doc = createProjectDocument("Scene");
    const yuri = addCharacter(doc, "Yuri");
    doc = yuri.doc;
    const visual = addAsset(doc, {
      category: "character",
      name: "opaque-name-8f2",
      storageUrl: "yuri.png",
      width: 800,
      height: 1600,
      metadata: { characterId: yuri.characterId, characterAssetRole: "state", pose: "walking" },
    });
    doc = visual.doc;
    const street = addAsset(doc, { category: "background", name: "Tokyo Street", storageUrl: "street.png", width: 1600, height: 1000 });
    doc = street.doc;
    const panelId = Object.keys(doc.panels)[0];
    doc = applyDomainCommand(doc, { type: "set-panel-background", panelId, assetId: street.assetId, location: "Tokyo Street" }).doc;
    const composed = applyDomainCommand(doc, {
      type: "compose-character",
      panelId,
      characterId: yuri.characterId,
      assetId: visual.assetId,
      position: "right",
      facing: "left",
      depth: "foreground",
      role: "passerby",
      framing: "medium-full",
    });
    doc = composed.doc;
    expect(doc.scenes[panelId]).toMatchObject({ location: "Tokyo Street", backgroundAssetId: street.assetId });
    expect(doc.scenes[panelId].characters[0]).toMatchObject({
      characterInstanceId: composed.createdId,
      characterId: yuri.characterId,
      semanticPosition: "right",
      facing: "left",
      depth: "foreground",
      role: "passerby",
    });
  });

  it("reuses the exact same background asset for scene continuity", () => {
    let doc = createProjectDocument("Continuity");
    const street = addAsset(doc, { category: "background", name: "Tokyo Street", storageUrl: "street.png", width: 1600, height: 1000 });
    doc = street.doc;
    const [panel1, panel2] = Object.keys(doc.panels);
    doc = applyDomainCommand(doc, { type: "set-panel-background", panelId: panel1, assetId: street.assetId }).doc;
    doc = applyDomainCommand(doc, { type: "reuse-panel-background", sourcePanelId: panel1, targetPanelId: panel2 }).doc;
    expect(doc.scenes[panel2].backgroundAssetId).toBe(street.assetId);
    expect(doc.scenes[panel2].continuity?.backgroundSourcePanelId).toBe(panel1);
    expect(Object.values(doc.assets)).toHaveLength(1);
  });
});
