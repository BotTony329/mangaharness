/**
 * Asset vs Instance behaviour, and the edit instruction contract.
 *
 * The rule under test: editing an ASSET must never silently change every panel
 * already using it. A creator fixing Yuri's hand in panel 2 has not asked for
 * panels 1 and 3 to change.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { buildEditInstruction } from "./editRequest";
import { requestsColouredMatte } from "@/ai/foregroundPolicy";

interface Scene {
  doc: ProjectDocument;
  assetId: ID;
  characterId: ID;
  instances: ID[];
  panels: ID[];
}

function threePanels(): Scene {
  let doc = createProjectDocument("Editing");
  const page = doc.pages[Object.keys(doc.pages)[0]];
  const character = addCharacter(doc, "Yuri");
  doc = character.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Yuri walking",
    storageUrl: "https://example.com/yuri.png",
    processedImageUrl: "https://example.com/yuri-cut.png",
    width: 800,
    height: 1200,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: {
      characterId: character.characterId,
      pose: "walking",
      expression: "neutral",
      outfit: "default outfit",
      view: "front",
      characterAssetRole: "state",
    },
  });
  doc = asset.doc;

  const instances: ID[] = [];
  const panels = page.panelIds.slice(0, 3);
  for (const panelId of panels) {
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: asset.assetId });
    doc = placed.doc;
    instances.push(placed.createdId!);
  }
  return { doc, assetId: asset.assetId, characterId: character.characterId, instances, panels };
}

/** Register an edited result the way the editor's Save as Variation does. */
function saveVariation(doc: ProjectDocument, parentId: ID, prompt: string) {
  const parent = doc.assets[parentId];
  return applyDomainCommand(doc, {
    type: "create-asset",
    input: {
      category: parent.category,
      name: `${parent.name} · ${prompt}`,
      storageUrl: "https://example.com/variation.png",
      processedImageUrl: "https://example.com/variation.png",
      width: parent.width,
      height: parent.height,
      hasAlpha: parent.hasAlpha,
      backgroundRemoved: parent.backgroundRemoved,
      processingStatus: "ready",
      metadata: parent.metadata,
      provenance: {
        generatedFromAssetIds: [parentId],
        localEdit: {
          parentAssetId: parentId,
          editPrompt: prompt,
          intent: "cosmetic",
          editedAt: "2026-08-21T00:00:00.000Z",
        },
      },
    },
  });
}

const sourceOf = (doc: ProjectDocument, itemId: ID) => (doc.items[itemId] as AssetInstance).sourceAssetId;

// ─── §34: instance isolation ───────────────────────────────────────────────

describe("asset versus instance", () => {
  it("saving a variation leaves every existing instance untouched", () => {
    const scene = threePanels();
    const saved = saveVariation(scene.doc, scene.assetId, "holding a phone");

    // The library gained an asset; nothing was rewritten.
    expect(Object.keys(saved.doc.assets)).toHaveLength(2);
    expect(saved.doc.assets[scene.assetId].storageUrl).toBe("https://example.com/yuri.png");
    for (const instanceId of scene.instances) {
      expect(sourceOf(saved.doc, instanceId)).toBe(scene.assetId);
    }
  });

  it("'use only in this panel' swaps one instance and no others", () => {
    const scene = threePanels();
    const saved = saveVariation(scene.doc, scene.assetId, "holding a phone");
    const swapped = applyDomainCommand(saved.doc, {
      type: "swap-instance-asset",
      instanceId: scene.instances[1],
      assetId: saved.createdId!,
    }).doc;

    expect(sourceOf(swapped, scene.instances[1])).toBe(saved.createdId);
    // Panels 1 and 3 still point at the original.
    expect(sourceOf(swapped, scene.instances[0])).toBe(scene.assetId);
    expect(sourceOf(swapped, scene.instances[2])).toBe(scene.assetId);
    // And the library original is unchanged.
    expect(swapped.assets[scene.assetId].storageUrl).toBe("https://example.com/yuri.png");
  });

  it("undo returns the swapped panel to the original", () => {
    const scene = threePanels();
    const saved = saveVariation(scene.doc, scene.assetId, "holding a phone");
    useEditorStore.getState().loadDocument(saved.doc);

    useEditorStore.getState().dispatch({
      type: "swap-instance-asset",
      instanceId: scene.instances[1],
      assetId: saved.createdId!,
    });
    expect(sourceOf(useEditorStore.getState().doc!, scene.instances[1])).toBe(saved.createdId);

    useEditorStore.getState().undo();
    expect(sourceOf(useEditorStore.getState().doc!, scene.instances[1])).toBe(scene.assetId);
  });

  it("replacing the asset DOES change every instance — which is why it is confirmed", () => {
    const scene = threePanels();
    const saved = saveVariation(scene.doc, scene.assetId, "holding a phone");
    const replaced = applyDomainCommand(saved.doc, {
      type: "replace-asset",
      oldAssetId: scene.assetId,
      newAssetId: saved.createdId!,
    }).doc;

    for (const instanceId of scene.instances) {
      expect(sourceOf(replaced, instanceId)).toBe(saved.createdId);
    }
  });

  it("a variation records where it came from and what was asked", () => {
    const scene = threePanels();
    const saved = saveVariation(scene.doc, scene.assetId, "fix the right hand");
    const variation = saved.doc.assets[saved.createdId!];

    expect(variation.provenance?.localEdit?.parentAssetId).toBe(scene.assetId);
    expect(variation.provenance?.localEdit?.editPrompt).toBe("fix the right hand");
    // A pixel repair is NOT a semantic state change (§22).
    expect(variation.provenance?.localEdit?.intent).toBe("cosmetic");
    expect(Object.keys(saved.doc.characterStates ?? {})).toHaveLength(
      Object.keys(scene.doc.characterStates ?? {}).length,
    );
  });
});

// ─── §31: the edit instruction must not reintroduce a matte ────────────────

describe("edit instruction", () => {
  const CASES = [
    { name: "character", category: "character" as const, characterName: "Yuri" },
    { name: "object", category: "prop" as const },
    { name: "upload", category: "upload" as const },
  ];

  it.each(CASES)("$name edits never request a coloured background", ({ category, characterName }) => {
    const instruction = buildEditInstruction({
      prompt: "fix the hand",
      category,
      characterName,
      state: { pose: "walking", expression: "neutral", outfit: "uniform", view: "front" },
      styleName: "Modern Manhua",
    });
    expect(requestsColouredMatte(instruction)).toBe(false);
    for (const term of ["magenta", "purple background", "green screen", "chroma"]) {
      expect(instruction.toLowerCase()).not.toContain(term);
    }
  });

  it("tells a cut-out edit to keep the surround empty, not white", () => {
    const instruction = buildEditInstruction({ prompt: "add a star", category: "prop" });
    expect(instruction).toContain("empty and transparent");
    // Asking for white here would invite the model to paint a backdrop into the
    // transparent surround that alpha restore would then have to undo.
    expect(instruction).not.toContain("#FFFFFF");
  });

  it("tells a scene edit to keep the whole rectangle", () => {
    const instruction = buildEditInstruction({ prompt: "make it sunset", category: "background" });
    expect(instruction).toContain("complete rectangular image");
    expect(instruction).not.toContain("transparent");
  });

  it("carries identity and state so the creator need not re-describe them", () => {
    const instruction = buildEditInstruction({
      prompt: "hold a phone",
      category: "character",
      characterName: "Yuri",
      state: { pose: "walking", expression: "neutral", outfit: "school uniform", view: "front" },
      styleName: "Shonen",
    });
    expect(instruction).toContain("This is Yuri");
    expect(instruction).toContain("walking");
    expect(instruction).toContain("school uniform");
    expect(instruction).toContain("Shonen");
    // And the creator's own words come first.
    expect(instruction.startsWith("hold a phone")).toBe(true);
  });
});
