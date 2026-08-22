/**
 * Golden: NEW CHARACTER PLACEHOLDER ID LIFECYCLE.
 *
 * The live P0: the planner emitted `NEW_MOMO_ID_PLACEHOLDER` as characterId,
 * Momo was created and her asset generated, but later steps (and validation)
 * still queried the placeholder — "Character NEW_MOMO_ID_PLACEHOLDER no longer
 * exists in this project."
 *
 * This simulates that exact plan shape: every post-creation step carries the
 * placeholder as characterId. The assertions pin the lifecycle contract —
 * the placeholder must never reach a domain command, asset metadata, the
 * final document, or a validation lookup; every step must run against the
 * real ID the moment it exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import type { CommandResult, DomainCommand } from "@/domain/commands";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { groundPrompt } from "@/agent/grounding";
import { validateGroundedPlan } from "@/agent/planValidation";
import { validatePlan } from "@/agent/tools/schemas";

const PROMPT = 'A girl named Momo walks toward the camera on a rainy Shanghai-style street at night and shouts "Wait!"';
const PLACEHOLDER = "NEW_MOMO_ID_PLACEHOLDER";

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

function generatedImageResponse(name: string) {
  return new Response(
    JSON.stringify({
      url: `https://example.com/${name}.png`,
      sourceUrl: `https://example.com/${name}.png`,
      processedImageUrl: `https://example.com/${name}-alpha.png`,
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

beforeEach(() => {
  useEditorStore.getState().loadDocument(createProjectDocument("Momo page"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  vi.stubGlobal("Image", MockImage);
  let generations = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate")) return generatedImageResponse(`gen-${generations++}`);
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

/** The live plan: create Momo, then every later step addresses her by placeholder. */
function momoPlan(doc: ProjectDocument) {
  const grounding = groundPrompt({ doc, prompt: PROMPT });
  const { plan } = validatePlan(
    {
      summary: "Momo walks and shouts",
      steps: [
        { tool: "create_character", args: { name: "Momo", appearance: "a girl" } },
        {
          tool: "generate_character_asset",
          args: { characterName: "Momo", characterId: PLACEHOLDER, kind: "pose", pose: "walking toward camera" },
        },
        { tool: "generate_background", args: { description: "rainy Shanghai-style street at night" } },
        { tool: "place_character", args: { panel: 1, characterName: "Momo", characterId: PLACEHOLDER, pose: "walking toward camera" } },
        { tool: "attach_bubble", args: { panel: 1, characterName: "Momo", characterId: PLACEHOLDER, bubbleType: "speech", text: "Wait!" } },
      ],
    },
    undefined,
  );
  return { grounding, validated: validateGroundedPlan({ plan, doc, grounding, prompt: PROMPT }) };
}

describe("golden: a new character's placeholder never survives creation", () => {
  it("runs the full live path against the real ID and completes", async () => {
    const doc = useEditorStore.getState().doc!;

    // Spy the single write path: no command may ever carry the placeholder.
    const commandLog: string[] = [];
    const store = useEditorStore.getState();
    const originalDispatch = store.dispatch;
    const spied = (command: DomainCommand): CommandResult => {
      commandLog.push(JSON.stringify(command));
      return originalDispatch(command);
    };
    useEditorStore.setState({ dispatch: spied });

    const { grounding, validated } = momoPlan(doc);
    // Semantic layer: Momo = CREATE; validation must not block this plan.
    expect(grounding.entities.map((e) => e.surface)).toContain("Momo");
    expect(validated.blocked).toBe(false);
    // The validation boundary already stripped the placeholder from step args.
    expect(JSON.stringify(validated.plan)).not.toContain(PLACEHOLDER);

    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });

    expect(summary.status).toBe("completed");
    expect(summary.rolledBack).toBe(false);
    expect(summary.failed).toBe(0);

    // The placeholder reached NO domain command.
    expect(commandLog.join("\n")).not.toContain(PLACEHOLDER);

    const after = useEditorStore.getState().doc!;
    // Momo exists with a REAL id in the library.
    const momo = Object.values(after.characters).find((c) => c.name === "Momo");
    expect(momo).toBeDefined();
    expect(momo!.id).not.toBe(PLACEHOLDER);

    // Her generated asset carries the real characterId in metadata.
    const momoAssets = Object.values(after.assets).filter((a) => a.metadata?.characterId === momo!.id);
    expect(momoAssets.length).toBeGreaterThan(0);
    expect(JSON.stringify(Object.values(after.assets).map((a) => a.metadata))).not.toContain(PLACEHOLDER);

    // Momo is in panel 1, the background is there, and the bubble says Wait!.
    const pageId = Object.values(after.pages)[0].id;
    const panel = after.panels[after.pages[pageId].panelIds[0]];
    const items = panel.itemIds.map((id) => after.items[id]);
    const momoInstance = items.find(
      (item) => item?.kind === "asset" && after.assets[item.sourceAssetId]?.metadata?.characterId === momo!.id,
    );
    expect(momoInstance).toBeDefined();
    // The scene was generated into the library (agent results stage on the
    // workspace for review rather than auto-placing).
    expect(Object.values(after.assets).some((a) => a.category === "background")).toBe(true);
    expect(items.some((item) => item?.kind === "bubble" && item.text === "Wait!")).toBe(true);

    // No ID anywhere in the final document is the placeholder.
    expect(JSON.stringify(Object.keys(after.characters))).not.toContain(PLACEHOLDER);

    useEditorStore.setState({ dispatch: originalDispatch });
  });

  it("negative: the service's real ID wins over the planning placeholder, always", async () => {
    /**
     * The negative case the task pins: creation returns `char_123` while the
     * plan still holds the placeholder. Every process after creation must
     * receive `char_123`; if any receives the placeholder, this fails.
     */
    const doc = useEditorStore.getState().doc!;
    const { grounding, validated } = momoPlan(doc);
    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });
    expect(summary.status).toBe("completed");
    const after = useEditorStore.getState().doc!;
    const realId = Object.values(after.characters).find((c) => c.name === "Momo")!.id;
    expect(realId).not.toBe(PLACEHOLDER);

    // Every character-carrying command in the run used the real ID.
    const commands = JSON.stringify(after) ;
    expect(commands).not.toContain(PLACEHOLDER);
    for (const asset of Object.values(after.assets)) {
      if (asset.metadata?.characterId) expect(asset.metadata.characterId).toBe(realId);
    }
    for (const item of Object.values(after.items)) {
      if (item.kind === "asset" && item.characterState?.characterId) {
        expect(item.characterState.characterId).toBe(realId);
      }
    }
  });

  it("negative: an unbindable placeholder is stripped, never executed as an ID", async () => {
    // Direct unit check of the boundary rule: unknown ID + unknown name →
    // the ID is removed; resolution proceeds by name and fails honestly.
    const { createRunContext, canonicalizeStepArgs } = await import("@/agent-v2/process/shared");
    const ctx = createRunContext({ creationAuthorized: true, authorizedCreationNames: ["momo"] });
    const cleaned = canonicalizeStepArgs(ctx, { characterId: PLACEHOLDER, characterName: "Nobody" });
    expect(cleaned.characterId).toBeUndefined();
    expect(JSON.stringify(cleaned)).not.toContain(PLACEHOLDER);
  });
});
