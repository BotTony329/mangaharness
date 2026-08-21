/**
 * Golden cases for the Agent run-status contract.
 *
 * The banned outcome: "Done with 1 failed step and 0 validation warnings." —
 * a sentence that claims success while the page is missing something the
 * creator asked for. A run is now exactly one of:
 *
 *   COMPLETED             every required step landed, validation clean
 *   PARTIALLY_COMPLETED   a fallback ran, or a noncritical step was skipped —
 *                         and the creator is told what is missing
 *   FAILED                a required step failed with no legal fallback;
 *                         the page rolled back
 *
 * These run the real executor with the network stubbed; what they pin is the
 * STATUS SEMANTICS, not image quality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfAsset } from "@/characters/identity";
import { executePlan } from "./executor";
import { validatePlan } from "./tools/schemas";

class MockImage {
  naturalWidth = 900;
  naturalHeight = 1400;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    this.onload?.();
  }
}

function stubNetwork(generateFails: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/provider/status")) {
      return new Response(JSON.stringify({ capabilities: { referenceImage: true, supportsTransparentBackground: true } }), { status: 200 });
    }
    if (url.includes("/api/generate")) {
      if (generateFails) return new Response(JSON.stringify({ error: "provider exploded" }), { status: 500 });
      return new Response(
        JSON.stringify({
          url: "https://example.com/generated.png",
          sourceUrl: "https://example.com/generated.png",
          processedImageUrl: "https://example.com/generated-alpha.png",
          mimeType: "image/png",
          hasAlpha: true,
          backgroundRemoved: true,
          processingStatus: "ready",
          provider: "test-provider",
          model: "test-model",
          referenceUsed: true,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
}

function openProject(): { pageId: ID; panelIds: ID[] } {
  const doc = createProjectDocument("Run status");
  useEditorStore.getState().loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "two-vertical" });
  return { pageId, panelIds: useEditorStore.getState().doc!.pages[pageId].panelIds };
}

function withReadyCharacter(name: string): ID {
  const doc = useEditorStore.getState().doc!;
  const added = addCharacter(doc, name, `${name} description`);
  const canonical = addAsset(added.doc, {
    category: "character",
    name: `${name} canonical reference`,
    storageUrl: `https://example.com/${name}.png`,
    processedImageUrl: `https://example.com/${name}-alpha.png`,
    width: 900,
    height: 1400,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: added.characterId, characterAssetRole: "canonical", pose: "standing", expression: "neutral", outfit: "default outfit", view: "front" },
  });
  useEditorStore.getState().loadDocument({
    ...canonical.doc,
    characters: {
      ...canonical.doc.characters,
      [added.characterId]: { ...canonical.doc.characters[added.characterId], referenceAssetId: canonical.assetId },
    },
  });
  return added.characterId;
}

beforeEach(() => {
  vi.stubGlobal("Image", MockImage as unknown as typeof Image);
  useEditorStore.setState({ doc: null, undoStack: [], redoStack: [] } as never);
});

describe("CASE 1 — everything lands", () => {
  it("is COMPLETED, with no fallback and nothing skipped", async () => {
    openProject();
    stubNetwork(false);
    withReadyCharacter("Yuri");
    const { plan } = validatePlan({
      summary: "Place Yuri with a tone",
      steps: [
        { tool: "place_character", args: { panel: 1, characterName: "Yuri" } },
        { tool: "apply_tone", args: { panel: 1, presetId: "dot-30" } },
      ],
    });
    const summary = await executePlan(plan!, () => {});
    expect(summary.status).toBe("completed");
    expect(summary.fallbacks).toHaveLength(0);
    expect(summary.skippedSteps).toHaveLength(0);
    expect(summary.rolledBack).toBe(false);
  });
});

describe("CASE 2 — joint render fails, fallback composition succeeds", () => {
  it("is PARTIALLY_COMPLETED and names what is missing", async () => {
    const { panelIds } = openProject();
    stubNetwork(true); // every /api/generate call fails
    const yuriId = withReadyCharacter("Yuri");
    const moriId = withReadyCharacter("Mori");

    const { plan } = validatePlan({
      summary: "Yuri hugs Mori",
      steps: [
        { tool: "create_interaction", args: { panel: 1, interaction: "hug", subjectCharacterName: "Yuri", targetCharacterName: "Mori" } },
      ],
    });
    const summary = await executePlan(plan!, () => {});

    expect(summary.status).toBe("partially_completed");
    expect(summary.rolledBack).toBe(false);
    expect(summary.fallbacks).toHaveLength(1);
    expect(summary.fallbacks[0].detail).toMatch(/Approximate composition/i);

    // Both participants are on the page from their existing reusable assets.
    const after = useEditorStore.getState().doc!;
    const placedCharacterIds = after.panels[panelIds[0]].itemIds
      .map((id) => after.items[id])
      .filter((item) => item.kind === "asset")
      .map((item) => characterIdOfAsset(after, item.kind === "asset" ? item.sourceAssetId : undefined));
    expect(placedCharacterIds).toContain(yuriId);
    expect(placedCharacterIds).toContain(moriId);
  });
});

describe("CASE 3 — a required identity generation fails", () => {
  it("is FAILED and the page comes back untouched", async () => {
    const { panelIds } = openProject();
    stubNetwork(true);
    withReadyCharacter("Yuri");
    const before = useEditorStore.getState().doc!;

    const { plan } = validatePlan({
      summary: "Yuri backflips",
      steps: [{ tool: "place_character", args: { panel: 1, characterName: "Yuri", pose: "backflip" } }],
    });
    const summary = await executePlan(plan!, () => {});

    expect(summary.status).toBe("failed");
    expect(summary.rolledBack).toBe(true);
    expect(summary.abortReason).toBeTruthy();
    const after = useEditorStore.getState().doc!;
    expect(after.panels[panelIds[0]].itemIds).toHaveLength(0);
    expect(after.panels[panelIds[1]].itemIds).toHaveLength(before.panels[panelIds[1]].itemIds.length);
  });
});

describe("CASE 4 — decoration fails on an otherwise complete scene", () => {
  it("is PARTIALLY_COMPLETED: the scene survives, the failure is named", async () => {
    const { panelIds } = openProject();
    stubNetwork(false);
    withReadyCharacter("Yuri");

    const { plan } = validatePlan({
      summary: "Place Yuri, decorate",
      steps: [
        { tool: "place_character", args: { panel: 1, characterName: "Yuri" } },
        { tool: "add_effect", args: { panel: 9, effectKind: "impact-burst" } }, // no such panel
      ],
    });
    const summary = await executePlan(plan!, () => {});

    expect(summary.status).toBe("partially_completed");
    expect(summary.rolledBack).toBe(false);
    expect(summary.skippedSteps).toHaveLength(1);
    expect(summary.skippedSteps[0].message).toMatch(/Panel 9 does not exist/);
    expect(useEditorStore.getState().doc!.panels[panelIds[0]].itemIds.length).toBeGreaterThan(0);
  });
});
