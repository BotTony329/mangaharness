/**
 * v0.3 Phase 5 — AGENT CAMERA INTEGRATION: Golden Contract Tests A1–A13.
 *
 * The Agent is a CLIENT of the Panel Camera application service:
 *
 *   Creative Task Map cameraIntent → cameraSemantics normalization →
 *   ONE set_camera/set_focal_character/set_perspective step → canonical
 *   commands (undo) → planPanelCamera (the CameraResolver verdict the UI
 *   reads) → LOCAL staging (zero API) or applyPanelCamera (Phase 4.5 unified
 *   whole-panel generation).
 *
 * The provider seam is mocked; assertions cover intent compilation, panel
 * targeting, routing, call counts, focus semantics and undo — never pixels.
 *
 * A12 (v0.2 interaction baseline) and A13 (Phase 4.5 camera baseline) are
 * enforced by their own frozen suites — interactionBaseline.test.ts and
 * panelCamera.test.ts run green in the same regression pass.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { parseCameraIntent } from "@/agent/cameraIntent";
import { parseCreativeTaskMap, type CreativeTaskMap } from "./contract/creativeTaskMap";
import { resolveTaskMap } from "./resolution/entityResolver";
import { resolveCameraTargetPanel } from "./resolution/cameraTarget";
import { compileTaskMap } from "./routing/capabilityRouter";

const generateImage = vi.fn();
const registerGeneratedAsset = vi.fn();
const recordGenerationEvidence = vi.fn();

vi.mock("@/services/generation", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  registerGeneratedAsset: (...args: unknown[]) => registerGeneratedAsset(...args),
  imageProviderCapabilities: async () => ({ referenceImage: true, nativeTransparency: false }),
  recordGenerationEvidence: (...args: unknown[]) => recordGenerationEvidence(...args),
}));

interface Studio {
  pageId: ID;
  panelA: ID;
  panelB: ID;
  yuriId: ID;
  yuriRefAssetId: ID;
  streetId: ID;
}

function buildStudioDoc(): { doc: ProjectDocument; s: Studio } {
  let doc: ProjectDocument = createProjectDocument("AgentCamera");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const ref = addAsset(doc, {
    category: "character",
    name: "Yuri reference",
    storageUrl: "https://example.com/yuri.png",
    width: 800,
    height: 1600,
    metadata: { characterId: yuri.characterId, characterAssetRole: "canonical" },
  });
  doc = ref.doc;
  const street = addAsset(doc, {
    category: "background",
    name: "Tokyo Street",
    storageUrl: "https://example.com/street.png",
    width: 1600,
    height: 900,
  });
  doc = street.doc;
  const pageId = Object.values(doc.pages)[0].id;
  doc = applyDomainCommand(doc, { type: "set-page-layout", pageId, layout: "two-vertical" }).doc;
  const s: Studio = {
    pageId,
    panelA: doc.pages[pageId].panelIds[0],
    panelB: doc.pages[pageId].panelIds[1],
    yuriId: yuri.characterId,
    yuriRefAssetId: ref.assetId,
    streetId: street.assetId,
  };
  return { doc, s };
}

/** Mount a fresh studio; returns panel ids. Optionally cast street + Yuri into panel A. */
function mountStudio(opts: { cast?: boolean; yuriAlsoInB?: boolean } = {}): Studio {
  const { doc, s } = buildStudioDoc();
  useEditorStore.getState().loadDocument(doc);
  if (opts.cast !== false) {
    useEditorStore.getState().dispatch({ type: "add-instance", panelId: s.panelA, assetId: s.streetId });
    useEditorStore.getState().dispatch({ type: "add-instance", panelId: s.panelA, assetId: s.yuriRefAssetId });
  }
  if (opts.yuriAlsoInB) {
    useEditorStore.getState().dispatch({ type: "add-instance", panelId: s.panelB, assetId: s.yuriRefAssetId });
  }
  return s;
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  recordGenerationEvidence.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  registerGeneratedAsset.mockImplementation(async (input: { category: "character" | "background"; name: string; metadata?: object }) => {
    const current = useEditorStore.getState().doc!;
    const added = addAsset(current, {
      category: input.category,
      name: input.name,
      storageUrl: `https://example.com/generated-${registerGeneratedAsset.mock.calls.length}.png`,
      width: 1600,
      height: 900,
      metadata: input.metadata,
    });
    useEditorStore.setState({ doc: added.doc } as never);
    return added.assetId;
  });
});

function cameraMap(raw: { cameraIntent: Record<string, unknown>; targetPanel?: number }): CreativeTaskMap {
  const { map, error } = parseCreativeTaskMap({
    version: 1,
    summary: "camera change",
    intent: "modify_existing",
    participants: [{ name: "Yuri", resolutionIntent: "existing", attributes: [], relationships: [] }],
    beats: [],
    objects: [],
    effects: [],
    localEdits: [],
    cameraIntent: raw.cameraIntent,
    target: { scope: "selected_panel", ...(raw.targetPanel ? { panel: raw.targetPanel } : {}) },
  });
  if (!map) throw new Error(`contract rejected: ${error}`);
  return map;
}

/** Compile + execute through the REAL v2 executor, generation mocked. */
async function runCameraMap(map: CreativeTaskMap) {
  const doc = useEditorStore.getState().doc!;
  const resolution = resolveTaskMap(map, doc);
  const { plan } = compileTaskMap(map, resolution);
  const summary = await executePlan(plan, () => {}, { creationAuthorized: false, authorizedCreationNames: [] });
  return { plan, summary, after: useEditorStore.getState().doc! };
}

describe("A1 — high angle: intent lands on the PANEL; Resolver GENERATIVE; whole-panel path", () => {
  it("records angle=high, one unified generation, character AND scene participate", async () => {
    const s = mountStudio();
    const { summary, after } = await runCameraMap(cameraMap({ cameraIntent: { angle: "high" }, targetPanel: 1 }));

    expect(summary.status).toBe("completed");
    expect(after.panels[s.panelA].camera?.angle).toBe("high");
    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0] as { prompt: string; referenceUrls: string[] };
    // Whole panel — never scene-only, never character-only.
    expect(request.referenceUrls).toContain("https://example.com/street.png");
    expect(request.referenceUrls).toContain("https://example.com/yuri.png");
    expect(request.prompt).toContain("redraw the whole panel");
    expect(after.panels[s.panelA].activeCameraRenderAssetId).toBeDefined();
  });
});

describe("A2 — focus subject: PanelCamera focus, never a generation target", () => {
  it("focus=Yuri while the redraw still covers the entire panel", async () => {
    const s = mountStudio();
    const { plan, summary, after } = await runCameraMap(
      cameraMap({ cameraIntent: { angle: "high", focusSubject: "Yuri" }, targetPanel: 1 }),
    );

    expect(summary.status).toBe("completed");
    // One focal step, one camera step — focal lands first.
    const focal = plan.steps.find((st) => st.tool === "set_focal_character");
    const camera = plan.steps.find((st) => st.tool === "set_camera");
    expect(focal?.args).toMatchObject({ panel: 1, characterName: "Yuri" });
    expect(camera).toBeDefined();
    expect(plan.steps.indexOf(focal!)).toBeLessThan(plan.steps.indexOf(camera!));

    const panel = after.panels[s.panelA];
    const focalItem = panel.focalItemId ? after.items[panel.focalItemId] : undefined;
    expect(focalItem?.kind === "asset" && after.assets[focalItem.sourceAssetId]?.metadata?.characterId).toBe(s.yuriId);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0] as { prompt: string; referenceUrls: string[] };
    expect(request.prompt).toContain("focal subject is Yuri");
    // Generative scope is still the whole panel.
    expect(request.referenceUrls).toContain("https://example.com/street.png");
  });
});

describe("A3 — multi-intent: ONE patch, ONE service execution, at most ONE generation", () => {
  it("高机位广角中景 + focus compiles to a single set_camera step", async () => {
    mountStudio();
    const { plan, summary } = await runCameraMap(
      cameraMap({ cameraIntent: { angle: "high", lens: "wide", shot: "medium", focusSubject: "Yuri" }, targetPanel: 1 }),
    );

    expect(plan.steps.filter((st) => st.tool === "set_camera")).toHaveLength(1);
    expect(summary.status).toBe("completed");
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(recordGenerationEvidence).toHaveBeenCalledWith(expect.objectContaining({ route: "panel-shot", generationCalls: 1 }));
  });
});

describe("A4 — LOCAL camera: zero API calls", () => {
  it("稍微拉近一点 (tightening shot) restages locally, provider untouched", async () => {
    const s = mountStudio();
    const { summary, after } = await runCameraMap(cameraMap({ cameraIntent: { shot: "close-up" }, targetPanel: 1 }));

    expect(summary.status).toBe("completed");
    expect(after.panels[s.panelA].camera?.shot).toBe("close-up");
    expect(generateImage).not.toHaveBeenCalled();
    expect(after.panels[s.panelA].activeCameraRenderAssetId).toBeUndefined();
  });
});

describe("A5 — overhead: Resolver GENERATIVE, whole panel", () => {
  it("从正上方看 records overhead and redraws once", async () => {
    const s = mountStudio();
    const { summary, after } = await runCameraMap(cameraMap({ cameraIntent: { angle: "overhead" }, targetPanel: 1 }));

    expect(summary.status).toBe("completed");
    expect(after.panels[s.panelA].camera?.angle).toBe("overhead");
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
});

describe("A6 — ambiguous panel target: clarify, never guess", () => {
  it("no selection + multiple panels → ambiguous; selection or a single panel resolves", () => {
    const s = mountStudio();
    const doc = useEditorStore.getState().doc!;
    const map = cameraMap({ cameraIntent: { angle: "high" } });

    const ambiguous = resolveCameraTargetPanel(map, doc, { currentPageId: s.pageId, selection: {} });
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") expect(ambiguous.question).toContain("ambiguous");

    const bySelection = resolveCameraTargetPanel(map, doc, { currentPageId: s.pageId, selection: { panelId: s.panelB } });
    expect(bySelection).toEqual({ kind: "resolved", panel: 2, source: "selection" });

    const explicit = resolveCameraTargetPanel(cameraMap({ cameraIntent: { angle: "high" }, targetPanel: 2 }), doc, {
      currentPageId: s.pageId,
      selection: {},
    });
    expect(explicit).toEqual({ kind: "resolved", panel: 2, source: "explicit" });

    // Single-panel page resolves without a selection.
    const single = applyDomainCommand(doc, { type: "set-page-layout", pageId: s.pageId, layout: "single" }).doc;
    const only = resolveCameraTargetPanel(map, single, { currentPageId: s.pageId, selection: {} });
    expect(only).toEqual({ kind: "resolved", panel: 1, source: "single-panel" });

    // No camera intent → no resolution at all.
    const none = resolveCameraTargetPanel(cameraMap({ cameraIntent: {} }), doc, { currentPageId: s.pageId, selection: {} });
    expect(none.kind).toBe(cameraMap({ cameraIntent: {} }).cameraIntent ? "ambiguous" : "no-camera");
  });
});

describe("A7 — panel-only scope: Yuri in two panels, only the target panel changes", () => {
  it("camera on panel A leaves panel B untouched", async () => {
    const s = mountStudio({ yuriAlsoInB: true });
    const beforeB = useEditorStore.getState().doc!.panels[s.panelB];
    const { summary, after } = await runCameraMap(
      cameraMap({ cameraIntent: { angle: "high", focusSubject: "Yuri" }, targetPanel: 1 }),
    );

    expect(summary.status).toBe("completed");
    expect(after.panels[s.panelA].camera?.angle).toBe("high");
    expect(after.panels[s.panelB].camera).toEqual(beforeB.camera);
    expect(after.panels[s.panelB].activeCameraRenderAssetId).toBeUndefined();
    expect(after.panels[s.panelB].focalItemId).toBe(beforeB.focalItemId);
  });
});

describe("A8 — undo/redo: Agent camera commands live in the same history as UI commands", () => {
  it("undo restores the previous camera and composition; redo reapplies", async () => {
    const s = mountStudio();
    const before = useEditorStore.getState().doc!;
    const { summary } = await runCameraMap(cameraMap({ cameraIntent: { angle: "high" }, targetPanel: 1 }));
    expect(summary.status).toBe("completed");
    expect(useEditorStore.getState().doc!.panels[s.panelA].camera?.angle).toBe("high");

    useEditorStore.getState().undo();
    const undone = useEditorStore.getState().doc!;
    expect(undone.panels[s.panelA].camera).toEqual(before.panels[s.panelA].camera);
    expect(undone.panels[s.panelA].activeCameraRenderAssetId).toBeUndefined();

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().doc!.panels[s.panelA].camera?.angle).toBe("high");
  });
});

describe("A9/A10 — boundary contract: the Agent camera path holds no provider and no staging math", () => {
  const AGENT_CAMERA_SOURCES = [
    "src/agent-v2/process/cameraProcess.ts",
    "src/agent-v3/routing/cameraSemantics.ts",
    "src/agent-v3/routing/capabilityRouter.ts",
    "src/agent-v3/resolution/cameraTarget.ts",
  ];

  it("A9 — no direct provider/generation imports", () => {
    for (const file of AGENT_CAMERA_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/@\/services\/generation/);
      expect(source, file).not.toMatch(/@\/agent\/providers/);
      expect(source, file).not.toMatch(/generateImage|registerGeneratedAsset/);
    }
    // The ONLY permitted service boundary is the Panel Camera application service.
    const process = readFileSync("src/agent-v2/process/cameraProcess.ts", "utf8");
    expect(process).toMatch(/@\/services\/panelCamera/);
  });

  it("A10 — no direct staging projection", () => {
    for (const file of AGENT_CAMERA_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/projectInstance|applyCameraPatch|frameSubject|applyPerspectivePatch|depthFromGroundPoint/);
    }
  });
});

describe("A11 — no character/scene routing: camera-route is panel-shot with every participant", () => {
  it("Yuri + Tokyo Street, '高机位' → one panel-shot generation covering both", async () => {
    mountStudio();
    const { summary } = await runCameraMap(cameraMap({ cameraIntent: { angle: "high" }, targetPanel: 1 }));

    expect(summary.status).toBe("completed");
    expect(recordGenerationEvidence).toHaveBeenCalledTimes(1);
    const evidence = recordGenerationEvidence.mock.calls[0][0] as {
      route: string;
      participantCount: number;
      generationCalls: number;
    };
    expect(evidence.route).toBe("panel-shot");
    expect(evidence.generationCalls).toBe(1);
    expect(evidence.participantCount).toBe(2);
  });
});

describe("perspective intent — three-point perspective reaches the canonical tool", () => {
  it("cameraIntent.perspective compiles to set_perspective before set_camera", async () => {
    mountStudio();
    const map = cameraMap({ cameraIntent: { perspective: "three-point perspective", angle: "high" }, targetPanel: 1 });
    const doc = useEditorStore.getState().doc!;
    const { plan } = compileTaskMap(map, resolveTaskMap(map, doc));

    const perspective = plan.steps.find((st) => st.tool === "set_perspective");
    const camera = plan.steps.find((st) => st.tool === "set_camera");
    expect(perspective?.args).toMatchObject({ panel: 1, type: "three-point" });
    expect(camera).toBeDefined();
    expect(plan.steps.indexOf(perspective!)).toBeLessThan(plan.steps.indexOf(camera!));
  });
});

describe("§11 vocabulary — the v1 NL parser serves the existing camera domain", () => {
  it(" Chinese camera words map onto PanelCamera semantics", () => {
    const s = mountStudio({ cast: false });
    const doc = useEditorStore.getState().doc!;
    const parse = (text: string) => parseCameraIntent({ text, doc, characterIds: [s.yuriId], subjectId: s.yuriId });

    expect(parse("把这个格子改成俯拍").angle).toBe("high");
    expect(parse("镜头拉远一点").shot).toBe("wide");
    expect(parse("给 Yuri 一个低机位").angle).toBe("low");
    expect(parse("用广角加强透视").lens).toBe("wide");
    expect(parse("把镜头聚焦 Yuri").focalCharacterId).toBe(s.yuriId);
    expect(parse("改成全景高机位")).toMatchObject({ shot: "full", angle: "high" });
    expect(parse("用三点透视从上面看")).toMatchObject({ perspective: "three-point", angle: "high" });
    expect(parse("倾斜镜头").angle).toBe("dutch");
    expect(parse("平视").angle).toBe("eye-level");
    expect(parse("长焦").lens).toBe("telephoto");
  });
});
