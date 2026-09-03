/**
 * Generative Character Camera (v0.3 Phase 2) — Golden Cases A1–A5 plus the
 * no-camera baseline lock.
 *
 * Proved at the service seam with the provider mocked: WHAT would be sent,
 * which reference anchors it, and how the panel swaps — never pixels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
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

import { generateCharacterAssetForState } from "@/characters/stateRuntime";
import { DEFAULT_CHARACTER_STATE } from "@/characters/state";
import { redrawCharacterForCamera } from "./characterCamera";

function studio() {
  let doc: ProjectDocument = createProjectDocument("Camera");
  const mika = addCharacter(doc, "Mika");
  doc = mika.doc;
  const ref = addAsset(doc, {
    category: "character",
    name: "Mika reference",
    storageUrl: "https://example.com/mika.png",
    width: 800,
    height: 1600,
    metadata: { characterId: mika.characterId, characterAssetRole: "canonical" },
  });
  doc = ref.doc;
  return { doc, panelId: Object.keys(doc.panels)[0], mikaId: mika.characterId, refId: ref.assetId };
}

/** Place the canonical render in the panel and return the instance id. */
function placeMika(doc: ProjectDocument, panelId: string, refId: string): string {
  useEditorStore.setState({ doc } as never);
  const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: refId });
  return placed.createdId!;
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  // Register for real (domain-level) so the panel swap finds the asset.
  registerGeneratedAsset.mockImplementation(async (input: { category: "character"; name: string; metadata?: object }) => {
    const current = useEditorStore.getState().doc!;
    const added = addAsset(current, {
      category: input.category,
      name: input.name,
      storageUrl: "https://example.com/generated.png",
      width: 800,
      height: 1600,
      metadata: input.metadata,
    });
    useEditorStore.setState({ doc: added.doc } as never);
    return added.assetId;
  });
});

describe("NO-CAMERA BASELINE — character generation without a camera is unchanged", () => {
  it("request is byte-stable when no cameraContext rides along", async () => {
    const s = studio();
    useEditorStore.setState({ doc: s.doc } as never);
    await generateCharacterAssetForState({
      characterId: s.mikaId,
      state: { ...DEFAULT_CHARACTER_STATE, characterId: s.mikaId, pose: "walking" },
    });
    const request = generateImage.mock.calls[0][0];
    expect(request.assetType).toBe("character-pose");
    expect(request.size).toBe("portrait");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png"]);
    expect(request.prompt).toContain("Whole body visible head to feet.");
    expect(request.prompt).not.toContain("camera");
    expect(request.prompt).toMatchSnapshot();
  });
});

describe("CASE A1 — High Angle + Medium Shot", () => {
  it("redraws with camera semantics, identity lock, canonical anchor and a non-destructive swap", async () => {
    const s = studio();
    const instanceId = placeMika(s.doc, s.panelId, s.refId);

    const result = await redrawCharacterForCamera({
      instanceId,
      camera: createPanelCamera({ shot: "medium", angle: "high" }),
    });

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];
    expect(request.prompt).toContain("High camera angle looking down at the subject.");
    expect(request.prompt).toContain("Medium shot framed from roughly the waist up.");
    expect(request.prompt).toContain("Mika's identity and outfit are locked");
    // A camera framing owns the shot; the full-body clause must not contradict it.
    expect(request.prompt).not.toContain("Whole body visible head to feet.");
    // Canonical full-body reference anchors the redraw.
    expect(request.referenceUrls?.[0]).toBe("https://example.com/mika.png");

    // Non-destructive: instance swapped to the new state, old asset retained.
    const after = useEditorStore.getState().doc!;
    const swapped = after.items[instanceId];
    expect(swapped.kind === "asset" && swapped.sourceAssetId).toBe(result.assetId);
    expect(after.assets[result.previousAssetId]).toBeTruthy();
    expect(after.assets[result.assetId]?.metadata?.cameraAngle).toBe("high");
    expect(after.assets[result.assetId]?.metadata?.cameraShot).toBe("medium");
  });
});

describe("CASE A2 — Overhead", () => {
  it("prompt states the overhead viewpoint explicitly", async () => {
    const s = studio();
    const instanceId = placeMika(s.doc, s.panelId, s.refId);
    await redrawCharacterForCamera({ instanceId, camera: createPanelCamera({ angle: "overhead" }) });
    expect(generateImage.mock.calls[0][0].prompt).toContain("Overhead bird's-eye view looking straight down.");
  });
});

describe("CASE A3 — Large yaw (rear-like rotation, no schema change)", () => {
  it("45° yaw is generative and the prompt carries the viewpoint rotation", async () => {
    const s = studio();
    const instanceId = placeMika(s.doc, s.panelId, s.refId);
    const camera = { ...createPanelCamera(), yaw: 45 };
    await redrawCharacterForCamera({ instanceId, camera });
    expect(generateImage.mock.calls[0][0].prompt).toContain("Camera rotated 45° around the subject");
  });
});

describe("CASE A4 — Widening shot (close-up → full) anchors on the canonical full body", () => {
  it("uses the canonical reference instead of stretching the crop", async () => {
    const s = studio();
    // The current render is a close-up: widening to full needs content the
    // frame does not show.
    const closeUp = addAsset(s.doc, {
      category: "character",
      name: "Mika close-up",
      storageUrl: "https://example.com/mika-close.png",
      width: 800,
      height: 800,
      metadata: { characterId: s.mikaId, characterAssetRole: "state", cameraShot: "close-up" as const },
    });
    const instanceId = placeMika(closeUp.doc, s.panelId, closeUp.assetId);

    await redrawCharacterForCamera({ instanceId, camera: createPanelCamera({ shot: "full", angle: "eye-level" }) });

    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls?.[0]).toBe("https://example.com/mika.png");
  });
});

describe("CASE A5 — LOCAL camera never generates", () => {
  it("full → medium refuses the service with zero API calls", async () => {
    const s = studio();
    const instanceId = placeMika(s.doc, s.panelId, s.refId);
    await expect(
      redrawCharacterForCamera({ instanceId, camera: createPanelCamera({ shot: "medium", angle: "eye-level" }) }),
    ).rejects.toThrow(/no generation needed/);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("a camera redraw without an identity reference fails loudly", async () => {
    let doc = createProjectDocument("NoRef");
    const ghost = addCharacter(doc, "Ghost");
    doc = ghost.doc;
    // A failed cutout is NOT a usable identity reference: no renderable URL.
    const fake = addAsset(doc, {
      category: "character",
      name: "failed render",
      storageUrl: "https://example.com/y.png",
      width: 100,
      height: 100,
      processingStatus: "failed",
      metadata: { characterId: ghost.characterId },
    });
    doc = fake.doc;
    const panelId = Object.keys(doc.panels)[0];
    useEditorStore.setState({ doc } as never);
    const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId: fake.assetId });
    await expect(
      redrawCharacterForCamera({ instanceId: placed.createdId!, camera: createPanelCamera({ angle: "low" }) }),
    ).rejects.toThrow();
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("PATCH B — camera prompt authority (camera overrides legacy orientation)", () => {
  it.each([
    ["high", "High camera angle looking down at the subject."],
    ["low", "Low camera angle looking up at the subject; eye level below the subject."],
    ["overhead", "Overhead bird's-eye view looking straight down."],
  ] as const)("%s: camera semantics present, legacy orientation constraints gone, fidelity locks kept", async (angle, sentence) => {
    const s = studio();
    const instanceId = placeMika(s.doc, s.panelId, s.refId);

    await redrawCharacterForCamera({ instanceId, camera: createPanelCamera({ angle }) });

    const prompt: string = generateImage.mock.calls[0][0].prompt;
    // Camera semantics actually requested.
    expect(prompt).toContain(sentence);
    // The two confirmed conflicts must not fight the camera (Phase 4.1 audit).
    expect(prompt).not.toContain("View: front.");
    expect(prompt).not.toContain("Change only the requested pose and expression.");
    // Identity/outfit preservation survives — as the camera-aware variant.
    expect(prompt).toContain("Preserve the exact identity, face design, proportions, hairstyle, outfit, colors, accessories and line style");
    expect(prompt).toContain("do not redesign the character");
    expect(prompt).toContain("Mika's identity and outfit are locked");
    // Pose semantics retained; only geometric projection follows the camera.
    expect(prompt).toMatch(/Pose: standing\./i);
  });

  it("NO CAMERA: the legacy prompt keeps its orientation clauses byte-stable", async () => {
    const s = studio();
    useEditorStore.setState({ doc: s.doc } as never);
    await generateCharacterAssetForState({
      characterId: s.mikaId,
      state: { ...DEFAULT_CHARACTER_STATE, characterId: s.mikaId, pose: "walking" },
    });
    const prompt: string = generateImage.mock.calls[0][0].prompt;
    expect(prompt).toContain("View: front.");
    expect(prompt).toContain("Change only the requested pose and expression.");
    expect(prompt).not.toContain("camera");
  });
});
