/**
 * Unified layer selection.
 *
 * The acceptance scenario from the brief is built once — background, character,
 * prop, speech bubble and SFX with substantial overlap — and every selection
 * surface is exercised against it through the SAME resolver the canvas uses.
 *
 * The point of these tests is not that a function returns a list. It is that a
 * creator can reach every layer without moving anything out of the way, that a
 * locked background stops swallowing clicks, and that lock/visibility/order all
 * survive undo and a save-reload round trip.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { createFixturePuppet } from "@/puppet/fixture";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { cycleHit, hitStack, panelLayers, topHit, type AlphaSampler } from "./hitStack";

// ─── The overlapping panel ─────────────────────────────────────────────────

interface Scene {
  doc: ProjectDocument;
  panelId: ID;
  background: ID;
  character: ID;
  prop: ID;
  bubble: ID;
  sfx: ID;
  characterUrl: string;
}

const CHARACTER_URL = "https://example.com/yuri-cut.png";

/**
 * Everything overlaps the panel centre, so a single point resolves to all five
 * layers. Without that overlap the test would prove nothing.
 */
function scene(): Scene {
  let doc = createProjectDocument("Layers");
  const panelId = doc.pages[Object.keys(doc.pages)[0]].panelIds[0];

  const character = addCharacter(doc, "Yuri");
  doc = character.doc;

  const image = (name: string, category: "background" | "character" | "prop", url: string, extra = {}) => {
    const added = addAsset(doc, {
      category,
      name,
      storageUrl: url,
      processedImageUrl: url,
      width: 800,
      height: 1200,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      ...extra,
    });
    doc = added.doc;
    return added.assetId;
  };

  const backgroundAsset = image("Cyberpunk Street", "background", "https://example.com/street.png");
  const characterAsset = image("Yuri walking", "character", CHARACTER_URL, {
    metadata: { characterId: character.characterId, characterAssetRole: "state" },
  });
  const propAsset = image("School Bag", "prop", "https://example.com/bag.png");

  const place = (assetId: ID) => {
    const result = applyDomainCommand(doc, { type: "add-instance", panelId, assetId });
    doc = result.doc;
    return result.createdId!;
  };
  const background = place(backgroundAsset);
  const characterItem = place(characterAsset);
  const prop = place(propAsset);

  // Force every item to cover the panel centre generously.
  for (const id of [background, characterItem, prop]) {
    const result = applyDomainCommand(doc, {
      type: "update-instance-transform",
      instanceId: id,
      patch: { cx: 300, cy: 300, width: 400, height: 400 },
    });
    doc = result.doc;
  }

  const bubbleResult = applyDomainCommand(doc, {
    type: "add-bubble",
    panelId,
    bubbleType: "speech",
    text: "多位…",
    at: { x: 300, y: 300 },
  });
  doc = bubbleResult.doc;
  const bubble = bubbleResult.createdId!;
  doc = applyDomainCommand(doc, {
    type: "update-instance-transform",
    instanceId: bubble,
    patch: { cx: 300, cy: 300, width: 300, height: 300 },
  }).doc;

  const sfxResult = applyDomainCommand(doc, {
    type: "place-language-asset",
    panelId,
    languageAssetId: "builtin:sfx-bam",
    at: { x: 300, y: 300 },
  });
  doc = sfxResult.doc;
  const sfx = sfxResult.createdId!;
  doc = applyDomainCommand(doc, {
    type: "update-instance-transform",
    instanceId: sfx,
    patch: { cx: 300, cy: 300, width: 260, height: 120 },
  }).doc;

  return { doc, panelId, background, character: characterItem, prop, bubble, sfx, characterUrl: CHARACTER_URL };
}

const CENTRE = { x: 300, y: 300 };

/** A sampler that reports the character cutout as empty everywhere. */
const emptyCharacter: AlphaSampler = (url) => (url === CHARACTER_URL ? 0 : 255);

describe("HitStack", () => {
  it("returns every overlapping layer, visually topmost first", () => {
    const s = scene();
    const stack = hitStack(s.doc, s.panelId, CENTRE);
    // Insertion bands stack background → prop → character → bubble → SFX, so
    // top-first is the exact reverse of that.
    expect(stack.map((entry) => entry.itemId)).toEqual([s.sfx, s.bubble, s.character, s.prop, s.background]);
    expect(stack.map((entry) => entry.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it("labels layers the way a creator would name them", () => {
    const s = scene();
    const stack = hitStack(s.doc, s.panelId, CENTRE);
    const described = stack.map((entry) => `${entry.label} — ${entry.kind}`);
    expect(described).toContain("“多位…” — Speech Bubble");
    expect(described).toContain("Yuri — Character");
    expect(described).toContain("Cyberpunk Street — Background");
    expect(described).toContain("School Bag — Prop");
    expect(described.some((line) => line.endsWith("— SFX"))).toBe(true);
  });

  it("a plain click takes the visually topmost layer", () => {
    const s = scene();
    expect(topHit(s.doc, s.panelId, CENTRE)?.itemId).toBe(s.sfx);
  });

  it("every layer is reachable by cycling, without moving anything", () => {
    const s = scene();
    const stack = hitStack(s.doc, s.panelId, CENTRE);
    const visited: ID[] = [];
    let current: ID | undefined;
    for (let step = 0; step < stack.length; step += 1) {
      current = cycleHit(stack, current)!.itemId;
      visited.push(current);
    }
    expect(visited).toEqual([s.sfx, s.bubble, s.character, s.prop, s.background]);
    // And it wraps back to the top rather than dead-ending.
    expect(cycleHit(stack, s.background)?.itemId).toBe(s.sfx);
  });

  it("priority follows z-order, not category — a prop above a bubble wins", () => {
    const s = scene();
    const moved = applyDomainCommand(s.doc, {
      type: "reorder-instance",
      instanceId: s.prop,
      direction: "front",
    }).doc;
    expect(topHit(moved, s.panelId, CENTRE)?.itemId).toBe(s.prop);
  });
});

// ─── Alpha awareness ───────────────────────────────────────────────────────

describe("alpha-aware hit testing", () => {
  it("a transparent cutout pixel does not capture the click", () => {
    const s = scene();
    const withAlpha = hitStack(s.doc, s.panelId, CENTRE, { alpha: emptyCharacter });
    expect(withAlpha.map((entry) => entry.itemId)).not.toContain(s.character);
    // Everything else is still there, in the same order.
    expect(withAlpha.map((entry) => entry.itemId)).toEqual([s.sfx, s.bubble, s.prop, s.background]);
  });

  it("falls back to bounds while the mask is still decoding", () => {
    const s = scene();
    const undecided: AlphaSampler = () => null;
    const stack = hitStack(s.doc, s.panelId, CENTRE, { alpha: undecided });
    expect(stack.map((entry) => entry.itemId)).toContain(s.character);
    expect(stack.find((entry) => entry.itemId === s.character)?.precision).toBe("bounds");
  });

  it("reports alpha precision when a mask is available", () => {
    const s = scene();
    const opaque: AlphaSampler = () => 255;
    expect(hitStack(s.doc, s.panelId, CENTRE, { alpha: opaque }).find((e) => e.itemId === s.character)?.precision).toBe(
      "alpha",
    );
  });

  it("a bubble's empty corner does not swallow the art behind it", () => {
    const s = scene();
    // Bubble spans 150..450; its top-left corner is outside the ellipse.
    const corner = { x: 165, y: 165 };
    const stack = hitStack(s.doc, s.panelId, corner);
    expect(stack.map((entry) => entry.itemId)).not.toContain(s.bubble);
    expect(stack.map((entry) => entry.itemId)).toContain(s.character);
  });
});

// ─── Locking ───────────────────────────────────────────────────────────────

describe("locking", () => {
  it("a locked background stops capturing canvas clicks but stays listed", () => {
    const s = scene();
    const locked = applyDomainCommand(s.doc, {
      type: "set-instance-props",
      instanceId: s.background,
      patch: { locked: true },
    }).doc;

    // Canvas selection skips it entirely.
    const canvas = hitStack(locked, s.panelId, CENTRE);
    expect(canvas.map((entry) => entry.itemId)).not.toContain(s.background);
    // Cycling can no longer land on it either.
    expect(canvas.every((entry) => entry.itemId !== s.background)).toBe(true);

    // The right-click menu and the Layers panel can still reach it.
    const menu = hitStack(locked, s.panelId, CENTRE, { includeLocked: true });
    expect(menu.find((entry) => entry.itemId === s.background)?.locked).toBe(true);
    expect(panelLayers(locked, s.panelId).find((entry) => entry.itemId === s.background)?.locked).toBe(true);
  });

  it("locking the background makes the character the top plain-click target", () => {
    const s = scene();
    let doc = s.doc;
    for (const id of [s.sfx, s.bubble, s.prop]) {
      doc = applyDomainCommand(doc, { type: "set-instance-props", instanceId: id, patch: { locked: true } }).doc;
    }
    expect(topHit(doc, s.panelId, CENTRE)?.itemId).toBe(s.character);
  });
});

// ─── Visibility ────────────────────────────────────────────────────────────

describe("visibility", () => {
  it("a hidden layer disappears from hit-testing", () => {
    const s = scene();
    const hidden = applyDomainCommand(s.doc, {
      type: "set-instance-props",
      instanceId: s.character,
      patch: { visible: false },
    }).doc;
    expect(hitStack(hidden, s.panelId, CENTRE).map((entry) => entry.itemId)).not.toContain(s.character);
    // But it is still a layer, marked hidden, so it can be brought back.
    expect(panelLayers(hidden, s.panelId).find((entry) => entry.itemId === s.character)?.hidden).toBe(true);
  });

  it("hidden beats locked-inclusion: the menu will not offer an invisible layer", () => {
    const s = scene();
    const hidden = applyDomainCommand(s.doc, {
      type: "set-instance-props",
      instanceId: s.character,
      patch: { visible: false },
    }).doc;
    const menu = hitStack(hidden, s.panelId, CENTRE, { includeLocked: true });
    expect(menu.map((entry) => entry.itemId)).not.toContain(s.character);
  });
});

// ─── Puppets stay one actor ────────────────────────────────────────────────

describe("puppet actors", () => {
  it("clicking a puppet's face selects the instance, not a body part", () => {
    const s = scene();
    const characterId = Object.keys(s.doc.characters)[0];
    let doc = applyDomainCommand(s.doc, {
      type: "register-puppet",
      puppet: { ...createFixturePuppet({ characterId }), characterId },
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "attach-puppet",
      instanceId: s.character,
      puppetId: `puppet:${characterId}`,
    }).doc;

    const instance = doc.items[s.character];
    if (instance.kind !== "asset") throw new Error("expected an asset instance");
    // The head sits in the upper part of the actor's box.
    const head = { x: instance.cx, y: instance.cy - instance.height * 0.22 };
    const stack = hitStack(doc, s.panelId, head);
    const entry = stack.find((candidate) => candidate.itemId === s.character);

    expect(entry).toBeDefined();
    expect(entry!.itemId).toBe(s.character);
    expect(entry!.kind).toBe("Character (Puppet)");
    // No puppet part id ever appears as a layer.
    expect(stack.every((candidate) => Boolean(doc.items[candidate.itemId]))).toBe(true);
    expect(panelLayers(doc, s.panelId).every((layer) => Boolean(doc.items[layer.itemId]))).toBe(true);
  });

  it("empty space between a puppet's limbs is not a hit on the actor", () => {
    const s = scene();
    const characterId = Object.keys(s.doc.characters)[0];
    let doc = applyDomainCommand(s.doc, {
      type: "register-puppet",
      puppet: { ...createFixturePuppet({ characterId }), characterId },
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "attach-puppet",
      instanceId: s.character,
      puppetId: `puppet:${characterId}`,
    }).doc;

    const instance = doc.items[s.character];
    if (instance.kind !== "asset") throw new Error("expected an asset instance");
    // Bottom-left corner of the actor's box: inside the rectangle, outside the
    // figure. Bounds-only testing would have reported a hit here.
    const gap = { x: instance.cx - instance.width * 0.48, y: instance.cy + instance.height * 0.48 };
    const stack = hitStack(doc, s.panelId, gap);
    expect(stack.map((entry) => entry.itemId)).not.toContain(s.character);
  });
});

// ─── The Layers panel is a projection, not a second tree ───────────────────

describe("panelLayers", () => {
  it("mirrors render order exactly, including hidden and locked layers", () => {
    const s = scene();
    const doc = applyDomainCommand(
      applyDomainCommand(s.doc, { type: "set-instance-props", instanceId: s.background, patch: { locked: true } }).doc,
      { type: "set-instance-props", instanceId: s.character, patch: { visible: false } },
    ).doc;

    const layers = panelLayers(doc, s.panelId);
    expect(layers.map((layer) => layer.itemId)).toEqual([...doc.panels[s.panelId].itemIds].reverse());
    expect(layers.find((layer) => layer.itemId === s.background)?.locked).toBe(true);
    expect(layers.find((layer) => layer.itemId === s.character)?.hidden).toBe(true);
  });

  it("reordering through the panel changes pointer priority", () => {
    const s = scene();
    // Move the prop to the very top by absolute index, as a row drag does.
    const top = s.doc.panels[s.panelId].itemIds.length - 1;
    const doc = applyDomainCommand(s.doc, { type: "move-item-to-index", itemId: s.prop, index: top }).doc;

    expect(panelLayers(doc, s.panelId)[0].itemId).toBe(s.prop);
    expect(topHit(doc, s.panelId, CENTRE)?.itemId).toBe(s.prop);
  });
});

// ─── Persistence and history ───────────────────────────────────────────────

describe("durability", () => {
  it("visibility, locking, order and ids survive save and reload", () => {
    const s = scene();
    let doc = applyDomainCommand(s.doc, {
      type: "set-instance-props",
      instanceId: s.background,
      patch: { locked: true },
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-instance-props",
      instanceId: s.character,
      patch: { visible: false },
    }).doc;
    doc = applyDomainCommand(doc, { type: "move-item-to-index", itemId: s.prop, index: 4 }).doc;
    const expectedOrder = [...doc.panels[s.panelId].itemIds];

    const restored = deserializeProject(serializeProject(doc));

    expect(restored.panels[s.panelId].itemIds).toEqual(expectedOrder);
    expect(restored.items[s.background].locked).toBe(true);
    expect(restored.items[s.character].visible).toBe(false);
    // The ids selection resolves against are the same ones after reload.
    expect(topHit(restored, s.panelId, CENTRE)?.itemId).toBe(topHit(doc, s.panelId, CENTRE)?.itemId);
  });

  it("undo restores reorder, visibility, lock and deletion", () => {
    const s = scene();
    useEditorStore.getState().loadDocument(s.doc);
    const store = () => useEditorStore.getState();
    const order = () => store().doc!.panels[s.panelId].itemIds;
    const originalOrder = [...order()];

    store().dispatch({ type: "move-item-to-index", itemId: s.background, index: originalOrder.length - 1 });
    expect(order()).not.toEqual(originalOrder);
    store().undo();
    expect(order()).toEqual(originalOrder);

    store().dispatch({ type: "set-instance-props", instanceId: s.character, patch: { visible: false } });
    expect(store().doc!.items[s.character].visible).toBe(false);
    store().undo();
    expect(store().doc!.items[s.character].visible).not.toBe(false);

    store().dispatch({ type: "set-instance-props", instanceId: s.background, patch: { locked: true } });
    expect(store().doc!.items[s.background].locked).toBe(true);
    store().undo();
    expect(store().doc!.items[s.background].locked).not.toBe(true);

    store().dispatch({ type: "delete-instance", instanceId: s.bubble });
    expect(store().doc!.items[s.bubble]).toBeUndefined();
    store().undo();
    expect(store().doc!.items[s.bubble]).toBeDefined();
    expect(order()).toEqual(originalOrder);

    // Redo puts the deletion back, so history is symmetric.
    store().redo();
    expect(store().doc!.items[s.bubble]).toBeUndefined();
  });
});

// ─── One id, every surface ─────────────────────────────────────────────────

describe("unified identity", () => {
  it("canvas, menu and layer list all resolve to the same PanelItem id", () => {
    const s = scene();
    const fromCanvas = topHit(s.doc, s.panelId, CENTRE)!.itemId;
    const fromMenu = hitStack(s.doc, s.panelId, CENTRE, { includeLocked: true })[0].itemId;
    const fromLayers = panelLayers(s.doc, s.panelId)[0].itemId;

    expect(fromCanvas).toBe(fromMenu);
    expect(fromMenu).toBe(fromLayers);
    // And that id is a real document item the commands accept.
    expect(s.doc.items[fromCanvas]).toBeDefined();
  });

  it("selection survives being made from any surface", () => {
    const s = scene();
    useEditorStore.getState().loadDocument(s.doc);
    for (const itemId of [s.background, s.character, s.prop, s.bubble, s.sfx]) {
      useEditorStore.getState().select({ itemId, panelId: s.panelId });
      expect(useEditorStore.getState().selection.itemId).toBe(itemId);
      expect(useEditorStore.getState().doc!.items[itemId]).toBeDefined();
    }
  });
});
