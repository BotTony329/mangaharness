/**
 * Workspace-model guards: v1→v2 migration, polygon panel editing, loose
 * item ↔ panel instance conversion (coordinate-space crossings), and
 * semantic instance swapping.
 */

import { describe, expect, it } from "vitest";
import { panelBoundsPx } from "./coords";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { placeAsset, swapInstanceAsset } from "./itemOps";
import { movePanelPoint, reshapePanel } from "./panelOps";
import { deserializeProject, serializeProject } from "./serialization";
import {
  addWorkspaceItem,
  instanceToWorkspaceItem,
  updateWorkspaceItem,
  workspaceItemToInstance,
} from "./workspaceOps";
import type { AssetInstance, ProjectDocument } from "./types";

function seeded(): { doc: ProjectDocument; assetId: string; panelId: string } {
  const base = createProjectDocument("Workspace");
  const asset = addAsset(base, {
    category: "character",
    name: "Akari standing",
    storageUrl: "https://example.com/akari.png",
    width: 1000,
    height: 2000,
  });
  return { doc: asset.doc, assetId: asset.assetId, panelId: Object.keys(asset.doc.panels)[0] };
}

// ─── Schema migration ───────────────────────────────────────────────────────

describe("v1 → v2 migration", () => {
  it("converts rect panels to polygons and adds workspace fields", () => {
    const v1 = {
      schemaVersion: 1,
      project: {
        id: "p1",
        name: "Old",
        settings: { pageWidth: 1200, pageHeight: 1800, readingDirection: "rtl" },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      assets: {},
      characters: {},
      pages: { pg1: { id: "pg1", projectId: "p1", name: "Page 1", index: 0, panelIds: ["pn1"] } },
      panels: {
        pn1: {
          id: "pn1",
          pageId: "pg1",
          rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 },
          border: { visible: true, strokeWidthPx: 4, color: "#111" },
          itemIds: [],
        },
      },
      items: {},
      generationHistory: [],
    };
    const migrated = deserializeProject(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.panels.pn1.points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.6, y: 0.1 },
      { x: 0.6, y: 0.5 },
      { x: 0.1, y: 0.5 },
    ]);
    expect((migrated.panels.pn1 as unknown as { rect?: unknown }).rect).toBeUndefined();
    expect(migrated.pages.pg1.workspace).toEqual({ x: 0, y: 0 });
    expect(migrated.workspaceItems).toEqual({});
    expect(migrated.workspaceOrder).toEqual([]);
  });

  it("v2 documents round-trip losslessly", () => {
    const { doc, assetId } = seeded();
    const withLoose = addWorkspaceItem(doc, assetId, { x: 1600, y: 300 }).doc;
    expect(deserializeProject(serializeProject(withLoose))).toEqual(withLoose);
  });
});

// ─── Polygon panels ─────────────────────────────────────────────────────────

describe("panel reshaping", () => {
  it("moving a vertex makes the panel non-rectangular and shifts its bounds", () => {
    const { doc, panelId } = seeded();
    const before = panelBoundsPx(doc, doc.panels[panelId]);
    const next = movePanelPoint(doc, panelId, 2, { x: 0.9, y: 0.9 });
    expect(next.panels[panelId].points[2]).toEqual({ x: 0.9, y: 0.9 });
    expect(panelBoundsPx(next, next.panels[panelId])).not.toEqual(before);
    // Source doc untouched (clone-then-edit).
    expect(doc.panels[panelId].points[2]).not.toEqual({ x: 0.9, y: 0.9 });
  });

  it("reshape validates point count, clamps to the page, rejects degenerate shapes", () => {
    const { doc, panelId } = seeded();
    expect(() => reshapePanel(doc, panelId, [{ x: 0, y: 0 }])).toThrow(/points/);
    const clamped = reshapePanel(doc, panelId, [
      { x: -0.5, y: 0 },
      { x: 1.5, y: 0 },
      { x: 0.5, y: 2 },
    ]);
    expect(clamped.panels[panelId].points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 1 },
    ]);
    expect(() =>
      reshapePanel(doc, panelId, [
        { x: 0.2, y: 0.2 },
        { x: 0.2, y: 0.2 },
        { x: 0.2, y: 0.2 },
      ]),
    ).toThrow(/degenerate/);
  });
});

// ─── Loose items and conversions ────────────────────────────────────────────

describe("workspace items", () => {
  it("loose items live outside pages and never touch the source asset", () => {
    const { doc, assetId } = seeded();
    const { doc: d2, itemId } = addWorkspaceItem(doc, assetId, { x: 1500, y: 200 });
    expect(d2.workspaceItems[itemId].sourceAssetId).toBe(assetId);
    expect(d2.workspaceOrder).toContain(itemId);
    const d3 = updateWorkspaceItem(d2, itemId, { x: 1700, rotation: 12 });
    expect(d3.workspaceItems[itemId].x).toBe(1700);
    expect(JSON.stringify(d3.assets[assetId])).toBe(JSON.stringify(doc.assets[assetId]));
  });

  it("loose → panel instance conversion crosses coordinate spaces correctly", () => {
    const { doc, assetId, panelId } = seeded();
    const bounds = panelBoundsPx(doc, doc.panels[panelId]);
    const page = Object.values(doc.pages)[0];
    // Drop the loose item exactly at the panel's bbox center (workspace coords).
    const target = {
      x: page.workspace.x + bounds.x + bounds.width / 2,
      y: page.workspace.y + bounds.y + bounds.height / 2,
    };
    const { doc: d2, itemId } = addWorkspaceItem(doc, assetId, target);
    const { doc: d3, instanceId } = workspaceItemToInstance(d2, itemId, panelId);

    expect(d3.workspaceItems[itemId]).toBeUndefined();
    const instance = d3.items[instanceId] as AssetInstance;
    expect(instance.panelId).toBe(panelId);
    expect(instance.cx).toBeCloseTo(bounds.width / 2);
    expect(instance.cy).toBeCloseTo(bounds.height / 2);
    // Kept its workspace display size instead of snapping to a crop preset.
    expect(instance.width).toBe(d2.workspaceItems[itemId].width);
  });

  it("panel instance → loose conversion preserves the asset and removes the instance", () => {
    const { doc, assetId, panelId } = seeded();
    const placed = placeAsset(doc, panelId, assetId);
    const { doc: d2, itemId } = instanceToWorkspaceItem(placed.doc, placed.itemId);
    expect(d2.items[placed.itemId]).toBeUndefined();
    expect(d2.panels[panelId].itemIds).not.toContain(placed.itemId);
    expect(d2.workspaceItems[itemId].sourceAssetId).toBe(assetId);
    expect(d2.assets[assetId]).toBeDefined();
  });
});

// ─── Semantic instance swapping ─────────────────────────────────────────────

describe("swapInstanceAsset", () => {
  it("changes the source while preserving composition (position, panel, z)", () => {
    let { doc } = seeded();
    const character = addCharacter(doc, "Akari");
    doc = character.doc;
    const standing = addAsset(doc, {
      category: "character",
      name: "Akari standing",
      storageUrl: "https://example.com/stand.png",
      width: 1000,
      height: 2000,
      metadata: { characterId: character.characterId, pose: "standing" },
    });
    doc = standing.doc;
    const running = addAsset(doc, {
      category: "character",
      name: "Akari running",
      storageUrl: "https://example.com/run.png",
      width: 1600, // different aspect ratio on purpose
      height: 2000,
      metadata: { characterId: character.characterId, pose: "running" },
    });
    doc = running.doc;

    const panelId = Object.values(doc.pages)[0].panelIds[0];
    const placed = placeAsset(doc, panelId, standing.assetId);
    doc = placed.doc;
    const before = doc.items[placed.itemId] as AssetInstance;
    const zBefore = doc.panels[panelId].itemIds.indexOf(placed.itemId);

    doc = swapInstanceAsset(doc, placed.itemId, running.assetId);
    const after = doc.items[placed.itemId] as AssetInstance;

    expect(after.sourceAssetId).toBe(running.assetId);
    expect(after.panelId).toBe(panelId);
    expect(doc.panels[panelId].itemIds.indexOf(placed.itemId)).toBe(zBefore);
    // Non-custom crop mode recomputes for the new asset; still centered.
    expect(after.cropMode).toBe(before.cropMode);
    expect(after.cx).toBeCloseTo(before.cx);
    // The old source asset still exists untouched.
    expect(doc.assets[standing.assetId]).toBeDefined();
  });
});
