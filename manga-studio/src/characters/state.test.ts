import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { placeAsset, swapInstanceAsset } from "@/domain/itemOps";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { AssetInstance, CharacterState } from "@/domain/types";
import { findExactCharacterAsset, mergeCharacterState, stateFromInstance } from "./state";

describe("character state resolver", () => {
  it("preserves independent fields and reuses an exact cached combination", () => {
    let doc = createProjectDocument("Rig acceptance");
    const created = addCharacter(doc, "Yuri");
    doc = created.doc;
    const states: CharacterState[] = [
      { characterId: created.characterId, pose: "walking", expression: "neutral", outfit: "school uniform", view: "front" },
      { characterId: created.characterId, pose: "walking", expression: "angry", outfit: "school uniform", view: "front" },
      { characterId: created.characterId, pose: "running", expression: "angry", outfit: "school uniform", view: "front" },
    ];
    const ids: string[] = [];
    for (const state of states) {
      const added = addAsset(doc, {
        category: "character",
        name: `${state.pose}-${state.expression}`,
        storageUrl: `https://example.com/${state.pose}-${state.expression}.png`,
        width: 800,
        height: 1600,
        metadata: { ...state, characterAssetRole: "state" },
      });
      doc = added.doc;
      ids.push(added.assetId);
    }
    const panelId = Object.values(doc.pages)[0].panelIds[0];
    const placed = placeAsset(doc, panelId, ids[0]);
    doc = placed.doc;
    const instance = doc.items[placed.itemId] as AssetInstance;

    const walkingNeutral = stateFromInstance(doc, instance)!;
    const walkingAngry = mergeCharacterState(walkingNeutral, { expression: "angry" });
    expect(walkingAngry).toMatchObject({ pose: "walking", expression: "angry", outfit: "school uniform", view: "front" });
    const angryAsset = findExactCharacterAsset(doc, doc.characters[created.characterId], walkingAngry);
    expect(angryAsset?.id).toBe(ids[1]);

    doc = swapInstanceAsset(doc, placed.itemId, ids[1]);
    const runningAngry = mergeCharacterState(stateFromInstance(doc, doc.items[placed.itemId] as AssetInstance)!, { pose: "running" });
    expect(findExactCharacterAsset(doc, doc.characters[created.characterId], runningAngry)?.id).toBe(ids[2]);

    // Switching back is another exact cache hit: no generation path is needed.
    const backToWalking = mergeCharacterState(runningAngry, { pose: "walking" });
    expect(findExactCharacterAsset(doc, doc.characters[created.characterId], backToWalking)?.id).toBe(ids[1]);
  });
});
