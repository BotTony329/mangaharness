/**
 * Shot-level Generative Camera (v0.3 Phase 4) — Golden Cases C/D/E/F/G plus
 * camera cache identity.
 *
 * Same seam discipline as Phase 2/3: the provider is mocked, so we assert
 * ROUTING, WHAT would be sent, reference anchoring and lifecycle — never
 * pixels. The no-camera v0.2 regression is locked separately by
 * interactionBaseline.test.ts (byte-stable snapshots).
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
}));

import { applyCameraToShot } from "./shotCamera";
import { rerenderInteraction } from "./interaction";

interface Studio {
  doc: ProjectDocument;
  panelId: ID;
  mikaId: ID;
  renId: ID;
  streetId: ID;
  ramenId: ID;
}

function studio(): Studio {
  let doc: ProjectDocument = createProjectDocument("ShotCamera");
  const mika = addCharacter(doc, "Mika");
  doc = mika.doc;
  const ren = addCharacter(doc, "Ren");
  doc = ren.doc;
  const mikaRef = addAsset(doc, {
    category: "character",
    name: "Mika reference",
    storageUrl: "https://example.com/mika.png",
    width: 800,
    height: 1600,
    metadata: { characterId: mika.characterId, characterAssetRole: "canonical" },
  });
  doc = mikaRef.doc;
  const renRef = addAsset(doc, {
    category: "character",
    name: "Ren reference",
    storageUrl: "https://example.com/ren.png",
    width: 800,
    height: 1600,
    metadata: { characterId: ren.characterId, characterAssetRole: "canonical" },
  });
  doc = renRef.doc;
  const street = addAsset(doc, {
    category: "background",
    name: "Tokyo Street",
    storageUrl: "https://example.com/street.png",
    width: 1600,
    height: 900,
  });
  doc = street.doc;
  const ramen = addAsset(doc, {
    category: "prop",
    name: "Ramen bowl",
    storageUrl: "https://example.com/ramen.png",
    width: 400,
    height: 400,
    metadata: { affordances: ["eat", "hold"] },
  });
  doc = ramen.doc;
  return {
    doc,
    panelId: Object.keys(doc.panels)[0],
    mikaId: mika.characterId,
    renId: ren.characterId,
    streetId: street.assetId,
    ramenId: ramen.assetId,
  };
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  // Register for real (domain-level) so placement and cache reuse find the asset.
  registerGeneratedAsset.mockImplementation(async (input: { category: "character" | "background"; name: string; metadata?: object }) => {
    const current = useEditorStore.getState().doc!;
    const added = addAsset(current, {
      category: input.category,
      name: input.name,
      storageUrl: "https://example.com/generated.png",
      width: 1600,
      height: 900,
      metadata: input.metadata,
    });
    useEditorStore.setState({ doc: added.doc } as never);
    return added.assetId;
  });
});

describe("CASE C — Character↔Scene + camera routes to ONE joint generation", () => {
  it("walking + low angle + full shot: joint path, both references, single call, opaque composite", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId],
      participants: [
        { id: s.mikaId, kind: "character", role: "initiator" },
        { id: s.streetId, kind: "scene", role: "target" },
      ],
      type: "walk",
      parameters: { customInstruction: "Mika is walking in the middle of this street, facing forward." },
      source: "manual",
      renderMode: "composite",
    });
    useEditorStore.setState({ doc: created.doc } as never);

    const result = await applyCameraToShot({
      panelId: s.panelId,
      camera: createPanelCamera({ angle: "low", shot: "full" }),
    });

    // Routing: the formal interaction wins — never character camera + scene camera.
    expect(result.route).toBe("interaction");
    expect(result.generationCalls).toBe(1);
    expect(generateImage).toHaveBeenCalledTimes(1);

    const request = generateImage.mock.calls[0][0];
    // ONE unified shot: interaction intent + camera intent + both fidelities.
    expect(request.prompt).toContain("Mika is walking in the middle of this street, facing forward.");
    expect(request.prompt).toContain("Low camera angle looking up at the subject; eye level below the subject.");
    expect(request.prompt).toContain("Full shot: the whole body from head to feet.");
    expect(request.prompt).toContain("Mika's identity and outfit are locked");
    expect(request.prompt).toContain("preserve its environment, composition, architecture, lighting and visual style");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/street.png"]);

    // Opaque scene composite: no cutout wording, background pipeline.
    expect(request.assetType).toBe("background");
    expect(request.prompt).not.toContain("Isolated single character");
    expect(request.prompt).not.toContain("white background");

    // Provenance: the derivative knows the camera that drew it.
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.category).toBe("background");
    expect(registration.metadata.cameraAngle).toBe("low");
    expect(registration.metadata.cameraShot).toBe("full");
  });
});

describe("CASE D — Character↔Character + camera routes to ONE joint generation", () => {
  it("hug + overhead: joint path, both identity references, character cutout contract kept", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId, s.renId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    useEditorStore.setState({ doc: created.doc } as never);

    const result = await applyCameraToShot({
      panelId: s.panelId,
      camera: createPanelCamera({ angle: "overhead" }),
    });

    expect(result.route).toBe("interaction");
    expect(generateImage).toHaveBeenCalledTimes(1);

    const request = generateImage.mock.calls[0][0];
    expect(request.prompt).toContain("Hug: Mika and Ren.");
    expect(request.prompt).toContain("Overhead bird's-eye view looking straight down.");
    expect(request.prompt).toContain("Preserve Mika's exact face, hairstyle and proportions from reference image 1.");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/ren.png"]);
    // C↔C composition profile unchanged: character cutout, portrait.
    expect(request.assetType).toBe("character");
    expect(request.size).toBe("portrait");
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.category).toBe("character");
  });
});

describe("CASE E — Character↔Object + camera routes to ONE joint generation", () => {
  it("eat ramen + close-up high angle: fidelity locks survive the camera", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId],
      participants: [
        { id: s.mikaId, kind: "character", role: "initiator" },
        { id: s.ramenId, kind: "object", role: "target" },
      ],
      type: "eat",
      parameters: {
        customInstruction: "Mika holds the ramen bowl with both hands and lifts it toward her face.",
        hand: "both",
      },
      source: "manual",
      renderMode: "composite",
    });
    useEditorStore.setState({ doc: created.doc } as never);

    const result = await applyCameraToShot({
      panelId: s.panelId,
      camera: createPanelCamera({ angle: "high", shot: "close-up" }),
    });

    expect(result.route).toBe("interaction");
    expect(generateImage).toHaveBeenCalledTimes(1);

    const request = generateImage.mock.calls[0][0];
    expect(request.prompt).toContain("High camera angle looking down at the subject.");
    expect(request.prompt).toContain("Close-up framed on the head and shoulders.");
    // v0.2 fidelity locks ride along unchanged.
    expect(request.prompt).toContain("appears exactly once");
    expect(request.prompt).toContain("does not float");
    expect(request.prompt).toContain("realistic hand contact, grip, overlap and occlusion");
    expect(request.prompt).toContain("Mika's identity and outfit are locked");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/ramen.png"]);
  });
});

describe("CASE F — LOCAL camera on an interaction: zero API", () => {
  it("full → medium crop of an existing composite refuses generation", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId, s.renId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    useEditorStore.setState({ doc: created.doc } as never);
    // Establish a current composite framed at full shot.
    await rerenderInteraction(created.interactionId, { camera: createPanelCamera({ angle: "low", shot: "full" }) });
    expect(generateImage).toHaveBeenCalledTimes(1);
    generateImage.mockClear();

    await expect(
      applyCameraToShot({ panelId: s.panelId, camera: createPanelCamera({ shot: "medium", angle: "eye-level" }) }),
    ).rejects.toThrow(/no generation needed/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("CASE G — no formal interaction: unrelated assets are NEVER merged", () => {
  it("two characters in one panel without an interaction do not joint-generate", async () => {
    const s = studio();
    useEditorStore.setState({ doc: s.doc } as never);
    for (const ref of ["https://example.com/mika.png", "https://example.com/ren.png"]) {
      const asset = Object.values(useEditorStore.getState().doc!.assets).find((a) => a.storageUrl === ref)!;
      useEditorStore.getState().dispatch({ type: "add-instance", panelId: s.panelId, assetId: asset.id });
    }

    await expect(
      applyCameraToShot({ panelId: s.panelId, camera: createPanelCamera({ angle: "low" }) }),
    ).rejects.toThrow(/never merged/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("CAMERA CACHE IDENTITY — the camera is part of reuse", () => {
  it("overhead ≠ eye-level ≠ high: only an identical camera reuses the render", async () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId, s.renId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    useEditorStore.setState({ doc: created.doc } as never);

    const first = await applyCameraToShot({ panelId: s.panelId, camera: createPanelCamera({ angle: "overhead" }) });
    expect(first.generationCalls).toBe(1);

    // Same camera: cache hit, zero new generation.
    const second = await applyCameraToShot({ panelId: s.panelId, camera: createPanelCamera({ angle: "overhead" }) });
    expect(second.reusedCache).toBe(true);
    expect(second.generationCalls).toBe(0);

    // Different camera: a different drawing, so it generates again.
    const third = await applyCameraToShot({ panelId: s.panelId, camera: createPanelCamera({ angle: "high" }) });
    expect(third.generationCalls).toBe(1);
    expect(generateImage).toHaveBeenCalledTimes(2);
  });
});
