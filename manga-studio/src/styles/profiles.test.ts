import { describe, expect, it } from "vitest";
import { buildAssetPrompt, buildCharacterStatePrompt } from "@/ai/promptTemplates";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { addCustomStyle, setProjectStyle } from "@/domain/styleOps";
import { BUILTIN_STYLE_PROFILES, STYLE_FAMILIES, getActiveStyleProfile } from "./profiles";
import { getStyleGenerationContext, styleMetadata } from "./generation";
import { findExactCharacterAsset } from "@/characters/state";

describe("project art styles", () => {
  it("ships every required family and substantive prompt-bearing substyles", () => {
    expect(STYLE_FAMILIES.map((family) => family.id)).toEqual([
      "japanese-manga",
      "chinese-manhua",
      "western-comics",
      "webtoon",
      "sketch-experimental",
      "custom",
    ]);
    expect(BUILTIN_STYLE_PROFILES).toHaveLength(32);
    for (const profile of BUILTIN_STYLE_PROFILES) {
      expect(profile.positivePrompt.length).toBeGreaterThan(80);
      expect(profile.negativePrompt?.length).toBeGreaterThan(40);
      expect(profile.visualProperties).toBeDefined();
    }
    const minimal = BUILTIN_STYLE_PROFILES.find((profile) => profile.id === "western-comics/minimal-line-comic")!;
    expect(minimal.positivePrompt).toMatch(/few clean confident ink lines/i);
    expect(minimal.negativePrompt).toMatch(/detailed anime rendering/i);
  });

  it("persists a custom style and optional reference without touching existing assets", () => {
    let doc = createProjectDocument("Style state");
    const oldAsset = addAsset(doc, {
      category: "background",
      name: "Existing room",
      storageUrl: "https://example.com/room.png",
      width: 1200,
      height: 800,
    });
    doc = oldAsset.doc;
    const reference = addAsset(doc, {
      category: "upload",
      name: "Style guide",
      storageUrl: "https://example.com/style.png",
      width: 800,
      height: 800,
    });
    doc = reference.doc;
    const custom = addCustomStyle(doc, {
      name: "Simple Newspaper Cartoon",
      description: "Few lines and restrained expressions.",
      positivePrompt: "minimal black-and-white strip drawing with rounded simplified anatomy",
      negativePrompt: "anime rendering, cinematic shading",
      referenceAssetId: reference.assetId,
    });
    doc = custom.doc;

    expect(getActiveStyleProfile(doc).name).toBe("Simple Newspaper Cartoon");
    expect(doc.assets[oldAsset.assetId]).toEqual(reference.doc.assets[oldAsset.assetId]);
    const context = getStyleGenerationContext(doc);
    expect(context.referenceAsset?.id).toBe(reference.assetId);
    expect(styleMetadata(context)).toMatchObject({
      styleProfileId: custom.styleId,
      styleReferenceAssetId: reference.assetId,
    });
  });

  it("injects style into character and scenery prompts while keeping dimensions separate", () => {
    let doc = createProjectDocument("Styled prompts");
    doc = setProjectStyle(doc, "western-comics/minimal-line-comic");
    const style = getActiveStyleProfile(doc);
    const background = buildAssetPrompt({ assetType: "background", description: "city street", style });
    const character = buildCharacterStatePrompt({
      characterName: "Yuri",
      characterDescription: "Appearance: long sleek hair and calm eyes",
      pose: "walking",
      expression: "angry",
      outfit: "school uniform",
      view: "front",
      style,
      description: "Preserve pose (walking). Change only expression to angry.",
    });
    expect(background).toContain("Project art style — Minimal Line Comic");
    expect(character).toContain("Pose: walking");
    expect(character).toContain("Expression: angry");
    expect(character).toContain("Change only expression to angry");
    expect(character).toContain(style.positivePrompt);
  });

  it("does not reuse an old-style character render after the project style changes", () => {
    let doc = createProjectDocument("Style cache");
    const character = addCharacter(doc, "Yuri");
    doc = character.doc;
    const state = {
      characterId: character.characterId,
      pose: "walking",
      expression: "angry",
      outfit: "school uniform",
      view: "front",
    };
    const old = addAsset(doc, {
      category: "character",
      name: "Yuri walking angry",
      storageUrl: "https://example.com/yuri.png",
      width: 800,
      height: 1200,
      metadata: { ...state, characterAssetRole: "state", styleProfileId: "japanese-manga/minimal-line-manga" },
    });
    doc = old.doc;
    expect(findExactCharacterAsset(doc, doc.characters[character.characterId], state)?.id).toBe(old.assetId);
    doc = setProjectStyle(doc, "western-comics/minimal-line-comic");
    expect(findExactCharacterAsset(doc, doc.characters[character.characterId], state)).toBeUndefined();
    expect(doc.assets[old.assetId]).toBeDefined();
  });
});
