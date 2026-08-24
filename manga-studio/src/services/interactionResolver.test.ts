/**
 * InteractionResolver: strategy decisions for the three participant mixes and
 * the depiction-changing parameters — pure, no provider involved.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { createInteraction } from "@/domain/interactions";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ProjectDocument } from "@/domain/types";
import { resolveInteraction } from "./interactionResolver";

function docWithCast(): ProjectDocument {
  let doc = createProjectDocument("resolver");
  doc = addCharacter(doc, "Yuri").doc;
  doc = addCharacter(doc, "Mio").doc;
  doc = addAsset(doc, { name: "ramen", category: "prop", storageUrl: "/api/files/ramen.png", width: 400, height: 400 }).doc;
  doc = addAsset(doc, { name: "car", category: "background", storageUrl: "/api/files/car.png", width: 800, height: 600 }).doc;
  return doc;
}

const id = {
  by: (doc: ProjectDocument) => ({
    yuri: Object.values(doc.characters).find((c) => c.name === "Yuri")!.id,
    mio: Object.values(doc.characters).find((c) => c.name === "Mio")!.id,
    ramen: Object.values(doc.assets).find((a) => a.name === "ramen")!.id,
    car: Object.values(doc.assets).find((a) => a.name === "car")!.id,
    panel: Object.values(doc.panels)[0].id,
  }),
};

describe("resolveInteraction", () => {
  it("placement-only character interaction → COMPOSE", () => {
    const doc = docWithCast();
    const { yuri, mio, panel } = id.by(doc);
    const { doc: next, interactionId } = createInteraction(doc, { panelId: panel, participantIds: [yuri, mio], type: "beside" });
    expect(resolveInteraction(next, next.interactions[interactionId]).strategy).toBe("COMPOSE");
  });

  it("overlap interaction without rigs → GENERATE (v0.1 verdict preserved)", () => {
    const doc = docWithCast();
    const { yuri, mio, panel } = id.by(doc);
    const { doc: next, interactionId } = createInteraction(doc, { panelId: panel, participantIds: [yuri, mio], type: "hug" });
    expect(resolveInteraction(next, next.interactions[interactionId]).strategy).toBe("GENERATE");
  });

  it("object participant → GENERATE (not an overlay)", () => {
    const doc = docWithCast();
    const { yuri, ramen, panel } = id.by(doc);
    const { doc: next, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri],
      participants: [
        { id: yuri, kind: "character", role: "initiator" },
        { id: ramen, kind: "object", role: "target" },
      ],
      type: "eat",
    });
    const resolution = resolveInteraction(next, next.interactions[interactionId]);
    expect(resolution.strategy).toBe("GENERATE");
    expect(resolution.reason).toContain("object");
  });

  it("scene participant with zone → GENERATE", () => {
    const doc = docWithCast();
    const { yuri, car, panel } = id.by(doc);
    const { doc: next, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri],
      participants: [
        { id: yuri, kind: "character", role: "driver" },
        { id: car, kind: "scene", zone: "driver-seat" },
      ],
      type: "drive",
    });
    expect(resolveInteraction(next, next.interactions[interactionId]).strategy).toBe("GENERATE");
  });

  it("depiction-changing parameters force GENERATE even for placement types", () => {
    const doc = docWithCast();
    const { yuri, mio, panel } = id.by(doc);
    const { doc: next, interactionId } = createInteraction(doc, {
      panelId: panel,
      participantIds: [yuri, mio],
      type: "beside",
      parameters: { direction: "from behind" },
    });
    expect(resolveInteraction(next, next.interactions[interactionId]).strategy).toBe("GENERATE");
  });
});
