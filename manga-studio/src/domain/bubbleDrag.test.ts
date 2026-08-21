/**
 * Moving a speech bubble.
 *
 * A bubble is body + text + tail, and the tail is stored as an absolute point.
 * Moving the body alone left the tail behind pointing at nothing — so "the
 * bubble moved" has to mean the whole object moved.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { applyDomainCommand } from "./commands";
import type { ID, ProjectDocument, SpeechBubbleItem } from "./types";

function page() {
  let doc: ProjectDocument = createProjectDocument("Bubble drag");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/y.png",
    processedImageUrl: "https://example.com/y-a.png",
    width: 800,
    height: 1400,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: yuri.characterId, characterAssetRole: "state", pose: "standing" },
  });
  doc = asset.doc;
  const pageId = Object.values(doc.pages)[0].id;
  const panelId = doc.pages[pageId].panelIds[0];
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: asset.assetId });
  doc = placed.doc;
  const bubble = applyDomainCommand(doc, { type: "add-bubble", panelId, bubbleType: "speech", text: "Hello" });
  return { doc: bubble.doc, panelId, bubbleId: bubble.createdId!, characterItemId: placed.createdId! };
}

const bubbleOf = (doc: ProjectDocument, id: ID) => doc.items[id] as SpeechBubbleItem;

describe("dragging a speech bubble", () => {
  it("moves the body through the same transform command every item uses", () => {
    const p = page();
    const before = bubbleOf(p.doc, p.bubbleId);
    const moved = applyDomainCommand(p.doc, {
      type: "update-instance-transform",
      instanceId: p.bubbleId,
      patch: { cx: before.cx + 100, cy: before.cy + 50 },
    }).doc;

    const after = bubbleOf(moved, p.bubbleId);
    expect(after.cx).toBe(before.cx + 100);
    expect(after.cy).toBe(before.cy + 50);
    // Text travels with it because it is a property of the same item.
    expect(after.text).toBe("Hello");
  });

  it("takes a free tail with it rather than leaving it behind", () => {
    const p = page();
    const withTail = applyDomainCommand(p.doc, {
      type: "update-bubble",
      itemId: p.bubbleId,
      patch: { tail: { x: 120, y: 300 } },
    }).doc;
    const before = bubbleOf(withTail, p.bubbleId);

    const moved = applyDomainCommand(withTail, {
      type: "update-instance-transform",
      instanceId: p.bubbleId,
      patch: { cx: before.cx + 100, cy: before.cy + 50 },
    }).doc;

    const after = bubbleOf(moved, p.bubbleId);
    expect(after.tail).toEqual({ x: 220, y: 350 });
  });

  it("leaves an ATTACHED tail to its semantic target instead of translating it", () => {
    const p = page();
    let doc = applyDomainCommand(p.doc, {
      type: "update-bubble",
      itemId: p.bubbleId,
      patch: { tail: { x: 120, y: 300 } },
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "attach-item",
      itemId: p.bubbleId,
      targetItemId: p.characterItemId,
    }).doc;
    const before = bubbleOf(doc, p.bubbleId);

    const moved = applyDomainCommand(doc, {
      type: "update-instance-transform",
      instanceId: p.bubbleId,
      patch: { cx: before.cx + 100, cy: before.cy + 50 },
    }).doc;

    // The tail still points at the speaker; the attachment owns it.
    expect(bubbleOf(moved, p.bubbleId).tail).toEqual({ x: 120, y: 300 });
  });

  it("does not disturb anything else on the page", () => {
    const p = page();
    const before = bubbleOf(p.doc, p.bubbleId);
    const moved = applyDomainCommand(p.doc, {
      type: "update-instance-transform",
      instanceId: p.bubbleId,
      patch: { cx: before.cx + 100, cy: before.cy + 50 },
    }).doc;

    expect(moved.items[p.characterItemId]).toEqual(p.doc.items[p.characterItemId]);
    expect(moved.panels[p.panelId].itemIds).toEqual(p.doc.panels[p.panelId].itemIds);
  });

  it("survives save and reload", async () => {
    const { deserializeProject, serializeProject } = await import("./serialization");
    const p = page();
    const before = bubbleOf(p.doc, p.bubbleId);
    const moved = applyDomainCommand(p.doc, {
      type: "update-instance-transform",
      instanceId: p.bubbleId,
      patch: { cx: before.cx + 100, cy: before.cy + 50 },
    }).doc;

    const restored = deserializeProject(serializeProject(moved));
    expect(bubbleOf(restored, p.bubbleId).cx).toBe(before.cx + 100);
    expect(bubbleOf(restored, p.bubbleId).cy).toBe(before.cy + 50);
  });
});
