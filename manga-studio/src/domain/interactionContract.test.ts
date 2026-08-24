/**
 * v0.2 interaction domain contract: participants beyond characters, editable
 * parameters, migration backfill, and cache keys that respect both.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "./factory";
import {
  createInteraction,
  interactionCacheKey,
  interactionLabel,
  interactionParticipants,
  updateInteraction,
} from "./interactions";
import { addAsset, addCharacter } from "./libraryOps";
import { deserializeProject, serializeProject } from "./serialization";
import type { ProjectDocument } from "./types";

function docWithCast(): ProjectDocument {
  let doc = createProjectDocument("interactions");
  doc = addCharacter(doc, "Yuri").doc;
  doc = addCharacter(doc, "Mio").doc;
  doc = addAsset(doc, {
    name: "ramen",
    category: "prop",
    mimeType: "image/png",
    storageUrl: "/api/files/ramen.png",
    width: 400,
    height: 400,
    metadata: { affordances: ["hold", "eat"] },
  }).doc;
  doc = addAsset(doc, {
    name: "car interior",
    category: "background",
    mimeType: "image/png",
    storageUrl: "/api/files/car.png",
    width: 1200,
    height: 800,
    metadata: { zones: ["driver-seat", "passenger-seat"] },
  }).doc;
  return doc;
}

const ids = (doc: ProjectDocument) => ({
  yuri: Object.values(doc.characters).find((c) => c.name === "Yuri")!.id,
  mio: Object.values(doc.characters).find((c) => c.name === "Mio")!.id,
  ramen: Object.values(doc.assets).find((a) => a.name === "ramen")!.id,
  car: Object.values(doc.assets).find((a) => a.name === "car interior")!.id,
  panel: Object.values(doc.panels)[0].id,
});

describe("interaction domain contract", () => {
  it("character↔object interaction: ramen is a formal participant", () => {
    const doc = docWithCast();
    const { yuri, ramen, panel } = ids(doc);
    const { doc: next, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri],
      participants: [
        { id: yuri, kind: "character", role: "initiator", socket: "both_hands" },
        { id: ramen, kind: "object", role: "target", socket: "container" },
      ],
      type: "eat",
      parameters: { customInstruction: "Yuri eats the ramen" },
      source: "manual",
    });
    const interaction = next.interactions[interactionId];
    expect(interaction.participants).toHaveLength(2);
    expect(interaction.participantIds).toEqual([yuri]); // mirror holds characters only
    expect(interaction.type).toBe("eat");
  });

  it("character↔scene interaction: car interior participates with a zone", () => {
    const doc = docWithCast();
    const { yuri, car, panel } = ids(doc);
    const { doc: next, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri],
      participants: [
        { id: yuri, kind: "character", role: "driver" },
        { id: car, kind: "scene", zone: "driver-seat" },
      ],
      type: "drive",
    });
    const participants = interactionParticipants(next.interactions[interactionId]);
    expect(participants[1]).toMatchObject({ kind: "scene", zone: "driver-seat" });
  });

  it("rejects a prop masquerading as a scene participant", () => {
    const doc = docWithCast();
    const { yuri, ramen, panel } = ids(doc);
    expect(() =>
      createInteraction(doc, {
        panelId: panel,
        participantIds: [yuri],
        participants: [
          { id: yuri, kind: "character" },
          { id: ramen, kind: "scene" },
        ],
        type: "drive",
      }),
    ).toThrowError(/not a background/);
  });

  it("updateInteraction edits parameters and keeps the mirror in sync", () => {
    const doc = docWithCast();
    const { yuri, mio, panel } = ids(doc);
    const { doc: created, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri, mio],
      type: "hug",
    });
    const next = updateInteraction(created, interactionId, {
      parameters: { direction: "from behind", intensity: 0.7 },
    });
    expect(next.interactions[interactionId].parameters?.direction).toBe("from behind");
    // The original document is untouched (immutability for undo).
    expect(created.interactions[interactionId].parameters).toBeUndefined();
  });

  it("custom verbs get a readable label without a registry entry", () => {
    expect(interactionLabel("hug")).toBe("Hug");
    expect(interactionLabel("drive")).toBe("Drive");
  });

  it("cache key: parameters and object participants change the entry", () => {
    const base = {
      participantCharacterIds: ["c1"],
      type: "hug",
      outfits: ["uniform"],
      view: "front",
    };
    const behind = { ...base, parameters: { direction: "from behind" } };
    expect(interactionCacheKey(behind)).not.toBe(interactionCacheKey(base));
    const withRamen = { ...base, type: "eat", participantKeys: ["character:c1", "object:a1"] };
    expect(interactionCacheKey(withRamen)).not.toBe(interactionCacheKey({ ...base, type: "eat" }));
  });

  it("v12 documents gain backfilled participants on load", () => {
    const doc = docWithCast();
    const { yuri, mio, panel } = ids(doc);
    const { doc: created } = createInteraction(doc, { panelId: panel, participantIds: [yuri, mio], type: "hug" });
    // Simulate a stored v12 document: no participants field anywhere.
    const legacy = JSON.parse(serializeProject(created)) as ProjectDocument;
    legacy.schemaVersion = 12;
    for (const interaction of Object.values(legacy.interactions)) delete interaction.participants;
    const loaded = deserializeProject(JSON.stringify(legacy));
    const interaction = Object.values(loaded.interactions)[0];
    expect(interaction.participants).toEqual([
      { id: yuri, kind: "character", role: "initiator" },
      { id: mio, kind: "character", role: "target" },
    ]);
  });
});
