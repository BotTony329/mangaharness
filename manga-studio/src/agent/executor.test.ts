/**
 * Executor integration: a validated plan drives the same domain commands the
 * manual UI uses, grouped into one undo step. Generation steps are covered
 * by the AI-layer tests; here we run the composition tools end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "./executor";
import { validatePlan } from "./tools/schemas";

function seedStore() {
  let doc = createProjectDocument("Agent E2E");
  const akari = addCharacter(doc, "Akari", "high school girl");
  doc = akari.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Akari running",
    storageUrl: "https://example.com/run.png",
    width: 800,
    height: 1600,
    metadata: { characterId: akari.characterId, pose: "running", expression: "happy" },
  });
  doc = asset.doc;
  const bg = addAsset(doc, {
    category: "background",
    name: "School gate",
    storageUrl: "https://example.com/gate.png",
    width: 2000,
    height: 1400,
  });
  useEditorStore.getState().loadDocument(bg.doc);
}

describe("executePlan", () => {
  beforeEach(() => {
    seedStore();
    // Provider status probe — no image provider needed for composition tools.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ capabilities: { referenceImage: false } }))),
    );
  });

  it("composes an editable page and groups it into one undo step", async () => {
    const before = useEditorStore.getState().doc!;
    const { plan } = validatePlan({
      summary: "Three-panel running scene",
      steps: [
        { tool: "set_page_layout", args: { layout: "three-vertical" } },
        { tool: "place_asset", args: { panel: 1, category: "background", cropMode: "fill" } },
        { tool: "place_asset", args: { panel: 1, characterName: "Akari", pose: "running" } },
        { tool: "place_asset", args: { panel: 3, characterName: "Akari" } },
        { tool: "set_crop_mode", args: { panel: 3, characterName: "Akari", mode: "upper-body" } },
        { tool: "add_speech_bubble", args: { panel: 2, bubbleType: "narration", text: "Late again…" } },
        { tool: "add_effect", args: { panel: 1, effectKind: "speed-lines" } },
      ],
    });

    const statuses: string[] = [];
    const summary = await executePlan(plan, (_i, status) => statuses.push(status));

    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(7);

    const doc = useEditorStore.getState().doc!;
    const page = Object.values(doc.pages)[0];
    expect(page.panelIds).toHaveLength(3);

    const panel1 = doc.panels[page.panelIds[0]];
    const panel3 = doc.panels[page.panelIds[2]];
    // Panel 1: background below character, effect above.
    expect(panel1.itemIds).toHaveLength(3);
    const kinds1 = panel1.itemIds.map((id) => {
      const item = doc.items[id];
      return item.kind === "asset" ? doc.assets[item.sourceAssetId].category : item.kind;
    });
    expect(kinds1).toEqual(["background", "character", "effect"]);

    // Panel 3: the same source asset, independently reframed to upper-body.
    const instance3 = panel3.itemIds.map((id) => doc.items[id]).find((i) => i.kind === "asset");
    expect(instance3?.kind).toBe("asset");
    if (instance3?.kind === "asset") expect(instance3.cropMode).toBe("upper-body");
    const instance1 = panel1.itemIds
      .map((id) => doc.items[id])
      .find((i) => i.kind === "asset" && doc.assets[i.sourceAssetId].category === "character");
    if (instance1?.kind === "asset" && instance3?.kind === "asset") {
      expect(instance1.sourceAssetId).toBe(instance3.sourceAssetId);
      expect(instance1.cropMode).not.toBe(instance3.cropMode);
    }

    // Whole run = one undo entry.
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc).toBe(before);
  });

  it("reports failed steps but keeps executing the rest", async () => {
    const { plan } = validatePlan({
      summary: "partially bad",
      steps: [
        { tool: "place_asset", args: { panel: 9, characterName: "Akari" } }, // no such panel
        { tool: "place_asset", args: { panel: 1, characterName: "Nobody" } }, // no such character
        { tool: "add_effect", args: { panel: 1, effectKind: "screentone" } }, // fine
      ],
    });
    const details: (string | undefined)[] = [];
    const summary = await executePlan(plan, (_i, status, detail) => {
      if (status === "failed") details.push(detail);
    });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(2);
    expect(details.join(" ")).toMatch(/Panel 9 does not exist/);
    expect(details.join(" ")).toMatch(/Nobody/);
  });
});
