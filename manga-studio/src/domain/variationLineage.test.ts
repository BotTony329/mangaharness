/**
 * A cosmetic repair must reach every later use of the image it fixed.
 *
 * The failure this pins down is quiet: the creator fixes a malformed hand, sees
 * it corrected in front of them, and then every subsequent "place Yuri
 * standing" silently returns the broken original because the state graph never
 * heard about the repair.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { resolveCharacterState } from "@/characters/stateResolver";
import type { ProjectDocument } from "./types";

function fixture() {
  let doc: ProjectDocument = createProjectDocument("Variations");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const canonical = addAsset(doc, {
    category: "character",
    name: "Yuri canonical",
    storageUrl: "https://example.com/yuri.png",
    width: 800,
    height: 1400,
    metadata: { characterId: yuri.characterId, characterAssetRole: "canonical" },
  });
  doc = canonical.doc;
  const standing = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/yuri-standing.png",
    width: 800,
    height: 1400,
    metadata: {
      characterId: yuri.characterId,
      characterAssetRole: "state",
      pose: "standing",
      expression: "neutral",
      outfit: "school uniform",
      view: "front",
    },
  });
  return { doc: standing.doc, characterId: yuri.characterId, canonicalId: canonical.assetId, standingId: standing.assetId };
}

function editOf(base: ReturnType<typeof fixture>, parentAssetId: string, name: string) {
  return addAsset(base.doc, {
    category: "character",
    name,
    storageUrl: `https://example.com/${name}.png`,
    width: 800,
    height: 1400,
    metadata: base.doc.assets[parentAssetId].metadata,
    provenance: {
      generatedFromAssetIds: [parentAssetId],
      localEdit: { parentAssetId, editPrompt: "fix the hand", intent: "cosmetic", editedAt: new Date().toISOString() },
    },
  });
}

const STANDING = { pose: "standing", expression: "neutral", outfit: "school uniform", view: "front" };

describe("cosmetic variations", () => {
  it("becomes the render the resolver returns, without adding a state", () => {
    const base = fixture();
    const before = Object.keys(base.doc.characterStates).length;
    const fixed = editOf(base, base.standingId, "yuri-standing-fixed");

    // No new semantic node: it is the same pose, expression, outfit and view.
    expect(Object.keys(fixed.doc.characterStates)).toHaveLength(before);

    const resolved = resolveCharacterState(fixed.doc, { characterId: base.characterId, ...STANDING });
    expect(resolved.status).toBe("cached");
    if (resolved.status !== "cached") return;
    expect(resolved.assetId).toBe(fixed.assetId);
  });

  it("keeps the superseded original for lineage rather than deleting it", () => {
    const base = fixture();
    const fixed = editOf(base, base.standingId, "yuri-standing-fixed");

    expect(fixed.doc.assets[base.standingId]).toBeDefined();
    const record = Object.values(fixed.doc.characterStates).find((r) => r.pose === "standing");
    expect(record?.supersededAssetIds).toEqual([base.standingId]);
    expect(fixed.doc.assets[fixed.assetId].metadata?.characterAssetRole).toBe("variation");
  });

  it("moves the identity anchor when the canonical image itself was repaired", () => {
    const base = fixture();
    const fixed = editOf(base, base.canonicalId, "yuri-canonical-fixed");

    /**
     * A canonical image has no state record, so nothing is superseded — but the
     * anchor itself must move, or every future pose is generated from the image
     * that still has the defect.
     */
    expect(fixed.doc.characters[base.characterId].canonicalReferenceAssetId).toBe(fixed.assetId);
    expect(fixed.doc.characters[base.characterId].referenceAssetId).toBe(fixed.assetId);
  });

  it("never resolves a panel-only image as the character's current look", () => {
    const base = fixture();
    const composite = addAsset(base.doc, {
      category: "character",
      name: "Yuri + Mori · Hug",
      storageUrl: "https://example.com/hug.png",
      width: 900,
      height: 1400,
      metadata: {
        characterId: base.characterId,
        characterAssetRole: "panel-only",
        pose: "hugging",
        expression: "smiling",
        outfit: "school uniform",
        view: "front",
      },
    });

    const resolved = resolveCharacterState(composite.doc, {
      characterId: base.characterId,
      pose: "hugging",
      expression: "smiling",
      outfit: "school uniform",
      view: "front",
    });
    // It may be generated, but it must never come back as a cached render.
    if (resolved.status === "cached") expect(resolved.assetId).not.toBe(composite.assetId);
    expect(Object.values(composite.doc.characterStates).some((r) => r.assetId === composite.assetId)).toBe(false);
  });
});
