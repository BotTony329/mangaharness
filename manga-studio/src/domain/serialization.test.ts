import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { addBubble, placeAsset } from "./itemOps";
import { setPageLayout } from "./pageOps";
import { deserializeProject, serializeProject } from "./serialization";

function buildRichDoc() {
  let doc = createProjectDocument("Round Trip");
  const char = addCharacter(doc, "Akari", "high school girl");
  doc = char.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Akari standing",
    storageUrl: "https://example.com/akari.png",
    width: 1000,
    height: 2000,
    metadata: { characterId: char.characterId, pose: "standing", expression: "neutral" },
  });
  doc = asset.doc;
  const panelId = Object.keys(doc.panels)[0];
  doc = placeAsset(doc, panelId, asset.assetId).doc;
  doc = addBubble(doc, panelId, "speech", "Hello!").doc;
  return doc;
}

describe("project serialization", () => {
  it("round-trips losslessly", () => {
    const doc = buildRichDoc();
    const restored = deserializeProject(serializeProject(doc));
    expect(restored).toEqual(doc);
  });

  it("survives a layout change round-trip", () => {
    let doc = buildRichDoc();
    doc = setPageLayout(doc, Object.keys(doc.pages)[0], "yonkoma");
    const restored = deserializeProject(serializeProject(doc));
    expect(restored).toEqual(doc);
    // Content survived the layout replacement (never silently deleted).
    expect(Object.values(restored.items).length).toBe(2);
  });

  it("rejects invalid JSON and corrupt documents", () => {
    expect(() => deserializeProject("not json")).toThrow(/not valid JSON/);
    expect(() => deserializeProject(JSON.stringify({ schemaVersion: 1 }))).toThrow(/Corrupt/);
  });

  it("rejects documents from a newer schema", () => {
    const doc = { ...buildRichDoc(), schemaVersion: 999 };
    expect(() => deserializeProject(JSON.stringify(doc))).toThrow(/newer app version/);
  });
});

describe("layout content preservation", () => {
  it("re-homes items when the new layout has fewer panels", () => {
    let doc = createProjectDocument("Shrink", "four-grid");
    const asset = addAsset(doc, {
      category: "prop",
      name: "Bag",
      storageUrl: "https://example.com/bag.png",
      width: 500,
      height: 500,
    });
    doc = asset.doc;
    const pageId = Object.keys(doc.pages)[0];
    // One item in each of the four panels.
    for (const panelId of doc.pages[pageId].panelIds) {
      doc = placeAsset(doc, panelId, asset.assetId).doc;
    }
    doc = setPageLayout(doc, pageId, "single");
    const onlyPanel = doc.pages[pageId].panelIds[0];
    expect(doc.pages[pageId].panelIds).toHaveLength(1);
    expect(doc.panels[onlyPanel].itemIds).toHaveLength(4);
    for (const item of Object.values(doc.items)) {
      expect(item.panelId).toBe(onlyPanel);
    }
  });
});
