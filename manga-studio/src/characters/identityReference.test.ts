/**
 * Identity references across every way a project can be damaged.
 *
 * The reported dead end — "Every participant needs a usable identity reference
 * before a joint render." — happened on a document that plainly contained a
 * usable picture of the character. So the property under test is not "the
 * pointer is set". It is: **if a usable image is legitimately linked to this
 * character by ANY surviving link, the resolver finds it.**
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { ID, ProjectDocument, SourceAsset } from "@/domain/types";
import {
  describeIdentityResolution,
  resolveCharacterIdentityReference,
  resolveIdentityReferences,
} from "./identityReference";

interface Fixture {
  doc: ProjectDocument;
  characterId: ID;
  canonicalId: ID;
  poseId: ID;
}

/** A healthy character: canonical reference plus one rendered pose state. */
function healthy(name = "Cute Girl"): Fixture {
  let doc = createProjectDocument("Identity references");
  const created = addCharacter(doc, name);
  doc = created.doc;

  const canonical = addAsset(doc, {
    category: "character",
    name: `${name} canonical`,
    storageUrl: "https://example.com/canonical.png",
    processedImageUrl: "https://example.com/canonical-cut.png",
    width: 800,
    height: 1400,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: created.characterId, characterAssetRole: "canonical", view: "front", expression: "neutral", pose: "standing" },
  });
  doc = canonical.doc;
  doc = applyDomainCommand(doc, { type: "set-character-reference", characterId: created.characterId, assetId: canonical.assetId }).doc;

  // The state shown in the screenshot: jumping, happy, seen from behind.
  const pose = addAsset(doc, {
    category: "character",
    name: `${name} jumping`,
    storageUrl: "https://example.com/jump.png",
    processedImageUrl: "https://example.com/jump-cut.png",
    width: 800,
    height: 1400,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: created.characterId, characterAssetRole: "state", pose: "jumping", expression: "happy", view: "back" },
  });
  doc = pose.doc;

  return { doc, characterId: created.characterId, canonicalId: canonical.assetId, poseId: pose.assetId };
}

const clone = (doc: ProjectDocument) => structuredClone(doc);
const asset = (doc: ProjectDocument, id: ID): SourceAsset => doc.assets[id];

describe("identity reference resolution", () => {
  it("A — canonical reference intact", () => {
    const f = healthy();
    const r = resolveCharacterIdentityReference(f.doc, f.characterId);
    expect(r).toMatchObject({ status: "resolved", assetId: f.canonicalId, source: "canonical", needsRepair: false });
  });

  it("B — asset metadata.characterId missing", () => {
    const f = healthy();
    const doc = clone(f.doc);
    delete asset(doc, f.canonicalId).metadata!.characterId;
    const r = resolveCharacterIdentityReference(doc, f.characterId);
    // The pointer still names it, and the pointer is enough.
    expect(r.status).toBe("resolved");
    expect(r.assetId).toBe(f.canonicalId);
  });

  it("C — instance characterState.characterId missing does not affect identity", () => {
    const f = healthy();
    let doc = clone(f.doc);
    const pageId = Object.values(doc.pages)[0].id;
    const panelId = doc.pages[pageId].panelIds[0];
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: f.poseId });
    doc = placed.doc;
    delete (doc.items[placed.createdId!] as { characterState?: unknown }).characterState;

    // Identity belongs to the CHARACTER, never to whatever is placed.
    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.status).toBe("resolved");
    expect(r.assetId).toBe(f.canonicalId);
  });

  it("D — a transparency replacement leaves only the reverse link", () => {
    const f = healthy();
    const doc = clone(f.doc);
    // Exactly what replaceAssetReferences used to leave behind.
    delete doc.characters[f.characterId].canonicalReferenceAssetId;
    delete doc.characters[f.characterId].referenceAssetId;
    delete asset(doc, f.canonicalId).metadata!.characterId;

    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.status).toBe("resolved");
    expect(r.needsRepair).toBe(true);
    expect(doc.characters[f.characterId].assetIds).toContain(r.assetId);
  });

  it("E — a cosmetic variation is usable but ranks below a canonical", () => {
    const f = healthy();
    let doc = clone(f.doc);
    const variation = addAsset(doc, {
      category: "character",
      name: "Cute Girl canonical · fixed hand",
      storageUrl: "https://example.com/var.png",
      processedImageUrl: "https://example.com/var-cut.png",
      width: 800,
      height: 1400,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: f.characterId, characterAssetRole: "variation" },
      provenance: { localEdit: { parentAssetId: f.poseId, editPrompt: "fix hand", intent: "cosmetic", editedAt: new Date().toISOString() } },
    });
    doc = variation.doc;
    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.assetId).toBe(f.canonicalId);
    expect(r.candidates).toContain(variation.assetId);
  });

  it("F — a rendered pose state is used only when nothing better exists", () => {
    const f = healthy();
    const doc = clone(f.doc);
    // Canonical gone entirely; only the jumping/happy/back render remains.
    delete doc.characters[f.characterId].canonicalReferenceAssetId;
    delete doc.characters[f.characterId].referenceAssetId;
    doc.characters[f.characterId].assetIds = [f.poseId];
    doc.assets[f.canonicalId].status = "archived";

    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.status).toBe("resolved");
    expect(r.assetId).toBe(f.poseId);
    expect(r.needsRepair).toBe(true);
  });

  it("G — reverse Character.assetIds link only", () => {
    const f = healthy();
    const doc = clone(f.doc);
    delete doc.characters[f.characterId].canonicalReferenceAssetId;
    delete doc.characters[f.characterId].referenceAssetId;
    delete asset(doc, f.canonicalId).metadata!.characterId;
    delete asset(doc, f.poseId).metadata!.characterId;
    expect(doc.characters[f.characterId].assetIds.length).toBeGreaterThan(0);

    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.status).toBe("resolved");
    // Still prefers the canonical-role image over the action pose.
    expect(r.assetId).toBe(f.canonicalId);
  });

  it("prefers a neutral front reference over the pose that happens to be placed", () => {
    const f = healthy();
    const doc = clone(f.doc);
    // Canonical is not flagged by role; it must still win on view/expression/pose.
    delete doc.assets[f.canonicalId].metadata!.characterAssetRole;
    delete doc.characters[f.characterId].canonicalReferenceAssetId;
    delete doc.characters[f.characterId].referenceAssetId;

    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.assetId).toBe(f.canonicalId);
  });

  it("reports MISSING, with a reason, only when nothing usable exists", () => {
    const f = healthy();
    const doc = clone(f.doc);
    for (const id of [f.canonicalId, f.poseId]) doc.assets[id].processingStatus = "failed";
    delete doc.characters[f.characterId].canonicalReferenceAssetId;
    delete doc.characters[f.characterId].referenceAssetId;

    const r = resolveCharacterIdentityReference(doc, f.characterId);
    expect(r.status).toBe("missing");
    // Names the character and says what is wrong, in the creator's terms.
    expect(r.reason).toMatch(/Cute Girl/);
    expect(r.reason).toMatch(/cut-out/);
    // And it never mentions our internals.
    expect(r.reason).not.toMatch(/characterId|assetId|metadata|resolver/);
  });

  it("says something different when the character simply has no images", () => {
    let doc = createProjectDocument("Empty");
    const created = addCharacter(doc, "Mori");
    doc = created.doc;
    const r = resolveCharacterIdentityReference(doc, created.characterId);
    expect(r.status).toBe("missing");
    expect(r.reason).toMatch(/no reference image yet/);
  });

  it("two participants resolve to two DIFFERENT pictures", () => {
    const a = healthy("Cute Girl");
    let doc = a.doc;
    const mori = addCharacter(doc, "Mori");
    doc = mori.doc;
    const moriAsset = addAsset(doc, {
      category: "character",
      name: "Mori canonical",
      storageUrl: "https://example.com/mori.png",
      processedImageUrl: "https://example.com/mori-cut.png",
      width: 800,
      height: 1400,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: mori.characterId, characterAssetRole: "canonical" },
    });
    doc = moriAsset.doc;

    const references = resolveIdentityReferences(doc, [a.characterId, mori.characterId]);
    expect(references.every((r) => r.status === "resolved")).toBe(true);
    expect(references[0].assetId).not.toBe(references[1].assetId);
    // Each reference belongs to its own character.
    expect(doc.assets[references[0].assetId!].metadata?.characterId).toBe(a.characterId);
    expect(doc.assets[references[1].assetId!].metadata?.characterId).toBe(mori.characterId);
  });

  it("the diagnostic reports every link it consulted", () => {
    const f = healthy();
    const doc = clone(f.doc);
    doc.assets[f.poseId].processingStatus = "failed";
    const d = describeIdentityResolution(doc, f.characterId);

    expect(d.characterName).toBe("Cute Girl");
    expect(d.canonicalAssetId).toBe(f.canonicalId);
    expect(d.usableAssetIds).toContain(f.canonicalId);
    expect(d.unusableAssetIds.map((u) => u.assetId)).toContain(f.poseId);
    expect(d.unusableAssetIds.find((u) => u.assetId === f.poseId)?.why).toMatch(/background removal failed/);
    expect(d.resolvedFrom).toBe("canonical");
    expect(d.usable).toBe(true);
  });
});
