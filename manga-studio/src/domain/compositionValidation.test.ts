import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { applyDomainCommand } from "./commands";
import { validateAndCorrectComposition, validateScopeIntegrity } from "./compositionValidation";

describe("composition validation", () => {
  it("corrects a character that is tiny and outside its panel", () => {
    let doc = createProjectDocument("Validation");
    const character = addCharacter(doc, "Mio");
    doc = character.doc;
    const visual = addAsset(doc, {
      category: "character",
      name: "Mio",
      storageUrl: "mio.png",
      width: 800,
      height: 1600,
      metadata: { characterId: character.characterId, characterAssetRole: "state" },
    });
    doc = visual.doc;
    const panelId = Object.keys(doc.panels)[0];
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: visual.assetId });
    doc = applyDomainCommand(placed.doc, {
      type: "update-instance-transform",
      instanceId: placed.createdId!,
      patch: { cx: -1000, cy: -1000, width: 5, height: 10 },
    }).doc;

    const result = validateAndCorrectComposition(doc, [panelId], { requiredCharacterIds: [character.characterId] });
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["character-outside-panel", "character-too-small"]));
    expect(result.issues.every((issue) => issue.corrected)).toBe(true);
    const item = result.doc.items[placed.createdId!];
    expect(item.kind === "asset" ? item.cx : 0).toBeGreaterThan(0);
  });

  it("detects a sibling mutation outside selected-object scope", () => {
    let before = createProjectDocument("Scope audit");
    const prop = addAsset(before, { category: "prop", name: "Bag", storageUrl: "bag.png", width: 100, height: 100 });
    before = prop.doc;
    const panelId = Object.keys(before.panels)[0];
    const first = applyDomainCommand(before, { type: "add-instance", panelId, assetId: prop.assetId });
    const second = applyDomainCommand(first.doc, { type: "add-instance", panelId, assetId: prop.assetId });
    const after = applyDomainCommand(second.doc, {
      type: "update-instance-transform",
      instanceId: second.createdId!,
      patch: { cx: 999 },
    }).doc;

    const issues = validateScopeIntegrity(second.doc, after, {
      kind: "selected-object",
      pageId: Object.keys(before.pages)[0],
      panelId,
      itemId: first.createdId,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("scope-integrity");
  });
});
