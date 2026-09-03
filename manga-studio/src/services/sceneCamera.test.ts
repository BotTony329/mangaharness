/**
 * Generative Scene Camera (v0.3 Phase 3) — Golden Cases B1–B5 plus the
 * no-camera scenery baseline lock.
 *
 * Same seam discipline as characterCamera.test.ts: the provider is mocked, so
 * we prove WHAT would be sent, which reference anchors it, and how the panel
 * swaps — never pixels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset } from "@/domain/libraryOps";
import { createPanelCamera } from "@/domain/camera";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

const generateImage = vi.fn();
const registerGeneratedAsset = vi.fn();

vi.mock("@/services/generation", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  registerGeneratedAsset: (...args: unknown[]) => registerGeneratedAsset(...args),
  imageProviderCapabilities: async () => ({ referenceImage: true, nativeTransparency: false }),
}));

import { buildSceneryRequest } from "@/services/scenery";
import { panelAspectFor } from "@/services/cameraResolver";
import { redrawSceneForCamera } from "./sceneCamera";

/** A project whose panel hosts one scene asset ("Old Street"). */
function streetScene() {
  let doc: ProjectDocument = createProjectDocument("SceneCamera");
  const scene = addAsset(doc, {
    category: "background",
    name: "Old Street",
    storageUrl: "https://example.com/street.png",
    width: 1600,
    height: 900,
  });
  doc = scene.doc;
  const panelId = Object.keys(doc.panels)[0];
  useEditorStore.setState({ doc } as never);
  const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: scene.assetId });
  return { doc: useEditorStore.getState().doc!, panelId, sceneId: scene.assetId, instanceId: placed.createdId! };
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  // Register for real (domain-level) so the panel swap finds the asset.
  registerGeneratedAsset.mockImplementation(async (input: { category: "background"; name: string; metadata?: object }) => {
    const current = useEditorStore.getState().doc!;
    const added = addAsset(current, {
      category: input.category,
      name: input.name,
      storageUrl: "https://example.com/generated-bg.png",
      width: 1600,
      height: 900,
      metadata: input.metadata,
    });
    useEditorStore.setState({ doc: added.doc } as never);
    return added.assetId;
  });
});

describe("NO-CAMERA BASELINE — scenery generation without a camera is unchanged", () => {
  it("buildSceneryRequest output is stable (scenery.ts untouched by Phase 3)", () => {
    const doc = createProjectDocument("Baseline");
    const request = buildSceneryRequest(doc, "background", "a rainy neon street at night");
    expect(request.assetType).toBe("background");
    expect(request.prompt).toContain("a rainy neon street at night");
    expect(request.prompt).not.toContain("camera");
    expect(request).toMatchSnapshot();
  });
});

describe("CASE B1 — Low Angle on a scene", () => {
  it("redraws with the camera sentence, scene identity lock, hard reference, background contract and panel aspect", async () => {
    const s = streetScene();
    const panel = s.doc.panels[s.panelId];

    const result = await redrawSceneForCamera({ instanceId: s.instanceId, camera: createPanelCamera({ angle: "low" }) });

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    expect(request.prompt).toContain("Low camera angle looking up at the subject; eye level below the subject.");
    // The scene-specific rule: environment identity locked, only the viewpoint moves.
    expect(request.prompt).toContain('Preserve the identity and recognizable structure of "Old Street"');
    // Hard reference: the scene's OWN image, never text alone.
    expect(request.referenceUrls).toEqual(["https://example.com/street.png"]);
    // Opaque contract: background asset type, aspect inherited from the panel.
    expect(request.assetType).toBe("background");
    expect(request.size).toBe(panelAspectFor(panel));

    // Non-destructive: instance swapped to the derivative, original retained.
    const after = useEditorStore.getState().doc!;
    const swapped = after.items[s.instanceId];
    expect(swapped.kind === "asset" && swapped.sourceAssetId).toBe(result.assetId);
    expect(after.assets[result.previousAssetId]).toBeTruthy();
    expect(after.assets[result.assetId]?.metadata?.referenceAssetIds).toEqual([s.sceneId]);
    expect(after.assets[result.assetId]?.metadata?.cameraAngle).toBe("low");
  });
});

describe("CASE B2 — Overhead", () => {
  it("prompt states the overhead viewpoint explicitly", async () => {
    const s = streetScene();
    await redrawSceneForCamera({ instanceId: s.instanceId, camera: createPanelCamera({ angle: "overhead" }) });
    expect(generateImage.mock.calls[0][0].prompt).toContain("Overhead bird's-eye view looking straight down.");
  });
});

describe("CASE B3 — Perspective rig forces a redraw", () => {
  it("three-point convergence is generative and the prompt carries the perspective instruction", async () => {
    const s = streetScene();
    const perspective = {
      type: "three-point" as const,
      horizonY: 0.5,
      vanishingPoints: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 1.4 }],
      visible: true,
      snapEnabled: true,
    };
    await redrawSceneForCamera({ instanceId: s.instanceId, camera: createPanelCamera(), perspective });
    const request = generateImage.mock.calls[0][0];
    expect(request.prompt).toContain("Three-point perspective with the horizon");
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
});

describe("CASE B4 — Widening shot (close-up → wide) anchors on the scene's own render", () => {
  it("the derivative is drawn from the source scene reference, not invented", async () => {
    let doc: ProjectDocument = createProjectDocument("SceneCameraWide");
    const closeUp = addAsset(doc, {
      category: "background",
      name: "Old Street close",
      storageUrl: "https://example.com/street-close.png",
      width: 900,
      height: 900,
      metadata: { cameraShot: "close-up" as const },
    });
    doc = closeUp.doc;
    const panelId = Object.keys(doc.panels)[0];
    useEditorStore.setState({ doc } as never);
    const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: closeUp.assetId });

    await redrawSceneForCamera({
      instanceId: placed.createdId!,
      camera: createPanelCamera({ shot: "wide", angle: "eye-level" }),
    });

    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toEqual(["https://example.com/street-close.png"]);
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
});

describe("CASE B5 — LOCAL camera never generates", () => {
  it("wide → tighter crop refuses the service with zero API calls", async () => {
    const s = streetScene();
    // Scene defaults to a wide establishing view; a tighter crop needs no new content.
    await expect(
      redrawSceneForCamera({ instanceId: s.instanceId, camera: createPanelCamera({ shot: "medium", angle: "eye-level" }) }),
    ).rejects.toThrow(/no generation needed/);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("a scene without a renderable reference fails loudly instead of inventing a new place", async () => {
    let doc = createProjectDocument("NoRefScene");
    const scene = addAsset(doc, {
      category: "background",
      name: "ghost street",
      storageUrl: "https://example.com/ghost.png",
      width: 100,
      height: 100,
    });
    doc = scene.doc;
    const panelId = Object.keys(doc.panels)[0];
    useEditorStore.setState({ doc } as never);
    const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: scene.assetId });

    // A scene record with no image at all (storage lost / never rendered):
    // text alone would draw a DIFFERENT street, so the service must refuse.
    const stripped = useEditorStore.getState().doc!;
    useEditorStore.setState({
      doc: {
        ...stripped,
        assets: { ...stripped.assets, [scene.assetId]: { ...stripped.assets[scene.assetId], storageUrl: undefined } },
      },
    } as never);

    await expect(
      redrawSceneForCamera({ instanceId: placed.createdId!, camera: createPanelCamera({ angle: "low" }) }),
    ).rejects.toThrow(/no usable image/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("B2 — lineage root: a camera derivative redraw anchors the ORIGINAL scene", () => {
  it("Original A → High derivative B → Low redraw: the reference is A, never B", async () => {
    let doc: ProjectDocument = createProjectDocument("Lineage");
    const original = addAsset(doc, {
      category: "background",
      name: "Old Street",
      storageUrl: "https://example.com/street-original.png",
      width: 1600,
      height: 900,
    });
    doc = original.doc;
    // B is a prior camera derivative of A (provenance chain via referenceAssetIds).
    const derivative = addAsset(doc, {
      category: "background",
      name: "Old Street · high · medium",
      storageUrl: "https://example.com/street-high.png",
      width: 1600,
      height: 900,
      metadata: { referenceAssetIds: [original.assetId], cameraAngle: "high" as const, cameraShot: "medium" as const },
    });
    doc = derivative.doc;
    const panelId = Object.keys(doc.panels)[0];
    useEditorStore.setState({ doc } as never);
    const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: derivative.assetId });

    await redrawSceneForCamera({ instanceId: placed.createdId!, camera: createPanelCamera({ angle: "low" }) });

    // The second camera redraw must re-anchor on the original street — a
    // derivative-anchored chain compounds drift generation over generation.
    expect(generateImage.mock.calls[0][0].referenceUrls).toEqual(["https://example.com/street-original.png"]);
    // Provenance still records the swap source as the derivative being replaced.
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.metadata.referenceAssetIds).toEqual([derivative.assetId]);
  });
});
