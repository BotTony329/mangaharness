/**
 * Panel-level Unified Generative Camera (v0.3 Phase 4.5) — Golden Cases P1–P14.
 *
 * Same seam discipline as Phase 2/3: the provider is mocked, so we assert
 * PARTICIPANT RESOLUTION, WHAT would be sent, reference anchoring, lifecycle
 * and undo — never pixels. The no-camera v0.2 interaction regression stays
 * locked by interactionBaseline.test.ts (byte-stable snapshots).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { createInteraction } from "@/domain/interactions";
import { createPanelCamera } from "@/domain/camera";
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

import { applyPanelCamera, planPanelCamera, resolvePanelVisualParticipants } from "./panelCamera";
import { rerenderInteraction } from "./interaction";

interface Studio {
  doc: ProjectDocument;
  panelId: ID;
  yuriId: ID;
  yuiId: ID;
  streetId: ID;
  benchId: ID;
  bagId: ID;
  /** Library asset ids of the character canonical references. */
  yuriRefAssetId: ID;
  yuiRefAssetId: ID;
}

function studio(): Studio {
  let doc: ProjectDocument = createProjectDocument("PanelCamera");
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
  const bench = addAsset(doc, { category: "prop", name: "Bench", storageUrl: "https://example.com/bench.png", width: 600, height: 400 });
  doc = bench.doc;
  const bag = addAsset(doc, { category: "prop", name: "Bag", storageUrl: "https://example.com/bag.png", width: 400, height: 400 });
  doc = bag.doc;
  return {
    doc,
    panelId: Object.keys(doc.panels)[0],
    yuriId: yuri.characterId,
    yuiId: yui.characterId,
    streetId: street.assetId,
    benchId: bench.assetId,
    bagId: bag.assetId,
    yuriRefAssetId: yuriRef.assetId,
    yuiRefAssetId: yuiRef.assetId,
  };
}

/** Load a doc into the store with a clean history. */
function mount(doc: ProjectDocument) {
  useEditorStore.setState({ doc, past: [], future: [] } as never);
}

function place(panelId: ID, assetId: ID) {
  return useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId });
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  // Register for real (domain-level) so provenance and follow-up runs find the asset.
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

describe("P1 — Character + Scene: ONE unified panel shot", () => {
  it("references canonical Yuri + root Street, one call, one active render", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);

    const result = await applyPanelCamera({
      panelId: s.panelId,
      camera: createPanelCamera({ angle: "high", shot: "medium" }),
    });

    expect(result.route).toBe("panel-shot");
    expect(result.generationCalls).toBe(1);
    expect(generateImage).toHaveBeenCalledTimes(1);

    const request = generateImage.mock.calls[0][0];
    // Priority order: scene before non-focus characters.
    expect(request.referenceUrls).toEqual(["https://example.com/street.png", "https://example.com/yuri.png"]);
    expect(request.assetType).toBe("background");
    expect(request.prompt).toContain("High camera angle looking down at the subject.");
    expect(request.prompt).toContain("Medium shot framed from roughly the waist up.");
    expect(request.prompt).toContain('Reference image 1 is the scene "Tokyo Street"');
    expect(request.prompt).toContain("Reference image 2 is Yuri");
    expect(request.prompt).toContain("redraw the whole panel");

    // Non-destructive: the render is registered and activated, sources stay.
    const doc = useEditorStore.getState().doc!;
    expect(doc.panels[s.panelId].activeCameraRenderAssetId).toBe(result.assetId);
    expect(doc.assets[result.assetId].metadata?.panelCameraRender).toBe(true);
    expect(doc.assets[result.assetId].metadata?.panelId).toBe(s.panelId);
  });
});

describe("P2 — Two characters + scene, NO interaction: everyone participates", () => {
  it("all three visual participants, one generation, no invented interaction", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.yuiRefAssetId);
    place(s.panelId, s.streetId);

    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toEqual(["https://example.com/street.png", "https://example.com/yuri.png", "https://example.com/yui.png"]);
    // The system must NOT invent a relationship between Yuri and Yui.
    expect(Object.keys(useEditorStore.getState().doc!.interactions ?? {})).toHaveLength(0);
    expect(result.omittedParticipants).toEqual([]);
  });
});

describe("P3 — Interaction + scene: semantics in, old composite OUT", () => {
  it("hug + high: canonical refs + root scene, hug semantics, never the previous composite", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.yuriId, s.yuiId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    mount(created.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.yuiRefAssetId);
    place(s.panelId, s.streetId);

    // An earlier hug composite exists and is placed; it must NOT anchor the shot.
    const composite = await rerenderInteraction(created.interactionId);
    const compositeUrl = useEditorStore.getState().doc!.assets[composite.assetId].storageUrl;
    generateImage.mockClear();

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toContain("https://example.com/yuri.png");
    expect(request.referenceUrls).toContain("https://example.com/yui.png");
    expect(request.referenceUrls).toContain("https://example.com/street.png");
    expect(request.referenceUrls).not.toContain(compositeUrl);
    expect(request.prompt).toContain("Hug: Yuri and Yui.");
    expect(request.prompt).toContain("High camera angle looking down at the subject.");
  });
});

describe("P4 — Objects join the shot; the reference budget is never a silent drop", () => {
  it("Yuri + Street + Bench + Bag: budget keeps 3, the omission is recorded", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);
    place(s.panelId, s.benchId);
    place(s.panelId, s.bagId);

    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) });

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    // Priority: scene > character > objects — and the scene is NOT alone.
    expect(request.referenceUrls).toHaveLength(3);
    expect(request.referenceUrls).toContain("https://example.com/street.png");
    expect(request.referenceUrls).toContain("https://example.com/yuri.png");
    expect(result.omittedParticipants).toEqual(["Bag"]);
    expect(useEditorStore.getState().doc!.assets[result.assetId].metadata?.omittedParticipants).toEqual(["Bag"]);
    expect(request.prompt).toContain("Bag (object)");
  });
});

describe("P5 — Focus is cinematic, not a filter", () => {
  it("focus Yuri: references still include Yui and Street", async () => {
    const s = studio();
    mount(s.doc);
    const yuriItem = place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.yuiRefAssetId);
    place(s.panelId, s.streetId);
    useEditorStore.getState().dispatch({ type: "set-panel-focal-item", panelId: s.panelId, itemId: yuriItem.createdId });

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    const request = generateImage.mock.calls[0][0];
    // Focus outranks everything except interaction participants.
    expect(request.referenceUrls).toEqual(["https://example.com/yuri.png", "https://example.com/street.png", "https://example.com/yui.png"]);
    expect(request.prompt).toContain("focal subject is Yuri");
  });
});

describe("P6 — Bubbles never enter generation", () => {
  it("bubble excluded from references, no-text clause present, bubble survives", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);
    const bubble = useEditorStore
      .getState()
      .dispatch({ type: "add-bubble", panelId: s.panelId, bubbleType: "speech", text: "After a long lecture..." });

    const participants = resolvePanelVisualParticipants(useEditorStore.getState().doc!, s.panelId);
    expect(participants).toHaveLength(2);

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toHaveLength(2);
    expect(request.prompt).toContain("No speech bubbles, dialogue, captions, lettering");
    expect(request.prompt).not.toContain("After a long lecture");
    const doc = useEditorStore.getState().doc!;
    expect(doc.items[bubble.createdId!]?.kind).toBe("bubble");
    expect(doc.panels[s.panelId].itemIds).toContain(bubble.createdId);
  });
});

describe("P7 — Non-destructive: sources stay, the render supersedes", () => {
  it("every source instance survives; the panel activates the camera render", async () => {
    const s = studio();
    mount(s.doc);
    const yuriItem = place(s.panelId, s.yuriRefAssetId);
    const streetItem = place(s.panelId, s.streetId);
    const before = useEditorStore.getState().doc!.panels[s.panelId].itemIds.length;

    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) });

    const doc = useEditorStore.getState().doc!;
    expect(doc.items[yuriItem.createdId!]).toBeDefined();
    expect(doc.items[streetItem.createdId!]).toBeDefined();
    expect(doc.panels[s.panelId].itemIds.length).toBe(before);
    expect(doc.panels[s.panelId].activeCameraRenderAssetId).toBe(result.assetId);
    expect(doc.assets[result.assetId].metadata?.sourceInstanceIds).toEqual(
      expect.arrayContaining([yuriItem.createdId, streetItem.createdId]),
    );
  });
});

describe("P8 — Undo/redo restores the composition", () => {
  it("generate → undo → sources visible again → redo → render active", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(useEditorStore.getState().doc!.panels[s.panelId].activeCameraRenderAssetId).toBeDefined();

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc!.panels[s.panelId].activeCameraRenderAssetId).toBeUndefined();

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().doc!.panels[s.panelId].activeCameraRenderAssetId).toBeDefined();
  });
});

describe("P9 — Scene lineage root anchors the redraw", () => {
  it("instance points at derivative B; the reference is original A, never B", async () => {
    const s = studio();
    // Street A → previous camera derivative B.
    const derivative = addAsset(s.doc, {
      category: "background",
      name: "Tokyo Street · high · wide",
      storageUrl: "https://example.com/street-high.png",
      width: 1600,
      height: 900,
      metadata: { referenceAssetIds: [s.streetId], cameraShot: "wide", cameraAngle: "high" },
    });
    mount(derivative.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, derivative.assetId);

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) });

    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toContain("https://example.com/street.png");
    expect(request.referenceUrls).not.toContain("https://example.com/street-high.png");
  });
});

describe("P10 — No derivative chain through a previous camera render", () => {
  it("R1 exists; a second generation anchors on the structured source graph", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);

    const first = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    const r1Url = useEditorStore.getState().doc!.assets[first.assetId].storageUrl;

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) });

    expect(generateImage).toHaveBeenCalledTimes(2);
    const request = generateImage.mock.calls[1][0];
    expect(request.referenceUrls).toEqual(["https://example.com/street.png", "https://example.com/yuri.png"]);
    expect(request.referenceUrls).not.toContain(r1Url);
  });
});

describe("P11 — LOCAL camera: zero API", () => {
  it("tightening full → medium refuses generation and stages normally", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);

    const plan = planPanelCamera(useEditorStore.getState().doc!, {
      panelId: s.panelId,
      camera: createPanelCamera({ shot: "medium", angle: "eye-level" }),
    });
    expect(plan.requiresRedraw).toBe(false);

    await expect(
      applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ shot: "medium", angle: "eye-level" }) }),
    ).rejects.toThrow(/no generation needed/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("P12 — GENERATIVE camera records intent, never fakes the shift", () => {
  it("Eye Level → High: requested camera stored, old artwork untouched, generate once", async () => {
    const s = studio();
    mount(s.doc);
    const yuriItem = place(s.panelId, s.yuriRefAssetId);
    const beforeItem = useEditorStore.getState().doc!.items[yuriItem.createdId!]!;

    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "high" } });

    const doc = useEditorStore.getState().doc!;
    // The REQUESTED camera is High…
    expect(doc.panels[s.panelId].camera?.angle).toBe("high");
    // …but the old artwork did NOT perform a fake High shift.
    const afterItem = doc.items[yuriItem.createdId!]!;
    expect(afterItem.cx).toBe(beforeItem.cx);
    expect(afterItem.cy).toBe(beforeItem.cy);
    expect(afterItem.width).toBe(beforeItem.width);
    expect(afterItem.height).toBe(beforeItem.height);
    // And the UI verdict agrees a redraw is required.
    expect(planPanelCamera(doc, { panelId: s.panelId, camera: doc.panels[s.panelId].camera! }).requiresRedraw).toBe(true);

    await applyPanelCamera({ panelId: s.panelId, camera: doc.panels[s.panelId].camera! });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it("a generative camera change retires the stale active render", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(useEditorStore.getState().doc!.panels[s.panelId].activeCameraRenderAssetId).toBeDefined();

    useEditorStore.getState().dispatch({ type: "set-panel-camera", panelId: s.panelId, patch: { angle: "low" } });
    expect(useEditorStore.getState().doc!.panels[s.panelId].activeCameraRenderAssetId).toBeUndefined();
  });
});

describe("P13 — Aspect contract: portrait panel, portrait request", () => {
  it("size=portrait and portrait semantics; never 'Landscape orientation, 3:2'", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);
    // Make the panel tall: width 0.2, height 0.8 of the page.
    useEditorStore.getState().dispatch({
      type: "reshape-panel",
      panelId: s.panelId,
      points: [
        { x: 0.1, y: 0.05 },
        { x: 0.3, y: 0.05 },
        { x: 0.3, y: 0.85 },
        { x: 0.1, y: 0.85 },
      ],
    });

    await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });

    const request = generateImage.mock.calls[0][0];
    expect(request.size).toBe("portrait");
    expect(request.prompt).toContain("Portrait orientation, 2:3");
    expect(request.prompt).not.toContain("Landscape orientation, 3:2");
  });
});

describe("P15 — duplicate instances of the SAME character are one participant", () => {
  it("Yuri placed twice: one canonical reference, generation succeeds", async () => {
    const s = studio();
    mount(s.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);

    const participants = resolvePanelVisualParticipants(useEditorStore.getState().doc!, s.panelId);
    expect(participants.filter((p) => p.kind === "character")).toHaveLength(1);

    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(result.generationCalls).toBe(1);
    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toEqual(["https://example.com/street.png", "https://example.com/yuri.png"]);
  });
});

describe("P16 — same root image via different assets merges into ONE reference", () => {
  it("placed Street A + interaction record pointing at derivative B: one scene reference, no false identity fault", async () => {
    const s = studio();
    const derivative = addAsset(s.doc, {
      category: "background",
      name: "Tokyo Street · high · wide",
      storageUrl: "https://example.com/street-high.png",
      width: 1600,
      height: 900,
      metadata: { referenceAssetIds: [s.streetId], cameraShot: "wide", cameraAngle: "high" },
    });
    const created = createInteraction(derivative.doc, {
      panelId: s.panelId,
      participantIds: [s.yuriId],
      participants: [
        { id: s.yuriId, kind: "character", role: "initiator" },
        { id: derivative.assetId, kind: "scene", role: "target" },
      ],
      type: "walk",
      source: "manual",
      renderMode: "composite",
    });
    mount(created.doc);
    place(s.panelId, s.yuriRefAssetId);
    place(s.panelId, s.streetId);

    const result = await applyPanelCamera({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) });

    expect(result.generationCalls).toBe(1);
    const request = generateImage.mock.calls[0][0];
    // Both scene mentions root to Street A — the shot sends it ONCE.
    expect(request.referenceUrls).toHaveLength(2);
    expect(request.referenceUrls).toEqual(
      expect.arrayContaining(["https://example.com/yuri.png", "https://example.com/street.png"]),
    );
    expect(request.prompt).toContain("Tokyo Street");
  });
});

describe("P14 — v0.2 interaction baseline untouched by the panel camera", () => {
  it("a plain interaction render (no camera intent) keeps the baseline contract", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.yuriId, s.yuiId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    mount(created.doc);

    await rerenderInteraction(created.interactionId);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    // Baseline shape: character cutout, portrait, canonical refs, no panel camera fields.
    expect(request.assetType).toBe("character");
    expect(request.size).toBe("portrait");
    expect(request.referenceUrls).toEqual(["https://example.com/yuri.png", "https://example.com/yui.png"]);
    expect(request.prompt).toContain("Hug: Yuri and Yui.");
    expect(request.prompt).not.toContain("camera angle");
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.metadata.panelCameraRender).toBeUndefined();
  });
});
