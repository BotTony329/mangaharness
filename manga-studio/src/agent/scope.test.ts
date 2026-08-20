import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { placeAsset } from "@/domain/itemOps";
import { resolveAgentScope } from "./scope";
import { validatePlan } from "./tools/schemas";

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
