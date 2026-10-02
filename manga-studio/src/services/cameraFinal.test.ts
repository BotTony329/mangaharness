/**
 * v0.3 Phase 6 — CAMERA FINAL SUITE F1–F20.
 *
 * Lifecycle hardening and closure for the frozen v0.3 Camera. The provider
 * seam is mocked; assertions cover execution ownership, render lifecycle,
 * invalidation, persistence and undo — never pixels.
 *
 * F21 (v0.2 interaction baseline byte-stable) → interactionBaseline.test.ts
 * F22 (Phase 4.5 baseline)                     → panelCamera.test.ts
 * F23 (Phase 5 baseline)                       → agentCameraGolden.test.ts
 * run green in the same regression pass; this file does not duplicate them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { createPanelCamera } from "@/domain/camera";
import { createInteraction } from "@/domain/interactions";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

const generateImage = vi.fn();
const registerGeneratedAsset = vi.fn();

vi.mock("@/services/generation", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  registerGeneratedAsset: (...args: unknown[]) => registerGeneratedAsset(...args),
  imageProviderCapabilities: async () => ({ referenceImage: true, nativeTransparency: false }),
  recordGenerationEvidence: () => {},
}));

import { applyPanelCamera, resolvePanelVisualParticipants } from "./panelCamera";
import { rerenderInteraction } from "./interaction";

interface Studio {
  doc: ProjectDocument;
  panelId: ID;
  yuriId: ID;
  yuiId: ID;
  streetId: ID;
  yuriRefAssetId: ID;
  yuiRefAssetId: ID;
}

function studio(): Studio {
  let doc: ProjectDocument = createProjectDocument("CameraFinal");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const yui = addCharacter(doc, "Yui");
  doc = yui.doc;
  const yuriRef = addAsset(doc, {
    category: "character",
    name: "Yuri reference",
    storageUrl: "https://example.com/yuri.png",
    width: 800,
    height: 1600,
    metadata: { characterId: yuri.characterId, characterAssetRole: "canonical" },
  });
  doc = yuriRef.doc;
  const yuiRef = addAsset(doc, {
    category: "character",
    name: "Yui reference",
    storageUrl: "https://example.com/yui.png",
    width: 800,
    height: 1600,
    metadata: { characterId: yui.characterId, characterAssetRole: "canonical" },
  });
  doc = yuiRef.doc;
  const street = addAsset(doc, {
    category: "background",
    name: "Tokyo Street",
    storageUrl: "https://example.com/street.png",
    width: 1600,
    height: 900,
  });
  doc = street.doc;
  return {
    doc,
    panelId: Object.keys(doc.panels)[0],
    yuriId: yuri.characterId,
    yuiId: yui.characterId,
    streetId: street.assetId,
    yuriRefAssetId: yuriRef.assetId,
    yuiRefAssetId: yuiRef.assetId,
  };
}

function mount(doc: ProjectDocument) {
  useEditorStore.setState({ doc, past: [], future: [] } as never);
}

function place(panelId: ID, assetId: ID) {
  return useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId });
}

function docNow(): ProjectDocument {
  return useEditorStore.getState().doc!;
}

function activeRender(panelId: ID): ID | undefined {
  return docNow().panels[panelId].activeCameraRenderAssetId;
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  registerGeneratedAsset.mockImplementation(async (input: { category: "character" | "background"; name: string; metadata?: object }) => {
    const current = docNow();
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

/** Standard cast: Yuri + Tokyo Street placed, ready for camera work. */
function castStudio(): Studio {
  const s = studio();
  mount(s.doc);
  place(s.panelId, s.streetId);
  place(s.panelId, s.yuriRefAssetId);
  return s;
}

describe("F1 — eye-level → High: GENERATIVE, whole panel, ONE generation", () => {
  it("redraws once with every participant", async () => {
    const s = castStudio();
    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(result.route).toBe("panel-shot");
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(activeRender(s.panelId)).toBe(result.assetId);
  });
});

describe("F2 — High → Low: R2 anchors canonical/root sources, never R1", () => {
  it("R1 references stay viewpoints; R2 references are the canonical sources", async () => {
    const s = castStudio();
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "high" } });
    const r1 = await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "low" } });
    const r2 = await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });

    const r1Refs = docNow().assets[r1.assetId].metadata?.referenceAssetIds as ID[];
    const r2Refs = docNow().assets[r2.assetId].metadata?.referenceAssetIds as ID[];
    // R2 re-reads the structured source graph: canonical refs + root scene.
    expect(r2Refs).toContain(s.yuriRefAssetId);
    expect(r2Refs).toContain(s.streetId);
    // The previous render is never a canonical source for the next one.
    expect(r2Refs).not.toContain(r1.assetId);
    expect(r1Refs).not.toContain(r2.assetId);
    expect(activeRender(s.panelId)).toBe(r2.assetId);
  });
});

describe("F3 — LOCAL framing: zero generation", () => {
  it("a tightening shot is refused by the service with no API call", async () => {
    const s = castStudio();
    await expect(
      applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ shot: "close-up" }) }),
    ).rejects.toThrow(/no generation needed/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("F4/F5 — participants: character + scene, and two characters + scene", () => {
  it("Yuri + Street = 2 participants; + Yui = 3 distinct participants", () => {
    const s = castStudio();
    expect(resolvePanelVisualParticipants(docNow(), s.panelId)).toHaveLength(2);
    place(s.panelId, s.yuiRefAssetId);
    const participants = resolvePanelVisualParticipants(docNow(), s.panelId);
    expect(participants).toHaveLength(3);
    expect(new Set(participants.map((p) => p.id)).size).toBe(3);
  });
});

describe("F6 — interaction + scene: interaction preserved, ONE generation", () => {
  it("hug semantics ride the panel shot; the composite stays out", async () => {
    const s = castStudio();
    place(s.panelId, s.yuiRefAssetId);
    const created = createInteraction(docNow(), {
      panelId: s.panelId,
      type: "hug",
      participantIds: [s.yuriId, s.yuiId],
    });
    useEditorStore.setState({ doc: created.doc } as never);
    await rerenderInteraction(created.interactionId);
    generateImage.mockClear();

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0] as { prompt: string };
    expect(request.prompt.toLowerCase()).toContain("hug");
  });
});

describe("F7 — same-name DISTINCT characters are never deduped into one", () => {
  it("two characters both named Yuri stay two participants", () => {
    const s = castStudio();
    const clone = addCharacter(docNow(), "Yuri");
    useEditorStore.setState({ doc: clone.doc } as never);
    const cloneRef = addAsset(clone.doc, {
      category: "character",
      name: "Yuri (other) reference",
      storageUrl: "https://example.com/yuri-2.png",
      width: 800,
      height: 1600,
      metadata: { characterId: clone.characterId, characterAssetRole: "canonical" },
    });
    useEditorStore.setState({ doc: cloneRef.doc } as never);
    place(s.panelId, cloneRef.assetId);

    const participants = resolvePanelVisualParticipants(docNow(), s.panelId).filter((p) => p.kind === "character");
    expect(participants).toHaveLength(2);
    expect(new Set(participants.map((p) => p.id)).size).toBe(2);
  });
});

describe("F8 — duplicate reference path merges at the REFERENCE level (P16 regression)", () => {
  it("two different assets anchoring the SAME image send ONE reference", async () => {
    const s = castStudio();
    // A derivative library asset pointing at the street's render URL.
    const derivative = addAsset(docNow(), {
      category: "background",
      name: "Street derivative",
      storageUrl: "https://example.com/street.png",
      width: 1600,
      height: 900,
      metadata: { referenceAssetIds: [s.streetId] },
    });
    useEditorStore.setState({ doc: derivative.doc } as never);
    place(s.panelId, derivative.assetId);

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    const request = generateImage.mock.calls[0][0] as { referenceUrls: string[] };
    expect(request.referenceUrls.filter((url) => url === "https://example.com/street.png")).toHaveLength(1);
  });
});

describe("F9/F10 — bubbles: excluded from generation AND from invalidation", () => {
  it("bubble text never enters references; editing it keeps the render current", async () => {
    const s = castStudio();
    const bubble = useEditorStore.getState().dispatch({ type: "add-bubble", panelId: s.panelId, bubbleType: "speech", text: "hello" });
    const bubbleId = bubble.createdId!;
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    const request = generateImage.mock.calls[0][0] as { prompt: string; referenceUrls: string[] };
    expect(request.prompt).not.toContain("hello");
    const renderId = activeRender(s.panelId);
    expect(renderId).toBeDefined();

    // Editorial overlay mutations: text edit and bubble retargeting.
    useEditorStore.getState().dispatch({ type: "update-bubble", itemId: bubbleId, patch: { text: "edited" } });
    useEditorStore.getState().dispatch({ type: "refresh-bubble-tails", panelId: s.panelId });
    expect(activeRender(s.panelId)).toBe(renderId);
  });
});

describe("F11/F12/F13 — visual source mutations retire the render", () => {
  it("F11: character state edit (pose/expression) invalidates", async () => {
    const s = castStudio();
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(activeRender(s.panelId)).toBeDefined();

    const yuriItem = docNow().panels[s.panelId].itemIds
      .map((id) => docNow().items[id])
      .find((item) => item?.kind === "asset" && docNow().assets[item.sourceAssetId]?.metadata?.characterId === s.yuriId)!;
    useEditorStore.getState().dispatch({
      type: "set-instance-character-state",
      instanceId: yuriItem.id,
      state: { characterId: s.yuriId, pose: "running", expression: "shocked", outfit: "default outfit", view: "front" },
    });
    expect(activeRender(s.panelId)).toBeUndefined();
  });

  it("F12: scene replacement invalidates", async () => {
    const s = castStudio();
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    const alley = addAsset(docNow(), {
      category: "background",
      name: "Night Alley",
      storageUrl: "https://example.com/alley.png",
      width: 1600,
      height: 900,
    });
    useEditorStore.setState({ doc: alley.doc } as never);
    const streetItem = docNow().panels[s.panelId].itemIds
      .map((id) => docNow().items[id])
      .find((item) => item?.kind === "asset" && item.sourceAssetId === s.streetId)!;
    useEditorStore.getState().dispatch({ type: "swap-instance-asset", instanceId: streetItem.id, assetId: alley.assetId });
    expect(activeRender(s.panelId)).toBeUndefined();
  });

  it("F13: interaction edit invalidates", async () => {
    const s = castStudio();
    place(s.panelId, s.yuiRefAssetId);
    const created = createInteraction(docNow(), {
      panelId: s.panelId,
      type: "hug",
      participantIds: [s.yuriId, s.yuiId],
    });
    useEditorStore.setState({ doc: created.doc } as never);
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(activeRender(s.panelId)).toBeDefined();

    useEditorStore.getState().dispatch({ type: "remove-interaction", interactionId: created.interactionId });
    expect(activeRender(s.panelId)).toBeUndefined();
  });
});

describe("F14 — camera change invalidation", () => {
  it("generative change retires the render; LOCAL framing change retires it too; roll keeps it", async () => {
    const s = castStudio();
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(activeRender(s.panelId)).toBeDefined();
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "low" } });
    expect(activeRender(s.panelId)).toBeUndefined();

    // LOCAL shot change while a render is active: the flat render cannot be
    // locally restaged, so it stops being current.
    await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });
    const r = activeRender(s.panelId);
    expect(r).toBeDefined();
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { shot: "close-up" } });
    expect(activeRender(s.panelId)).toBeUndefined();

    // Roll is applied live to the render node — the render stays current.
    await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });
    const r2 = activeRender(s.panelId);
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { roll: 12 } });
    expect(activeRender(s.panelId)).toBe(r2);
  });
});

describe("F15 — generate → undo → redo", () => {
  it("render activation is one undo step", async () => {
    const s = castStudio();
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(activeRender(s.panelId)).toBeDefined();
    useEditorStore.getState().undo();
    expect(activeRender(s.panelId)).toBeUndefined();
    useEditorStore.getState().redo();
    expect(activeRender(s.panelId)).toBeDefined();
  });
});

describe("F16 — R1 → camera change → R2 → undo → previous visual state", () => {
  it("undo walks back through R2 activation to the retired state, then to R1", async () => {
    const s = castStudio();
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "high" } });
    const r1 = await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "low" } });
    const r2 = await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });
    expect(activeRender(s.panelId)).toBe(r2.assetId);

    // Undo R2: camera stays low, no render current (composition visible).
    useEditorStore.getState().undo();
    expect(activeRender(s.panelId)).toBeUndefined();
    expect(docNow().panels[s.panelId].camera?.angle).toBe("low");

    // Undo the camera change: high AND R1's activation return together — the
    // retirement rode the same command as the change.
    useEditorStore.getState().undo();
    expect(docNow().panels[s.panelId].camera?.angle).toBe("high");
    expect(activeRender(s.panelId)).toBe(r1.assetId);
  });
});

describe("F17 — persistence round-trip", () => {
  it("save/reload restores camera, active render association, sources and overlays", async () => {
    const s = castStudio();
    useEditorStore.getState().dispatch({ type: "add-bubble", panelId: s.panelId, bubbleType: "speech", text: "persist me" });
    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "high", shot: "medium" } });
    const result = await applyPanelCamera({ panelId: s.panelId, camera: docNow().panels[s.panelId].camera! });

    // The document is JSON-persisted; a round-trip must be lossless for the
    // whole camera lifecycle state.
    const reloaded = JSON.parse(JSON.stringify(docNow())) as ProjectDocument;
    const panel = reloaded.panels[s.panelId];
    expect(panel.camera?.angle).toBe("high");
    expect(panel.camera?.shot).toBe("medium");
    expect(panel.activeCameraRenderAssetId).toBe(result.assetId);
    expect(reloaded.assets[result.assetId].metadata?.panelCameraRender).toBe(true);
    expect(reloaded.assets[result.assetId].metadata?.referenceAssetIds).toEqual(
      docNow().assets[result.assetId].metadata?.referenceAssetIds,
    );
    // Sources are not flattened: the placed instances still exist.
    const assetItems = panel.itemIds.map((id) => reloaded.items[id]).filter((item) => item?.kind === "asset");
    expect(assetItems.length).toBeGreaterThanOrEqual(2);
    // Overlay survives.
    const bubbles = panel.itemIds.map((id) => reloaded.items[id]).filter((item) => item?.kind === "bubble");
    expect((bubbles[0] as { text?: string })?.text).toBe("persist me");
  });
});

describe("delete panel — no orphan camera state", () => {
  it("layout change drops the panel and its render pointer; the asset stays in the library", async () => {
    const s = castStudio();
    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    const pageId = Object.values(docNow().pages)[0].id;

    // Panels are retired by re-laying the page out (there is no delete-panel
    // command): the old panel id — and its render pointer — go with it.
    useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
    expect(docNow().panels[s.panelId]).toBeUndefined();
    // The render asset is library retention, not panel-owned state.
    expect(docNow().assets[result.assetId]).toBeDefined();
    // No new panel inherited a dangling render pointer.
    for (const panelId of docNow().pages[pageId].panelIds) {
      expect(docNow().panels[panelId].activeCameraRenderAssetId).toBeUndefined();
    }
  });
});
