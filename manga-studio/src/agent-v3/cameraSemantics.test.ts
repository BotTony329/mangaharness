/**
 * Golden: CAMERA SEMANTIC CONTRACT.
 *
 * The Creative Director speaks photographic language ("dramatic",
 * "emotional", "portrait"); the Editor understands ShotType/CameraAngle/
 * CameraLens. Translation happens exactly once, in routing/cameraSemantics.
 * Unknown camera language is SOFT normalization (fallback + warning); only
 * identity/structure violations stay HARD failures.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { parseCreativeTaskMap, type CreativeTaskMap } from "./contract/creativeTaskMap";
import { resolveTaskMap } from "./resolution/entityResolver";
import { compileTaskMap, creationAuthorization } from "./routing/capabilityRouter";
import { resolveCameraIntent } from "./routing/cameraSemantics";

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
  useEditorStore.getState().loadDocument(createProjectDocument("Camera golden"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate")) {
      return new Response(
        JSON.stringify({
          url: "https://example.com/g.png",
          sourceUrl: "https://example.com/g.png",
          processedImageUrl: "https://example.com/g-a.png",
          mimeType: "image/png",
          hasAlpha: true,
          processingStatus: "ready",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

const KIKI_MAP = {
  version: 1,
  summary: "Kiki cries in the classroom",
  intent: "new_scene",
  participants: [
    { name: "Kiki", resolutionIntent: "create_if_missing", attributes: ["Japanese", "school girl"], relationships: [] },
  ],
  scene: { description: "a school classroom" },
  objects: [],
  beats: [{ panel: 2, actor: "Kiki", action: "getting her test result, crying", poseDetails: [], dialogueKind: "speech" }],
  effects: [],
  localEdits: [],
  target: { scope: "current_page", panel: 2 },
};

function compileRaw(raw: unknown) {
  const { map, error } = parseCreativeTaskMap(raw);
  if (!map) throw new Error(`contract rejected: ${error}`);
  const doc = useEditorStore.getState().doc!;
  const resolution = resolveTaskMap(map, doc);
  return { map, resolution, ...compileTaskMap(map, resolution) };
}

describe("camera semantic contract", () => {
  it("CASE 1: the live bug — lens 'dramatic' is accepted and normalizes to wide", () => {
    const { plan, warnings } = compileRaw({ ...KIKI_MAP, cameraIntent: { lens: "dramatic" } });
    const camera = plan.steps.find((s) => s.tool === "set_camera");
    expect(camera?.args.lens).toBe("wide");
    expect(warnings).toEqual([]);
  });

  it("CASE 2: lens 'natural' → normal", () => {
    expect(resolveCameraIntent({ lens: "natural" })?.lens).toBe("normal");
  });

  it("CASE 3: lens 'portrait' → telephoto", () => {
    expect(resolveCameraIntent({ lens: "portrait" })?.lens).toBe("telephoto");
  });

  it("CASE 4: unknown lens 'emotional' — NOT rejected, fallback normal, warning recorded", () => {
    const resolved = resolveCameraIntent({ lens: "emotional" });
    expect(resolved?.lens).toBe("normal");
    expect(resolved?.warnings[0]).toContain("emotional");
    const { plan, warnings } = compileRaw({ ...KIKI_MAP, cameraIntent: { lens: "emotional" } });
    expect(plan.steps.find((s) => s.tool === "set_camera")?.args.lens).toBe("normal");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("CASE 5: editor-native 'wide' passes through without double transform", () => {
    expect(resolveCameraIntent({ lens: "wide" })?.lens).toBe("wide");
    expect(resolveCameraIntent({ shot: "close-up" })?.shot).toBe("close-up");
    expect(resolveCameraIntent({ angle: "low" })?.angle).toBe("low");
  });

  it("CASE 6: the live Kiki prompt shape passes contract + compiles with non-native camera language", async () => {
    const { map, resolution, plan } = compileRaw({
      ...KIKI_MAP,
      cameraIntent: { shot: "intimate", lens: "emotional", dramaticIntent: "quiet heartbreak" },
    });
    // Kiki identity preserved; Japanese is an attribute; classroom is the scene.
    expect(map.participants[0].name).toBe("Kiki");
    expect(map.participants[0].attributes).toContain("Japanese");
    expect(map.scene?.description).toContain("classroom");
    expect(map.beats[0].action).toContain("crying");

    const names = creationAuthorization(resolution);
    const summary = await executePlan(plan, () => {}, {
      creationAuthorized: names.length > 0,
      authorizedCreationNames: names,
    });
    expect(summary.status).toBe("completed");
    const after = useEditorStore.getState().doc!;
    expect(Object.values(after.characters).some((c) => c.name === "Kiki")).toBe(true);
  });

  it("CASE 7: dramatic low-angle intent still reaches GENERATION upstream", () => {
    const { plan } = compileRaw({
      ...KIKI_MAP,
      cameraIntent: { angle: "low", shot: "close emotional", dramaticIntent: "tension" },
    });
    const generation = plan.steps.find((s) => s.tool === "generate_character_asset" && s.args.kind === "pose");
    // The image model hears the director's words — not a post-hoc scale/crop.
    expect(String(generation?.args.instruction)).toContain("low");
    expect(String(generation?.args.instruction)).toContain("tension");
  });

  it("CASE 8: HARD failures stay hard — a null participant name still kills the map", () => {
    const { map, error } = parseCreativeTaskMap({
      ...KIKI_MAP,
      participants: [{ ...KIKI_MAP.participants[0], name: null }],
    });
    expect(map).toBeUndefined();
    expect(error).toContain("participants[0].name");
  });

  it("normalization boundary is pure: no camera word ever throws", () => {
    const weird: CreativeTaskMap["cameraIntent"] = { shot: "🎆", angle: "sideways-ish", lens: "dreamy", requiresRedraw: false };
    const resolved = resolveCameraIntent(weird ?? undefined);
    expect(resolved?.warnings.length).toBe(3);
    expect(resolved?.lens).toBe("normal");
  });
});
