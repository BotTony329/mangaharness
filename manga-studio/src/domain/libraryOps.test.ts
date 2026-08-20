import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter, removeAsset, setCharacterReference } from "./libraryOps";

describe("character reference assets", () => {
  it("supports text-only characters", () => {
    const result = addCharacter(createProjectDocument("Test"), "Yuri", "long dark hair");
    expect(result.doc.characters[result.characterId]).toMatchObject({ name: "Yuri", description: "long dark hair", assetIds: [] });
  });

  it("makes the first character asset the reference and attaches later assets", () => {
    const character = addCharacter(createProjectDocument("Test"), "Yuri");
    const first = addAsset(character.doc, {
      category: "character",
      name: "Yuri reference",
      storageUrl: "https://example.com/yuri.png",
      width: 1024,
      height: 1024,
      metadata: { characterId: character.characterId },
    });
    const pose = addAsset(first.doc, {
      category: "character",
      name: "Yuri running",
      storageUrl: "https://example.com/yuri-running.png",
      width: 1024,
      height: 1024,
      metadata: { characterId: character.characterId, pose: "running" },
    });
    const savedCharacter = pose.doc.characters[character.characterId];
    expect(savedCharacter.referenceAssetId).toBe(first.assetId);
    expect(savedCharacter.assetIds).toEqual([first.assetId, pose.assetId]);
  });

  it("can replace and remove a reference", () => {
    const character = addCharacter(createProjectDocument("Test"), "Yuri");
    const first = addAsset(character.doc, {
      category: "character", name: "one", storageUrl: "https://example.com/1.png", width: 10, height: 10,
      metadata: { characterId: character.characterId },
    });
    const second = addAsset(first.doc, {
      category: "character", name: "two", storageUrl: "https://example.com/2.png", width: 10, height: 10,
      metadata: { characterId: character.characterId },
    });
    const replaced = setCharacterReference(second.doc, character.characterId, second.assetId);
    expect(replaced.characters[character.characterId].referenceAssetId).toBe(second.assetId);
    const removed = removeAsset(replaced, second.assetId);
    expect(removed.characters[character.characterId].referenceAssetId).toBe(first.assetId);
  });
});
