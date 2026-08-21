/**
 * Executor integration: a validated plan drives the same domain commands the
 * manual UI uses, grouped into one undo step. Generation steps are covered
 * by the AI-layer tests; here we run the composition tools end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "./executor";
import { resolveAgentScope } from "./scope";
import { validatePlan } from "./tools/schemas";

const seedIds: { crying?: string } = {};

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
    metadata: { characterId: akari.characterId, pose: "running", expression: "neutral", outfit: "default outfit", view: "front", characterAssetRole: "state" },
  });
  doc = asset.doc;
  const crying = addAsset(doc, {
    category: "character",
    name: "Akari crying",
    storageUrl: "https://example.com/cry.png",
    width: 800,
    height: 1600,
    metadata: { characterId: akari.characterId, pose: "running", expression: "crying", outfit: "default outfit", view: "front", characterAssetRole: "state" },
  });
  doc = crying.doc;
  seedIds.crying = crying.assetId;
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

  it("set_character_slot reuses an existing slot asset on the SELECTED instance (no generation)", async () => {
    // Place Akari (running/neutral) in panel 1 and select her.
    const place = validatePlan({
      summary: "place",
      steps: [{ tool: "place_asset", args: { panel: 1, characterName: "Akari", pose: "running" } }],
    }).plan;
    await executePlan(place, () => {});
    const state = useEditorStore.getState();
    const doc = state.doc!;
    const instanceId = Object.keys(doc.items)[0];
    const before = doc.items[instanceId] as AssetInstance;
    state.select({ itemId: instanceId, panelId: before.panelId });

    // "Make her cry" — no panel/name given: the selection is the target.
    const { plan } = validatePlan({
      summary: "make her cry",
      steps: [{ tool: "set_character_slot", args: { expression: "crying" } }],
    });
    const failures: string[] = [];
    const summary = await executePlan(plan, (_index, status, detail) => {
      if (status === "failed" && detail) failures.push(detail);
    });
    expect(failures).toEqual([]);
    expect(summary.failed).toBe(0);

    const after = useEditorStore.getState().doc!.items[instanceId] as AssetInstance;
    expect(after.sourceAssetId).toBe(seedIds.crying);
    expect(after.characterState).toMatchObject({ pose: "running", expression: "crying" });
    // Composition preserved: same panel, same slot in the stack.
    expect(after.panelId).toBe(before.panelId);
    // Reuse, not regeneration: no generation history entries were added.
    expect(useEditorStore.getState().doc!.generationHistory).toHaveLength(0);
  });

  it("reshape_panel turns a rectangle into a polygon that survives in state", async () => {
    const { plan } = validatePlan({
      summary: "diagonal cut",
      steps: [
        {
          tool: "reshape_panel",
          args: {
            panel: 1,
            points: [
              { x: 0.03, y: 0.03 },
              { x: 0.97, y: 0.03 },
              { x: 0.6, y: 0.5 },
              { x: 0.03, y: 0.5 },
            ],
          },
        },
      ],
    });
    const summary = await executePlan(plan, () => {});
    expect(summary.failed).toBe(0);
    const doc = useEditorStore.getState().doc!;
    const panel = doc.panels[Object.values(doc.pages)[0].panelIds[0]];
    expect(panel.points).toHaveLength(4);
    expect(panel.points[2]).toEqual({ x: 0.6, y: 0.5 });
  });

  it("place_asset target:'workspace' stages a loose item instead of touching panels", async () => {
    const { plan } = validatePlan({
      summary: "stage reference",
      steps: [{ tool: "place_asset", args: { target: "workspace", characterName: "Akari" } }],
    });
    const summary = await executePlan(plan, () => {});
    expect(summary.failed).toBe(0);
    const doc = useEditorStore.getState().doc!;
    expect(Object.keys(doc.workspaceItems)).toHaveLength(1);
    expect(Object.keys(doc.items)).toHaveLength(0);
  });

  it("changes only selected Panel 1 and reuses Yuri's cached walking state", async () => {
    let doc = createProjectDocument("Panel scope acceptance");
    const yuri = addCharacter(doc, "Yuri", "dark-haired student");
    doc = yuri.doc;
    const walking = addAsset(doc, {
      category: "character",
      name: "Cached locomotion render",
      storageUrl: "https://example.com/yuri-walking.png",
      width: 800,
      height: 1600,
      metadata: {
        characterId: yuri.characterId,
        characterAssetRole: "state",
        pose: "walking",
        expression: "smile",
        outfit: "school uniform",
        view: "side",
      },
    });
    doc = walking.doc;
    const background = addAsset(doc, {
      category: "background",
      name: "Neighborhood street",
      storageUrl: "https://example.com/street.png",
      width: 2000,
      height: 1400,
    });
    doc = background.doc;
    useEditorStore.getState().loadDocument(doc);
    const page = Object.values(doc.pages)[0];
    useEditorStore.getState().select({ panelId: page.panelIds[0] });
    const untouched = page.panelIds.slice(1).map((id) => doc.panels[id].itemIds);
    const scope = resolveAgentScope({
      doc,
      currentPageId: page.id,
      selection: { panelId: page.panelIds[0] },
      prompt: "In this panel, add a background, place Yuri walking, and add a thought bubble about the upcoming walk.",
    });
    const validation = validatePlan({
      summary: "Complete selected panel",
      steps: [
        { tool: "place_asset", args: { panel: 1, category: "background", cropMode: "fill" } },
        { tool: "place_character", args: { panel: 1, characterName: "Yuri", pose: "walking" } },
        { tool: "add_speech_bubble", args: { panel: 1, bubbleType: "thought", text: "The walk is coming up…" } },
        { tool: "add_effect", args: { panel: 2, effectKind: "focus-lines" } },
      ],
    }, scope);
    expect(validation.rejected).toHaveLength(1);

    const summary = await executePlan(validation.plan, () => {});
    expect(summary).toMatchObject({ completed: 3, failed: 0, validationIssues: [], rolledBack: false });
    const after = useEditorStore.getState().doc!;
    expect(page.panelIds.slice(1).map((id) => after.panels[id].itemIds)).toEqual(untouched);
    const panelItems = after.panels[page.panelIds[0]].itemIds.map((id) => after.items[id]);
    const characterInstance = panelItems.find((item) => item.kind === "asset" && after.assets[item.sourceAssetId].category === "character");
    expect(characterInstance?.kind).toBe("asset");
    if (characterInstance?.kind === "asset") expect(characterInstance.sourceAssetId).toBe(walking.assetId);
    expect(panelItems.some((item) => item.kind === "bubble" && item.bubbleType === "thought")).toBe(true);
    expect(after.generationHistory).toHaveLength(0);
  });

  it("semantically composes a cached Character and reuses exact scene continuity inside scope", async () => {
    const state = useEditorStore.getState();
    let doc = state.doc!;
    const page = Object.values(doc.pages)[0];
    const background = Object.values(doc.assets).find((asset) => asset.category === "background")!;
    state.dispatch({ type: "set-panel-background", panelId: page.panelIds[0], assetId: background.id, location: "School gate" });
    doc = useEditorStore.getState().doc!;
    useEditorStore.getState().select({ panelId: page.panelIds[1] });
    const scope = resolveAgentScope({
      doc,
      currentPageId: page.id,
      selection: { panelId: page.panelIds[1] },
      prompt: "In this panel, show Akari running past the same school gate.",
    });
    const untouched = page.panelIds.filter((id) => id !== page.panelIds[1]).slice(1).map((id) => doc.panels[id].itemIds);
    const { plan, rejected } = validatePlan({
      summary: "Continue the scene",
      steps: [
        { tool: "reuse_scene_background", args: { sourcePanel: 1, targetPanel: 2 } },
        { tool: "compose_character", args: { panel: 2, characterName: "Akari", pose: "running", framing: "medium", position: "right", facing: "left", role: "runner" } },
        { tool: "add_scene_relationship", args: { panel: 2, subjectCharacterName: "Akari", action: "runs past the gate" } },
      ],
    }, scope);
    expect(rejected).toEqual([]);

    const semanticFailures: string[] = [];
    const summary = await executePlan(plan, (_index, status, detail) => {
      if (status === "failed" && detail) semanticFailures.push(detail);
    });
    expect(semanticFailures).toEqual([]);
    expect(summary.failed).toBe(0);
    const after = useEditorStore.getState().doc!;
    expect(after.scenes[page.panelIds[1]].backgroundAssetId).toBe(background.id);
    expect(after.scenes[page.panelIds[1]].continuity?.backgroundSourcePanelId).toBe(page.panelIds[0]);
    expect(after.scenes[page.panelIds[1]].characters[0]).toMatchObject({
      semanticPosition: "right",
      facing: "left",
      role: "runner",
    });
    expect(after.scenes[page.panelIds[1]].relationships[0]?.action).toBe("runs past the gate");
    expect(page.panelIds.filter((id) => id !== page.panelIds[1]).slice(1).map((id) => after.panels[id].itemIds)).toEqual(untouched);
    expect(after.generationHistory).toHaveLength(0);
  });

  it("rechecks scope at runtime and blocks a tool injected after validation", async () => {
    const state = useEditorStore.getState();
    const doc = state.doc!;
    const page = Object.values(doc.pages)[0];
    state.select({ panelId: page.panelIds[0] });
    const scope = resolveAgentScope({
      doc,
      currentPageId: page.id,
      selection: { panelId: page.panelIds[0] },
      prompt: "make this panel dramatic",
    });
    const { plan } = validatePlan({
      summary: "scoped",
      steps: [{ tool: "add_effect", args: { panel: 1, effectKind: "focus-lines" } }],
    }, scope);
    plan.steps.push({ tool: "add_effect", args: { panel: 2, effectKind: "impact-burst" } });
    const details: string[] = [];
    const summary = await executePlan(plan, (_index, status, detail) => {
      if (status === "failed" && detail) details.push(detail);
    });
    expect(summary).toMatchObject({ completed: 1, failed: 1, validationIssues: [], rolledBack: false });
    expect(details[0]).toContain("Scope violation");
    expect(useEditorStore.getState().doc!.panels[page.panelIds[1]].itemIds).toHaveLength(0);
  });

  it("generates a recoverable missing character state and places the new reusable asset", async () => {
    let doc = createProjectDocument("Missing state");
    const yuri = addCharacter(doc, "Yuri");
    doc = yuri.doc;
    useEditorStore.getState().loadDocument(doc);
    const page = Object.values(doc.pages)[0];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: { referenceImage: false } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: "https://example.com/generated-yuri.png",
            sourceUrl: "https://example.com/generated-yuri.png",
            processedImageUrl: "https://example.com/generated-yuri-alpha.png",
            mimeType: "image/png",
            hasAlpha: true,
            backgroundRemoved: true,
            processingStatus: "ready",
            provider: "test-provider",
            model: "test-model",
            referenceUsed: false,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    class MockImage {
      naturalWidth = 800;
      naturalHeight = 1600;
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    vi.stubGlobal("Image", MockImage);

    const scope = resolveAgentScope({ doc, currentPageId: page.id, selection: { panelId: page.panelIds[0] }, prompt: "Yuri backflips here" });
    const { plan } = validatePlan({
      summary: "Generate missing state",
      steps: [{ tool: "place_character", args: { panel: 1, characterName: "Yuri", pose: "backflip" } }],
    }, scope);
    const summary = await executePlan(plan, () => {});
    expect(summary).toMatchObject({ completed: 1, failed: 0, validationIssues: [], rolledBack: false });
    const after = useEditorStore.getState().doc!;
    expect(after.generationHistory).toHaveLength(1);
    const generated = Object.values(after.assets).find((asset) => asset.metadata?.pose === "backflip");
    expect(generated?.metadata).toMatchObject({ characterId: yuri.characterId, characterAssetRole: "state" });
    const placedId = after.panels[page.panelIds[0]].itemIds[0];
    const placed = after.items[placedId];
    expect(placed.kind === "asset" ? placed.sourceAssetId : null).toBe(generated?.id);
  });

  it("preserves a failed generated source but waits for a ready cutout before composition", async () => {
    let doc = createProjectDocument("Failed cutout");
    const yuri = addCharacter(doc, "Yuri");
    doc = yuri.doc;
    useEditorStore.getState().loadDocument(doc);
    const page = Object.values(doc.pages)[0];
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: { referenceImage: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: "https://example.com/generated-yuri.jpg",
        sourceUrl: "https://example.com/generated-yuri.jpg",
        mimeType: "image/jpeg",
        hasAlpha: false,
        backgroundRemoved: false,
        processingStatus: "failed",
        processingReason: "Opaque checkerboard detected, but no reliable foreground could be extracted",
        provider: "test-provider",
        model: "test-model",
        referenceUsed: false,
      }), { status: 200 })));
    class MockImage {
      naturalWidth = 800;
      naturalHeight = 1600;
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    }
    vi.stubGlobal("Image", MockImage);

    const { plan } = validatePlan({
      summary: "Generate then compose",
      steps: [
        { tool: "generate_character_asset", args: { characterName: "Yuri", kind: "pose", pose: "jumping" } },
        { tool: "compose_character", args: { panel: 1, characterName: "Yuri", pose: "jumping" } },
      ],
    });
    const failures: string[] = [];
    const summary = await executePlan(plan, (_index, status, detail) => {
      if (status === "failed" && detail) failures.push(detail);
    });

    expect(summary.completed).toBe(0);
    // The composition step is never attempted: once the artwork it was going to
    // place has failed to generate, continuing would compose around a hole.
    expect(summary.failed).toBe(1);
    expect(summary.rolledBack).toBe(true);
    const after = useEditorStore.getState().doc!;
    // A character whose background could not be removed never becomes a
    // library asset: an un-keyed image in the library is one drag away from
    // painting its opaque background into a panel.
    const failedAsset = Object.values(after.assets).find((asset) => asset.metadata?.pose === "jumping");
    expect(failedAsset).toBeUndefined();
    expect(after.panels[page.panelIds[0]].itemIds).toHaveLength(0);
    // The attempt is still recorded so the run is auditable.
    expect(after.generationHistory.some((record) => record.status === "failed")).toBe(true);
    expect(failures.join(" ").toLowerCase()).toContain("background removal");
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
