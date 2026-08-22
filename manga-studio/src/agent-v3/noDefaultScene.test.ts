/**
 * Golden: NO SEMANTIC EVIDENCE = NO CAPABILITY TASK.
 *
 * Pins the removal of the DEFAULT SCENE ASSUMPTION: pose/expression/tone/
 * camera/dialogue requests must compile with zero background steps, while an
 * explicitly stated place still generates one. Also pins the contract-boundary
 * guard that drops placeholder scene descriptions ("unspecified" & friends).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { parseCreativeTaskMap, type CreativeTaskMap } from "./contract/creativeTaskMap";
import { resolveTaskMap } from "./resolution/entityResolver";
import { compileTaskMap } from "./routing/capabilityRouter";

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

beforeEach(() => {
  useEditorStore.getState().loadDocument(createProjectDocument("no-default-scene"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate") || url.includes("/api/assets/edit")) {
      return new Response(
        JSON.stringify({
          url: "https://example.com/gen.png",
          sourceUrl: "https://example.com/gen.png",
          mimeType: "image/png",
          hasAlpha: true,
          processingStatus: "ready",
          provider: "test-provider",
          model: "test-model",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

function taskMap(raw: unknown): CreativeTaskMap {
  const { map, error } = parseCreativeTaskMap(raw);
  if (!map) throw new Error(`fixture invalid: ${error}`);
  return map;
}

function compile(raw: unknown) {
  const map = taskMap(raw);
  const resolution = resolveTaskMap(map, useEditorStore.getState().doc!);
  const { plan } = compileTaskMap(map, resolution);
  return { map, plan };
}

function backgroundSteps(plan: ReturnType<typeof compile>["plan"]) {
  return plan.steps.filter(
    (s) =>
      s.tool === "generate_background" ||
      (s.tool === "place_asset" && (s.args as { category?: string }).category === "background"),
  );
}

const BASE = {
  version: 1,
  intent: "modify_existing",
  participants: [{ name: "Kyoto", resolutionIntent: "existing", attributes: [], relationships: [] }],
  objects: [],
  effects: [],
  localEdits: [],
  target: { scope: "current_page" },
};

describe("no default scene assumption", () => {
  it("CASE 1: pose-only → no background task", () => {
    const { map, plan } = compile({
      ...BASE,
      summary: "Kyoto standing in a shy pose",
      beats: [{ panel: 1, actor: "Kyoto", action: "standing in a shy pose", poseDetails: [], expression: "shy" }],
    });
    expect(map.scene).toBeUndefined();
    expect(backgroundSteps(plan)).toEqual([]);
    expect(plan.steps.some((s) => s.tool === "generate_character_asset")).toBe(true);
  });

  it("CASE 2: expression-only → no background task", () => {
    const { plan } = compile({
      ...BASE,
      summary: "make Kyoto look shy",
      beats: [{ panel: 1, actor: "Kyoto", poseDetails: [], expression: "shy" }],
    });
    expect(backgroundSteps(plan)).toEqual([]);
  });

  it("CASE 3: tone-only → no scene, tone task exists and executes", async () => {
    const { map, plan } = compile({
      ...BASE,
      participants: [],
      summary: "generate a tone for daylight",
      beats: [],
      tone: { mood: "daylight" },
    });
    expect(map.scene).toBeUndefined();
    expect(backgroundSteps(plan)).toEqual([]);
    const toneSteps = plan.steps.filter((s) => s.tool === "apply_tone");
    expect(toneSteps).toHaveLength(1);
    const summary = await executePlan(plan, () => {}, { creationAuthorized: false, authorizedCreationNames: [] });
    expect(summary.status).toBe("completed");
    expect(summary.rolledBack).toBe(false);
  });

  it("CASE 4: camera-only → no background task", () => {
    const { plan } = compile({
      ...BASE,
      participants: [],
      summary: "make panel 1 low angle",
      beats: [],
      cameraIntent: { angle: "low", requiresRedraw: true },
    });
    expect(backgroundSteps(plan)).toEqual([]);
    expect(plan.steps.some((s) => s.tool === "set_camera")).toBe(true);
  });

  it("CASE 5: dialogue-only → no background task", () => {
    const { plan } = compile({
      ...BASE,
      summary: 'add "Wait!"',
      beats: [{ panel: 1, actor: "Kyoto", poseDetails: [], dialogue: "Wait!", dialogueKind: "speech" }],
    });
    expect(backgroundSteps(plan)).toEqual([]);
    expect(plan.steps.some((s) => s.tool === "attach_bubble")).toBe(true);
  });

  it("CASE 6: explicit place → school gate background DOES exist", () => {
    const { plan } = compile({
      ...BASE,
      summary: "Kyoto standing at a school gate",
      scene: { description: "a school gate" },
      beats: [{ panel: 1, actor: "Kyoto", action: "standing at a school gate", poseDetails: [] }],
    });
    expect(plan.steps.some((s) => s.tool === "generate_background")).toBe(true);
  });

  it("CASE 7: background-only request works", async () => {
    const { plan } = compile({
      ...BASE,
      intent: "new_scene",
      participants: [],
      summary: "create a school gate background",
      scene: { description: "a school gate" },
      beats: [],
    });
    expect(plan.steps.filter((s) => s.tool === "generate_background")).toHaveLength(1);
    const summary = await executePlan(plan, () => {}, { creationAuthorized: false, authorizedCreationNames: [] });
    expect(summary.status).toBe("completed");
  });

  it("CASE 8: full scene → character + background + composition all present", () => {
    const { plan } = compile({
      ...BASE,
      intent: "new_scene",
      participants: [{ name: "Momo", resolutionIntent: "create_if_missing", attributes: ["a girl"], relationships: [] }],
      summary: "Momo walks a rainy street",
      scene: { description: "rainy street at night" },
      beats: [{ panel: 1, actor: "Momo", action: "walking", poseDetails: [] }],
    });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("create_character");
    expect(tools).toContain("generate_background");
    expect(tools).toContain("place_character");
    expect(tools).toContain("place_asset");
  });

  it("placeholder scene descriptions are dropped at the contract boundary", () => {
    for (const word of ["unspecified", "Unspecified", "none", "unknown", "N/A", "default"]) {
      const { map, error } = parseCreativeTaskMap({ ...BASE, summary: "x", beats: [], scene: { description: word } });
      expect(error).toBeUndefined();
      expect(map!.scene, `scene "${word}" must be dropped`).toBeUndefined();
    }
  });

  it("a real scene description is never dropped", () => {
    const { map } = parseCreativeTaskMap({ ...BASE, summary: "x", beats: [], scene: { description: "a classroom" } });
    expect(map!.scene?.description).toBe("a classroom");
  });
});
