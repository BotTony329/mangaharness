import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { placeAsset } from "@/domain/itemOps";
import { resolveAgentScope } from "./scope";
import { validatePlan, validateStepScope } from "./tools/schemas";

function scopedDocument() {
  let doc = createProjectDocument("Scope");
  const page = Object.values(doc.pages)[0];
  const character = addCharacter(doc, "Yuri");
  doc = character.doc;
  const asset = addAsset(doc, {
    category: "character",
    name: "Walk Cycle 03",
    storageUrl: "https://example.com/yuri-walk.png",
    width: 800,
    height: 1600,
    metadata: { characterId: character.characterId, pose: "walking", characterAssetRole: "state" },
  });
  doc = asset.doc;
  const placed = placeAsset(doc, page.panelIds[0], asset.assetId);
  return { doc: placed.doc, pageId: page.id, panelId: page.panelIds[0], itemId: placed.itemId };
}

describe("authoritative agent scope", () => {
  it("prioritizes selected object, then selected panel, then current page", () => {
    const { doc, pageId, panelId, itemId } = scopedDocument();
    expect(resolveAgentScope({ doc, currentPageId: pageId, selection: { panelId, itemId }, prompt: "make her smile" }).kind)
      .toBe("selected-object");
    expect(resolveAgentScope({ doc, currentPageId: pageId, selection: { panelId }, prompt: "add a thought" }).label)
      .toBe("Selected Panel · Panel 1");
    expect(resolveAgentScope({ doc, currentPageId: pageId, selection: {}, prompt: "add a thought" }).kind)
      .toBe("current-page");
  });

  it("expands a selected panel only when the prompt explicitly requests page/project scope", () => {
    const { doc, pageId, panelId } = scopedDocument();
    expect(resolveAgentScope({ doc, currentPageId: pageId, selection: { panelId }, prompt: "update all four panels" }).kind)
      .toBe("current-page");
    expect(resolveAgentScope({ doc, currentPageId: pageId, selection: { panelId }, prompt: "update the whole project" }).kind)
      .toBe("whole-project");
  });

  it("rejects cross-panel calls before execution", () => {
    const { doc, pageId, panelId } = scopedDocument();
    const scope = resolveAgentScope({ doc, currentPageId: pageId, selection: { panelId }, prompt: "change this panel" });
    const result = validatePlan({
      summary: "attempted spill",
      steps: [
        { tool: "add_effect", args: { panel: 1, effectKind: "focus-lines" } },
        { tool: "add_speech_bubble", args: { panel: 2, bubbleType: "thought", text: "No" } },
        { tool: "set_page_layout", args: { layout: "yonkoma" } },
      ],
    }, scope);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((entry) => entry.error.includes("Scope violation"))).toBe(true);
  });
});

describe("scope covers the virtual manga stage tools", () => {
  it("blocks camera, perspective, depth and bubble tools aimed at another panel", () => {
    const { doc, pageId, panelId } = scopedDocument();
    const page = doc.pages[pageId];
    const selectedPanelNumber = page.panelIds.indexOf(panelId) + 1;
    const otherPanelNumber = selectedPanelNumber === 1 ? 2 : 1;
    const scope = resolveAgentScope({
      doc,
      currentPageId: pageId,
      selection: { panelId },
      prompt: "make this dramatic",
    });
    expect(scope.kind).toBe("selected-panel");

    for (const step of [
      { tool: "set_camera", args: { panel: otherPanelNumber, shot: "close-up" } },
      { tool: "set_perspective", args: { panel: otherPanelNumber, type: "one-point" } },
      { tool: "set_character_depth", args: { panel: otherPanelNumber, depth: 0.8 } },
      { tool: "attach_bubble", args: { panel: otherPanelNumber, characterName: "Yuri", bubbleType: "speech", text: "hi" } },
    ]) {
      expect(validateStepScope(step.tool as never, step.args, scope)).toMatch(/Scope violation/);
    }
  });

  it("allows the same tools on the selected panel", () => {
    const { doc, pageId, panelId } = scopedDocument();
    const page = doc.pages[pageId];
    const panelNumber = page.panelIds.indexOf(panelId) + 1;
    const scope = resolveAgentScope({
      doc,
      currentPageId: pageId,
      selection: { panelId },
      prompt: "make this dramatic",
    });

    for (const step of [
      { tool: "set_camera", args: { panel: panelNumber, angle: "low" } },
      { tool: "set_perspective", args: { panel: panelNumber, type: "two-point" } },
      { tool: "set_character_depth", args: { panel: panelNumber, depth: 0.2 } },
      { tool: "attach_bubble", args: { panel: panelNumber, characterName: "Yuri", bubbleType: "shout", text: "hi" } },
    ]) {
      expect(validateStepScope(step.tool as never, step.args, scope)).toBeNull();
    }
  });

  it("rejects a panel number that does not exist on the page", () => {
    const { doc, pageId } = scopedDocument();
    const scope = resolveAgentScope({ doc, currentPageId: pageId, selection: {}, prompt: "set the camera" });
    expect(validateStepScope("set_camera" as never, { panel: 11, shot: "wide" }, scope)).toMatch(/outside/);
  });

  it("keeps a selected-object run away from panel-level camera changes", () => {
    const { doc, pageId, panelId, itemId } = scopedDocument();
    const scope = resolveAgentScope({
      doc,
      currentPageId: pageId,
      selection: { panelId, itemId },
      prompt: "make her angry",
    });
    expect(scope.kind).toBe("selected-object");
    // Selecting one character must not license restaging the whole panel.
    expect(validateStepScope("set_camera" as never, { panel: 1, shot: "close-up" }, scope)).toMatch(/Scope violation/);
  });
});
