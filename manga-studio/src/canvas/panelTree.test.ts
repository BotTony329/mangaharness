/**
 * Layers hierarchy regression: a panel buried under its own content must be
 * selectable from Layers, through the SAME selection state the canvas uses.
 *
 * There is deliberately no component rendering here — the contract under test
 * is the one the UI depends on: `pagePanelTree` derives Page → Panel →
 * Objects from the document alone, and `select()` is the single entry point
 * both the canvas and the Layers tree call.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset } from "@/domain/libraryOps";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { pagePanelTree } from "@/canvas/hitStack";

interface Fixture {
  pageId: ID;
  panelIds: ID[];
  backgroundId: ID;
  characterInstanceId: ID;
  bubbleId: ID;
}

/** Panel 1 fully covered: background + character + bubble. */
function coveredPage(): Fixture {
  let doc: ProjectDocument = createProjectDocument("Layers golden");
  const background = addAsset(doc, {
    category: "background",
    name: "Street",
    storageUrl: "https://example.com/street.png",
    width: 2000,
    height: 1400,
  });
  doc = background.doc;
  const character = addAsset(doc, {
    category: "character",
    name: "Doubao",
    storageUrl: "https://example.com/doubao.png",
    processedImageUrl: "https://example.com/doubao-alpha.png",
    width: 900,
    height: 1400,
  });
  doc = character.doc;

  const store = useEditorStore.getState();
  store.loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  store.dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  const panelIds = useEditorStore.getState().doc!.pages[pageId].panelIds;
  const panelId = panelIds[0];
  store.dispatch({ type: "add-instance", panelId, assetId: background.assetId });
  const characterInstanceId = store.dispatch({ type: "add-instance", panelId, assetId: character.assetId }).createdId!;
  const bubbleId = store.dispatch({ type: "add-bubble", panelId, bubbleType: "speech", text: "Hi" }).createdId!;
  return { pageId, panelIds, backgroundId: background.assetId, characterInstanceId, bubbleId };
}

beforeEach(() => {
  coveredPage();
});

describe("CASE A — a covered panel is selectable from the tree", () => {
  it("selecting the panel node sets panelId, clears any object selection", () => {
    const fixture = coveredPage();
    const store = useEditorStore.getState();
    // Arrange: an object inside the panel is selected (what a canvas click would do).
    store.select({ itemId: fixture.characterInstanceId, panelId: fixture.panelIds[0] });

    // Act: exactly what the Layers tree's panel row calls.
    store.select({ panelId: fixture.panelIds[0] });

    const selection = useEditorStore.getState().selection;
    expect(selection.panelId).toBe(fixture.panelIds[0]);
    expect(selection.itemId).toBeUndefined();

    // The Inspector's panel branch predicate — same condition InspectorPanel uses.
    const doc = useEditorStore.getState().doc!;
    const showsPanelControls = Boolean(selection.panelId && doc.panels[selection.panelId]) && !selection.itemId;
    expect(showsPanelControls).toBe(true);
  });
});

describe("CASE B — a child object selects as an object", () => {
  it("selecting the character row keeps the panel hierarchy intact", () => {
    const fixture = coveredPage();
    const store = useEditorStore.getState();
    store.select({ itemId: fixture.characterInstanceId, panelId: fixture.panelIds[0] });

    const { selection, doc } = useEditorStore.getState();
    expect(selection.itemId).toBe(fixture.characterInstanceId);
    expect(selection.panelId).toBe(fixture.panelIds[0]);
    // The item still lives under the panel — hierarchy is not lost by selecting into it.
    expect(doc!.panels[fixture.panelIds[0]].itemIds).toContain(fixture.characterInstanceId);
  });
});

describe("CASE C — one selection source of truth", () => {
  it("canvas-style and layers-style writes land in the same state and read back identically", () => {
    const fixture = coveredPage();
    const store = useEditorStore.getState();

    // "Canvas" selects an object; the tree reads the same field.
    store.select({ itemId: fixture.characterInstanceId, panelId: fixture.panelIds[0] });
    expect(useEditorStore.getState().selection.itemId).toBe(fixture.characterInstanceId);

    // "Layers" selects the panel; the canvas reads the same field.
    store.select({ panelId: fixture.panelIds[0] });
    const selection = useEditorStore.getState().selection;
    expect(selection).toEqual({ panelId: fixture.panelIds[0] });
  });
});

describe("CASE D — hierarchy survives reload by derivation", () => {
  it("the same tree falls out of a reloaded document; nothing was persisted for it", () => {
    const fixture = coveredPage();
    const before = pagePanelTree(useEditorStore.getState().doc!, fixture.pageId);
    expect(before).toHaveLength(4);
    expect(before[0].children.map((c) => c.kind)).toHaveLength(3);
    expect(before[0].children.map((c) => c.label).join("|")).toContain("Doubao");
    expect(before[0].children.map((c) => c.label).join("|")).toContain("Street");

    // Serialize → reload, exactly what project persistence does.
    const reloaded: ProjectDocument = JSON.parse(JSON.stringify(useEditorStore.getState().doc));
    useEditorStore.getState().loadDocument(reloaded);
    const after = pagePanelTree(useEditorStore.getState().doc!, fixture.pageId);
    expect(after.map((n) => n.panelNumber)).toEqual([1, 2, 3, 4]);
    expect(after[0].children.map((c) => c.itemId)).toEqual(before[0].children.map((c) => c.itemId));
  });
});
