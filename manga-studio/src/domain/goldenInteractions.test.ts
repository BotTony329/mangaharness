/**
 * Golden Cases — the v0.2 acceptance contract, executable.
 *
 * CASE 1 (HUG):   character↔character, direction editable, no stale reuse.
 * CASE 2 (RAMEN): character↔object, "eat", both references travel.
 * CASE 3 (CAR):   character↔scene, "drive", driver-seat zone reaches the prompt.
 *
 * These run at the domain/service seam: no provider calls, no store. The
 * provider boundary is covered elsewhere; here we prove the SEMANTICS survive
 * creation, editing, caching and persistence.
 */
import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import {
  buildInteractionRenderRequest,
  createInteraction,
  findInteractionRender,
  interactionCacheKey,
  recordInteractionRender,
  updateInteraction,
} from "./interactions";
import { resolveInteraction as resolveStrategy } from "../services/interactionResolver";
import { resolveInteraction as resolveWording } from "../agent-v3/routing/interactionSemantics";
import { deserializeProject, serializeProject } from "./serialization";
import type { ProjectDocument } from "./types";

function studio() {
  let doc: ProjectDocument = createProjectDocument("Golden");
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
  const ramen = addAsset(doc, {
    category: "prop",
    name: "Ramen bowl",
    storageUrl: "https://example.com/ramen.png",
    width: 400,
    height: 400,
    metadata: { affordances: ["eat", "hold"] },
  });
  doc = ramen.doc;
  const car = addAsset(doc, {
    category: "background",
    name: "Car interior",
    storageUrl: "https://example.com/car.png",
    width: 1200,
    height: 800,
    metadata: { zones: ["driver-seat", "passenger-seat"] },
  });
  doc = car.doc;
  return {
    doc,
    panelId: Object.keys(doc.panels)[0],
    mikaId: mika.characterId,
    renId: ren.characterId,
    mikaRefId: mikaRef.assetId,
    renRefId: renRef.assetId,
    ramenId: ramen.assetId,
    carId: car.assetId,
  };
}

const keyOf = (doc: ProjectDocument, interactionId: string) => {
  const interaction = doc.interactions[interactionId];
  return interactionCacheKey({
    participantCharacterIds: interaction.participantIds,
    participantKeys: (interaction.participants ?? []).map(
      (p) => `${p.kind}:${p.id}${p.socket ? `@${p.socket}` : ""}${p.zone ? `#${p.zone}` : ""}`,
    ),
    type: interaction.type,
    parameters: interaction.parameters,
    outfits: interaction.participantIds.map(() => "default outfit"),
    view: "front",
    styleProfileId: "golden-style",
  });
};

describe("Golden CASE 1 — HUG with editable direction", () => {
  it("creates, edits direction, and never reuses a stale render", () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId, s.renId],
      type: "hug",
    });
    const before = created.doc.interactions[created.interactionId];

    // Edit: direction becomes "from behind" — a different drawing.
    const edited = updateInteraction(created.doc, created.interactionId, {
      parameters: { direction: "from behind" },
    });
    const after = edited.interactions[created.interactionId];
    expect(after.parameters?.direction).toBe("from behind");

    // Immutability: the pre-edit document is untouched, so undo restores it exactly.
    expect(before.parameters).toBeUndefined();

    // The prompt carries the direction.
    const request = buildInteractionRenderRequest(edited, after, {});
    expect(request.interactionConstraints.join(" ")).toContain("direction: from behind");
    expect(request.participantReferenceAssetIds).toEqual([s.mikaRefId, s.renRefId]);

    // A render recorded BEFORE the edit cannot satisfy the edited interaction.
    const oldKey = keyOf(created.doc, created.interactionId);
    const withRender = recordInteractionRender(created.doc, {
      interactionId: created.interactionId,
      participantCharacterIds: [s.mikaId, s.renId],
      participantReferenceAssetIds: [s.mikaRefId, s.renRefId],
      generatedAssetId: s.mikaRefId,
      cacheKey: oldKey,
    }).doc;
    const newKey = keyOf(edited, created.interactionId);
    expect(newKey).not.toBe(oldKey);
    expect(findInteractionRender(withRender, oldKey)).not.toBeNull();
    expect(findInteractionRender(withRender, newKey)).toBeNull();

    // Persistence: participants + parameters survive a save/load round-trip.
    const reloaded = deserializeProject(serializeProject(edited));
    expect(reloaded.interactions[created.interactionId].parameters?.direction).toBe("from behind");
    expect(reloaded.interactions[created.interactionId].participants).toHaveLength(2);
  });

  it("Agent wording maps 'hug from behind' to hug + direction (round-trip)", () => {
    const resolved = resolveWording("hug from behind");
    expect(resolved?.type).toBe("hug");
    expect(resolved?.parameters).toEqual({ direction: "from behind" });
  });
});

describe("Golden CASE 2 — RAMEN, character eats an object", () => {
  it("creates a character↔object interaction with both references in the render request", () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId],
      participants: [
        { id: s.mikaId, kind: "character", role: "initiator" },
        { id: s.ramenId, kind: "object", role: "target" },
      ],
      type: "eat",
      source: "manual",
    });
    const interaction = created.doc.interactions[created.interactionId];
    expect(interaction.participants).toHaveLength(2);
    expect(interaction.participantIds).toEqual([s.mikaId]);

    // Objects always mean one interaction-aware render — never sprite overlap.
    expect(resolveStrategy(created.doc, interaction).strategy).toBe("GENERATE");

    // The character's identity AND the actual bowl both travel as references.
    const request = buildInteractionRenderRequest(created.doc, interaction, {});
    expect(request.participantReferenceAssetIds).toEqual([s.mikaRefId, s.ramenId]);
    expect(request.interactionConstraints.join(" ")).toContain("Ramen bowl");
  });

  it("rejects a scene passed as an object (kind/category contract)", () => {
    const s = studio();
    expect(() =>
      createInteraction(s.doc, {
        panelId: s.panelId,
        participantIds: [s.mikaId],
        participants: [
          { id: s.mikaId, kind: "character" },
          { id: s.carId, kind: "object" },
        ],
        type: "eat",
      }),
    ).toThrow(/not a prop/);
  });
});

describe("Free-text interaction — the creator's words lead the prompt", () => {
  it("custom instruction becomes the first constraint, structure stays supporting", () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId],
      participants: [
        { id: s.mikaId, kind: "character", role: "initiator" },
        { id: s.ramenId, kind: "object", role: "target" },
      ],
      type: "eat",
      parameters: { customInstruction: "Mika holds the ramen bowl with both hands and lifts it toward her face.", hand: "both" },
      source: "manual",
    });
    const interaction = created.doc.interactions[created.interactionId];
    const request = buildInteractionRenderRequest(created.doc, interaction, {});

    // The sentence leads verbatim; the hand parameter supports, not duplicates.
    expect(request.interactionConstraints[0]).toBe(
      "Mika holds the ramen bowl with both hands and lifts it toward her face.",
    );
    expect(request.interactionConstraints.join(" ")).toContain("using both hands");
    expect(request.interactionConstraints.join(" ")).not.toContain("Eat:");
    expect(request.participantReferenceAssetIds).toEqual([s.mikaRefId, s.ramenId]);

    // Editing the prompt busts the cache — a reworded interaction is a new drawing.
    const edited = updateInteraction(created.doc, created.interactionId, {
      parameters: { ...interaction.parameters, customInstruction: "Mika slurps the noodles, eyes closed." },
    });
    expect(keyOf(edited, created.interactionId)).not.toBe(keyOf(created.doc, created.interactionId));

    // Persistence round-trip keeps the prompt.
    const reloaded = deserializeProject(serializeProject(edited));
    expect(reloaded.interactions[created.interactionId].parameters?.customInstruction).toContain("slurps");
  });
});

describe("Golden CASE 3 — CAR, character drives a scene", () => {
  it("carries the driver-seat zone into the render request and the cache identity", () => {
    const s = studio();
    const created = createInteraction(s.doc, {
      panelId: s.panelId,
      participantIds: [s.mikaId],
      participants: [
        { id: s.mikaId, kind: "character", role: "driver" },
        { id: s.carId, kind: "scene", role: "target", zone: "driver-seat" },
      ],
      type: "drive",
      source: "agent",
    });
    const interaction = created.doc.interactions[created.interactionId];
    expect(resolveStrategy(created.doc, interaction).strategy).toBe("GENERATE");

    const request = buildInteractionRenderRequest(created.doc, interaction, {});
    expect(request.participantReferenceAssetIds).toEqual([s.mikaRefId, s.carId]);
    expect(request.interactionConstraints.join(" ")).toContain("driver-seat");
    // The zone is a promise about the picture: driver-seat ⇒ steering wheel.
    expect(request.interactionConstraints.join(" ")).toContain("steering wheel");

    // Moving the character to another seat is a different drawing.
    const moved = updateInteraction(created.doc, created.interactionId, {
      participants: [
        { id: s.mikaId, kind: "character", role: "driver" },
        { id: s.carId, kind: "scene", role: "target", zone: "passenger-seat" },
      ],
    });
    expect(keyOf(moved, created.interactionId)).not.toBe(keyOf(created.doc, created.interactionId));
  });
});
