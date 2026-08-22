/**
 * Golden case J: the agent's local edit goes through the same route and the
 * same write path as the Asset Detail Editor UI.
 *
 * The assertions pin the product rules, not the pixels: the edit must hit
 * `/api/assets/edit` (the locality-enforcing route), the result must land as
 * a NEW asset with local-edit provenance, the placed instance must swap to
 * that variation, and the original asset must survive untouched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";

function composedPage() {
  let doc: ProjectDocument = createProjectDocument("Local edit page");
  const yuri = addCharacter(doc, "Yuri", "quiet second-year");
  doc = yuri.doc;
  const standing = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/yuri-standing.png",
    processedImageUrl: "https://example.com/yuri-standing-alpha.png",
    width: 900,
    height: 1400,
    hasAlpha: true,
    metadata: {
      characterId: yuri.characterId,
      pose: "standing",
      expression: "neutral",
      characterAssetRole: "state",
    },
  });
  doc = standing.doc;

  const store = useEditorStore.getState();
  store.loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  store.dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  const panelId = useEditorStore.getState().doc!.pages[pageId].panelIds[0];
  store.dispatch({ type: "add-instance", panelId, assetId: standing.assetId });
  return { characterId: yuri.characterId, assetId: standing.assetId, panelId };
}

describe("golden J: edit_asset_region uses the shared local-edit path", () => {
  beforeEach(() => {
    composedPage();
  });

  it("edits via /api/assets/edit, saves a variation, swaps the instance, keeps the original", async () => {
    const editBodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/assets/edit")) {
        editBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({ url: "https://example.com/yuri-red-jacket.png", editedPixels: 100, preservedPixels: 900 }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const before = useEditorStore.getState().doc!;
    const summary = await executePlan(
      {
        summary: "Recolour Yuri's jacket",
        targetScope: undefined,
        steps: [
          {
            tool: "edit_asset_region",
            args: { panel: 1, characterName: "Yuri", instruction: "Make the jacket red" },
          },
        ],
      } as never,
      () => {},
      { creationAuthorized: false, authorizedCreationNames: [] },
    );

    expect(summary.status).toBe("completed");
    expect(editBodies).toHaveLength(1);
    const request = JSON.parse(editBodies[0]);
    expect(request.instruction).toBe("Make the jacket red");
    expect(request.sourceUrl).toContain("yuri-standing");
    expect(request.maskPng.startsWith("data:image/png;base64,")).toBe(true);
    expect(request.preserveAlpha).toBe(true);

    const after = useEditorStore.getState().doc!;
    // The original asset survives untouched.
    expect(after.assets[beforeAssetId(before)]).toEqual(before.assets[beforeAssetId(before)]);
    // A new variation exists with local-edit provenance.
    const created = Object.values(after.assets).find((asset) => !before.assets[asset.id]);
    expect(created).toBeDefined();
    expect(created!.provenance?.localEdit?.parentAssetId).toBe(beforeAssetId(before));
    expect(created!.provenance?.localEdit?.intent).toBe("cosmetic");
    // The placed instance now renders the variation.
    const panelId = Object.values(after.pages)[0].panelIds[0];
    const instance = after.panels[panelId].itemIds
      .map((id) => after.items[id])
      .find((item) => item?.kind === "asset");
    expect(instance?.kind === "asset" && instance.sourceAssetId).toBe(created!.id);

    function beforeAssetId(doc: ProjectDocument) {
      return Object.values(doc.assets).find((asset) => asset.name === "Yuri standing")!.id;
    }
  });
});
