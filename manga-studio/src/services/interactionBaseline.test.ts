/**
 * CASE A PROTECTED BASELINE — Character↔Character joint generation contract.
 *
 * The hug between two characters is the human-verified success path. This test
 * locks its generation REQUEST contract — assetType, size, reference order,
 * prompt key sentences, registration category — BEFORE the Object/Scene
 * composition profiles are added. Any drift here after the refactor is a
 * regression by definition, not a refactor side effect.
 *
 * Runs at the service seam with the provider mocked: we assert WHAT would be
 * sent to the provider, not pixels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { createInteraction } from "@/domain/interactions";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

const generateImage = vi.fn();
const registerGeneratedAsset = vi.fn();

vi.mock("@/services/generation", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  registerGeneratedAsset: (...args: unknown[]) => registerGeneratedAsset(...args),
}));

import { renderInteraction } from "./interaction";

function studioWithPair() {
  let doc: ProjectDocument = createProjectDocument("Baseline");
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
  const created = createInteraction(doc, {
    panelId: Object.keys(doc.panels)[0],
    participantIds: [mika.characterId, ren.characterId],
    type: "hug",
    source: "manual",
  });
  return {
    doc: created.doc,
    interactionId: created.interactionId,
    panelId: Object.keys(created.doc.panels)[0],
    mikaId: mika.characterId,
    renId: ren.characterId,
    mikaRefId: mikaRef.assetId,
    renRefId: renRef.assetId,
  };
}

describe("CASE A — Character↔Character protected baseline", () => {
  beforeEach(() => {
    generateImage.mockReset();
    registerGeneratedAsset.mockReset();
    generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
    registerGeneratedAsset.mockResolvedValue("composite-asset-1");
  });

  it("hug request contract is byte-stable: character cutout, portrait, ordered references", async () => {
    const { doc, interactionId } = studioWithPair();
    useEditorStore.setState({ doc } as never);

    const outcome = await renderInteraction(interactionId);
    expect(outcome.assetId).toBe("composite-asset-1");
    expect(outcome.generationCalls).toBe(1);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const request = generateImage.mock.calls[0][0];

    // Generation mode: the character cutout pipeline, portrait, both canonical
    // references in participant order. This is the baseline being protected.
    expect(request.assetType).toBe("character");
    expect(request.size).toBe("portrait");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/ren.png"]);

    // Prompt key sentences that make the current quality what it is.
    expect(request.prompt).toContain("Full-body sequential-art character design.");
    expect(request.prompt).toContain("Hug: Mika and Ren.");
    expect(request.prompt).toContain(
      "Preserve Mika's exact face, hairstyle and proportions from reference image 1.",
    );
    expect(request.prompt).toContain(
      "Preserve Ren's exact face, hairstyle and proportions from reference image 2.",
    );
    // The full prompt is snapshotted so ANY wording drift fails loudly.
    expect(request.prompt).toMatchSnapshot();

    // Result lifecycle: registered as a character-category composite with provenance.
    expect(registerGeneratedAsset).toHaveBeenCalledTimes(1);
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.assetType).toBe("character");
    expect(registration.category).toBe("character");
    expect(registration.metadata.interactionId).toBe(interactionId);
  });
});

describe("CASE B — Character↔Object joint generation", () => {
  beforeEach(() => {
    generateImage.mockReset();
    registerGeneratedAsset.mockReset();
    generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
    registerGeneratedAsset.mockResolvedValue("composite-asset-2");
  });

  it("ramen: both references travel, no single-character isolation, merged cutout", async () => {
    const { doc: base, mikaId } = studioWithPair();
    let doc = base;
    const ramen = addAsset(doc, {
      category: "prop",
      name: "Ramen bowl",
      storageUrl: "https://example.com/ramen.png",
      width: 400,
      height: 400,
      metadata: { affordances: ["eat", "hold"] },
    });
    doc = ramen.doc;
    const created = createInteraction(doc, {
      panelId: Object.keys(doc.panels)[0],
      participantIds: [mikaId],
      participants: [
        { id: mikaId, kind: "character", role: "initiator" },
        { id: ramen.assetId, kind: "object", role: "target" },
      ],
      type: "eat",
      parameters: {
        customInstruction: "Mika holds the ramen bowl with both hands and lifts it toward her face.",
        hand: "both",
      },
      source: "manual",
    });
    doc = created.doc;
    useEditorStore.setState({ doc } as never);

    await renderInteraction(created.interactionId);

    const request = generateImage.mock.calls[0][0];
    // Same joint generation core: character cutout pipeline, both references.
    expect(request.assetType).toBe("character");
    expect(request.size).toBe("portrait");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/ramen.png"]);

    // The creator's words lead; the object is preserved, not invented.
    expect(request.prompt).toContain(
      "Mika holds the ramen bowl with both hands and lifts it toward her face.",
    );
    expect(request.prompt).toContain('the object "Ramen bowl"');
    expect(request.prompt).toContain("preserve its recognizable appearance, shape and important visual properties");
    expect(request.prompt).toContain("realistic hand contact, grip, overlap and occlusion");

    // The object must NOT be fought by single-character isolation wording.
    expect(request.prompt).not.toContain("Isolated single character");
    expect(request.prompt).not.toContain("no surface it rests on");
    expect(request.prompt).not.toContain("No scenery, no environment");

    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.category).toBe("character");
  });
});

describe("CASE C — Character↔Scene joint generation", () => {
  beforeEach(() => {
    generateImage.mockReset();
    registerGeneratedAsset.mockReset();
    generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
    registerGeneratedAsset.mockResolvedValue("composite-asset-3");
  });

  it("street: opaque scene composite, panel aspect, no cutout wording, scene preserved", async () => {
    const { doc: base, mikaId, panelId } = studioWithPair();
    let doc = base;
    const street = addAsset(doc, {
      category: "background",
      name: "Tokyo Street",
      storageUrl: "https://example.com/street.png",
      width: 1600,
      height: 900,
    });
    doc = street.doc;
    const created = createInteraction(doc, {
      panelId,
      participantIds: [mikaId],
      participants: [
        { id: mikaId, kind: "character", role: "initiator" },
        { id: street.assetId, kind: "scene", role: "target" },
      ],
      type: "walk",
      parameters: { customInstruction: "Mika is walking in the middle of this street, facing forward." },
      source: "manual",
    });
    doc = created.doc;
    // Give the target panel a wide frame so aspect inheritance is observable.
    doc = {
      ...doc,
      panels: {
        ...doc.panels,
        [panelId]: {
          ...doc.panels[panelId],
          points: [
            { x: 0, y: 0 },
            { x: 1600, y: 0 },
            { x: 1600, y: 900 },
            { x: 0, y: 900 },
          ],
        },
      },
    };
    useEditorStore.setState({ doc } as never);

    await renderInteraction(created.interactionId);

    const request = generateImage.mock.calls[0][0];
    // Opaque scene composite: the background route switches OFF white
    // background, transparency and background removal server-side.
    expect(request.assetType).toBe("background");
    // A wide target panel means the scene composite is landscape.
    expect(request.size).toBe("landscape");
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/street.png"]);

    expect(request.prompt).toContain("Mika is walking in the middle of this street, facing forward.");
    expect(request.prompt).toContain('the scene "Tokyo Street"');
    expect(request.prompt).toContain(
      "preserve its environment, composition, architecture, lighting and visual style",
    );
    expect(request.prompt).toContain("Preserve Mika's exact face");

    // Forbidden cutout wording must never reach a scene composite.
    expect(request.prompt).not.toContain("Isolated single character");
    expect(request.prompt).not.toContain("No scenery, no environment");
    expect(request.prompt).not.toContain("white background");
    expect(request.prompt).not.toContain("transparent");

    // Opaque result must be registered as background, or the transparency
    // contract would blank the placed instance out of the canvas.
    const registration = registerGeneratedAsset.mock.calls[0][0];
    expect(registration.assetType).toBe("background");
    expect(registration.category).toBe("background");
  });
});
