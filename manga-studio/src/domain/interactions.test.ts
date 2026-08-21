/**
 * Relationships and interactions.
 *
 * The property under test is not "an object was stored". It is that
 * `hug(Yuri, Mio)` is a single coordinated action with shared geometry, and
 * can never decay into two independent pose requests — which is what produces
 * arms that miss, torsos that interpenetrate and scales that disagree.
 */

import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { createFixturePuppet } from "@/puppet/fixture";
import { groundPrompt, resolveCharacterReference } from "@/agent/grounding";
import type { ID, ProjectDocument } from "@/domain/types";
import {
  addRelationship,
  relatedCharacters,
  relationshipTypeFromPhrase,
  removeRelationship,
} from "./relationships";
import {
  anchorDeviation,
  buildMultiCharacterRequest,
  charactersInAsset,
  createInteraction,
  evaluateInteractionCapability,
  findInteractionRender,
  interactionCacheKey,
  interactionTypeFromPhrase,
  midpointAnchor,
  recordInteractionRender,
} from "./interactions";

interface Cast {
  doc: ProjectDocument;
  yuri: ID;
  mio: ID;
  cuteGirl: ID;
  panelId: ID;
}

function cast(withPuppets = false): Cast {
  let doc = createProjectDocument("Interactions");
  const panelId = doc.pages[Object.keys(doc.pages)[0]].panelIds[0];
  const ids: Record<string, ID> = {};
  for (const name of ["Yuri", "Mio", "Cute Girl"]) {
    const added = addCharacter(doc, name);
    doc = added.doc;
    ids[name] = added.characterId;
    // Every character gets a canonical reference; joint generation requires one.
    const reference = addAsset(doc, {
      category: "character",
      name: `${name} canonical`,
      storageUrl: `https://example.com/${added.characterId}.png`,
      processedImageUrl: `https://example.com/${added.characterId}-cut.png`,
      width: 800,
      height: 1200,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: added.characterId, characterAssetRole: "canonical" },
    });
    doc = reference.doc;
    doc = applyDomainCommand(doc, {
      type: "set-character-reference",
      characterId: added.characterId,
      assetId: reference.assetId,
    }).doc;
    if (withPuppets) {
      doc = applyDomainCommand(doc, {
        type: "register-puppet",
        puppet: { ...createFixturePuppet({ characterId: added.characterId }), characterId: added.characterId },
      }).doc;
    }
  }
  return { doc, yuri: ids.Yuri, mio: ids.Mio, cuteGirl: ids["Cute Girl"], panelId };
}

const puppetOf = (doc: ProjectDocument, characterId: ID) => {
  const id = doc.characters[characterId]?.puppetId;
  return id ? doc.puppets[id] : undefined;
};

// ─── Relationships are structured facts ────────────────────────────────────

describe("relationship graph", () => {
  it("stores edges on stable character ids, both directions readable", () => {
    const c = cast();
    const { doc } = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "close_friend" });

    expect(relatedCharacters(doc, c.yuri, "close_friend").map((r) => r.characterId)).toEqual([c.mio]);
    expect(relatedCharacters(doc, c.mio, "close_friend").map((r) => r.characterId)).toEqual([c.yuri]);
  });

  it("refuses a self-relationship and an unknown character", () => {
    const c = cast();
    expect(() => addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.yuri, type: "friend" })).toThrow();
    expect(() => addRelationship(c.doc, { characterAId: c.yuri, characterBId: "nope", type: "friend" })).toThrow();
  });

  it("does not fork on re-adding the same pair and type", () => {
    const c = cast();
    const first = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "friend" });
    const second = addRelationship(first.doc, { characterAId: c.mio, characterBId: c.yuri, type: "friend", label: "childhood" });
    expect(second.relationshipId).toBe(first.relationshipId);
    expect(Object.keys(second.doc.relationships)).toHaveLength(1);
    expect(second.doc.relationships[first.relationshipId].label).toBe("childhood");
  });

  it("maps only explicit phrases to types", () => {
    expect(relationshipTypeFromPhrase("best friend")).toBe("close_friend");
    expect(relationshipTypeFromPhrase("sister")).toBe("sibling");
    expect(relationshipTypeFromPhrase("sensei")).toBe("teacher_student");
    // Not a recorded synonym — must not become a sibling.
    expect(relationshipTypeFromPhrase("bro")).toBeNull();
    expect(relationshipTypeFromPhrase("the tall one")).toBeNull();
  });

  it("survives save and reload", () => {
    const c = cast();
    const { doc } = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "close_friend" });
    const restored = deserializeProject(serializeProject(doc));
    expect(relatedCharacters(restored, c.yuri, "close_friend").map((r) => r.characterId)).toEqual([c.mio]);
  });
});

// ─── §21: relationship-aware grounding ─────────────────────────────────────

describe("relationship-aware grounding", () => {
  it("resolves 'her close friend' deterministically when the edge exists", () => {
    const c = cast();
    const { doc } = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "close_friend" });

    const report = groundPrompt({ doc, prompt: "Yuri hugs her close friend." });
    const friend = report.entities.find((entity) => entity.surface.toLowerCase().includes("close friend"));

    expect(friend).toMatchObject({ status: "resolved", characterId: c.mio, matchType: "relationship" });
    expect(report.blocking).toEqual([]);
  });

  it("stops resolving once the relationship is deleted", () => {
    const c = cast();
    const added = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "close_friend" });
    const without = removeRelationship(added.doc, added.relationshipId);

    const report = groundPrompt({ doc: without, prompt: "Yuri hugs her close friend." });
    const friend = report.entities.find((entity) => entity.surface.toLowerCase().includes("close friend"));

    expect(friend?.status).not.toBe("resolved");
    expect(report.blocking.length).toBeGreaterThan(0);
    // And crucially: no new character was invented to satisfy the phrase.
    expect(report.creation.allowed).toBe(false);
  });

  it("refuses to invent a relationship kind that was never recorded", () => {
    const c = cast();
    const { doc } = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "close_friend" });
    // A close friend is not a sister.
    const report = groundPrompt({ doc, prompt: "Yuri hugs her sister." });
    const sister = report.entities.find((entity) => entity.surface.toLowerCase().includes("sister"));
    expect(sister?.status).toBe("not-found");
    expect(report.creation.allowed).toBe(false);
  });

  it("reports AMBIGUOUS when two characters share the relationship", () => {
    const c = cast();
    let doc = addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mio, type: "friend" }).doc;
    doc = addRelationship(doc, { characterAId: c.yuri, characterBId: c.cuteGirl, type: "friend" }).doc;

    const resolution = resolveCharacterReference({
      query: "her friend",
      projectCharacters: Object.values(doc.characters),
      relationships: {
        anchorCharacterId: c.yuri,
        related: relatedCharacters(doc, c.yuri).map((entry) => ({
          characterId: entry.characterId,
          type: entry.relationship.type,
          label: entry.relationship.label,
        })),
      },
    });
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.status === "ambiguous" && resolution.candidates).toHaveLength(2);
  });
});

// ─── Interaction vocabulary and capability ─────────────────────────────────

describe("interaction capability", () => {
  it("maps phrases to interaction types, longest match first", () => {
    expect(interactionTypeFromPhrase("Yuri and Mio hold hands")).toBe("hold_hands");
    expect(interactionTypeFromPhrase("Yuri hugs Mio")).toBe("hug");
    expect(interactionTypeFromPhrase("they high-five")).toBe("high_five");
    expect(interactionTypeFromPhrase("Yuri looks at Mio")).toBe("look_at");
    expect(interactionTypeFromPhrase("Yuri does a backflip")).toBeNull();
  });

  it("beside is pure placement and works without any rig", () => {
    const c = cast(false);
    expect(
      evaluateInteractionCapability({ type: "beside", participantIds: [c.yuri, c.mio], puppets: [undefined, undefined] }),
    ).toMatchObject({ supportedLocally: true, mode: "LOCAL_STAGE" });
  });

  it("hold hands is local when both rigs can reach a shared point", () => {
    const c = cast(true);
    const result = evaluateInteractionCapability({
      type: "hold_hands",
      participantIds: [c.yuri, c.mio],
      puppets: [puppetOf(c.doc, c.yuri), puppetOf(c.doc, c.mio)],
    });
    expect(result).toMatchObject({ supportedLocally: true, mode: "LOCAL_PUPPET" });
  });

  it("one rigged and one flat participant is reported as HYBRID, not forced either way", () => {
    const c = cast(true);
    const result = evaluateInteractionCapability({
      type: "hold_hands",
      participantIds: [c.yuri, c.mio],
      puppets: [puppetOf(c.doc, c.yuri), undefined],
    });
    expect(result.mode).toBe("HYBRID");
    expect(result.blockedBy).toEqual([c.mio]);
  });

  it("hug chooses JOINT_GENERATION even when both are fully rigged", () => {
    const c = cast(true);
    const result = evaluateInteractionCapability({
      type: "hug",
      participantIds: [c.yuri, c.mio],
      puppets: [puppetOf(c.doc, c.yuri), puppetOf(c.doc, c.mio)],
    });
    // Not a rig limitation: no joint rotation creates occlusion the source
    // artwork does not contain.
    expect(result).toMatchObject({ supportedLocally: false, mode: "JOINT_GENERATION" });
    expect(result.reason).toContain("occlude");
  });

  it("look at is local when both have a head joint", () => {
    const c = cast(true);
    expect(
      evaluateInteractionCapability({
        type: "look_at",
        participantIds: [c.yuri, c.mio],
        puppets: [puppetOf(c.doc, c.yuri), puppetOf(c.doc, c.mio)],
      }).mode,
    ).toBe("LOCAL_PUPPET");
  });
});

// ─── §19: hold hands is one shared anchor, not two poses ───────────────────

describe("acceptance A — hold hands", () => {
  it("creates one interaction with a shared anchor both participants aim at", () => {
    const c = cast(true);
    const created = createInteraction(c.doc, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hold_hands",
      renderMode: "synchronized",
    });
    const anchor = midpointAnchor(
      { cx: 200, cy: 300, width: 200, height: 400 },
      { cx: 400, cy: 300, width: 200, height: 400 },
      { [c.yuri]: "rightHand", [c.mio]: "leftHand" },
    );
    const doc = applyDomainCommand(created.doc, {
      type: "set-interaction-anchor",
      interactionId: created.interactionId,
      anchor,
    }).doc;

    const interaction = doc.interactions[created.interactionId];
    expect(interaction.participantIds).toEqual([c.yuri, c.mio]);
    expect(interaction.renderMode).toBe("synchronized");
    // ONE shared point, referenced by both — not two independent hand targets.
    expect(interaction.anchors).toHaveLength(1);
    expect(Object.keys(interaction.anchors![0].contacts).sort()).toEqual([c.yuri, c.mio].sort());
    expect(anchor.at.x).toBe(300);

    // Participants stay independent instances; nothing was generated.
    expect(Object.keys(doc.interactionRenders)).toHaveLength(0);
    expect(Object.keys(doc.assets)).toHaveLength(Object.keys(c.doc.assets).length);
  });

  it("measures contact deviation so validation can check it", () => {
    const c = cast(true);
    const anchor = midpointAnchor(
      { cx: 200, cy: 300, width: 200, height: 400 },
      { cx: 400, cy: 300, width: 200, height: 400 },
      { [c.yuri]: "rightHand", [c.mio]: "leftHand" },
    );
    const deviation = anchorDeviation(anchor, {
      [c.yuri]: { x: anchor.at.x + 3, y: anchor.at.y },
      [c.mio]: { x: anchor.at.x, y: anchor.at.y - 4 },
    });
    expect(deviation.every((entry) => entry.distance <= 5)).toBe(true);

    // A participant with no contact point is infinitely far, never "close enough".
    expect(anchorDeviation(anchor, {})[0].distance).toBe(Infinity);
  });
});

// ─── §20: hug is ONE coordinated request ───────────────────────────────────

describe("acceptance B — hug", () => {
  it("builds a single request carrying BOTH identity references", () => {
    const c = cast();
    const created = createInteraction(c.doc, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hug",
      roles: { subject: c.yuri, target: c.mio },
    });
    const request = buildMultiCharacterRequest(created.doc, created.doc.interactions[created.interactionId], {
      cameraContext: ["medium shot", "eye level"],
    });

    // One request, two participants, two references — never one reference plus
    // a text description of the other.
    expect(request.participantCharacterIds).toEqual([c.yuri, c.mio]);
    expect(request.participantReferenceAssetIds).toHaveLength(2);
    expect(new Set(request.participantReferenceAssetIds).size).toBe(2);
    expect(request.identityConstraints).toHaveLength(2);
    expect(request.identityConstraints[0]).toContain("Do not blend");
    expect(request.interactionConstraints.join(" ")).toContain("occlusion");
    expect(request.cameraContext).toEqual(["medium shot", "eye level"]);
  });

  it("refuses, and names who, when a participant genuinely has no usable reference", () => {
    const c = cast();
    const stripped = structuredClone(c.doc);
    // Nothing left to fall back on: no pointer AND no usable image anywhere.
    delete stripped.characters[c.mio].canonicalReferenceAssetId;
    delete stripped.characters[c.mio].referenceAssetId;
    stripped.characters[c.mio].assetIds = [];
    for (const asset of Object.values(stripped.assets)) {
      if (asset.metadata?.characterId === c.mio) asset.status = "archived";
    }
    const created = createInteraction(stripped, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hug",
    });
    // The message names the character, so the creator knows who to repair.
    expect(() =>
      buildMultiCharacterRequest(created.doc, created.doc.interactions[created.interactionId], {}),
    ).toThrow(new RegExp(stripped.characters[c.mio].name));
  });

  it("recovers a lost pointer from the character's own library instead of failing", () => {
    const c = cast();
    const damaged = structuredClone(c.doc);
    // The exact shape a transparency repair or a replaced original leaves behind.
    delete damaged.characters[c.mio].canonicalReferenceAssetId;
    delete damaged.characters[c.mio].referenceAssetId;
    const created = createInteraction(damaged, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hug",
    });
    const request = buildMultiCharacterRequest(created.doc, created.doc.interactions[created.interactionId], {});
    expect(request.participantReferenceAssetIds).toHaveLength(2);
    // Two different people, two different pictures.
    expect(new Set(request.participantReferenceAssetIds).size).toBe(2);
  });

  it("records provenance so the image is known to contain both characters", () => {
    const c = cast();
    const created = createInteraction(c.doc, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hug",
    });
    const asset = addAsset(created.doc, {
      category: "character",
      name: "Yuri hugging Mio",
      storageUrl: "https://example.com/hug.png",
      processedImageUrl: "https://example.com/hug-cut.png",
      width: 900,
      height: 1200,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
    });
    const key = interactionCacheKey({
      participantCharacterIds: [c.yuri, c.mio],
      type: "hug",
      outfits: ["school uniform", "school uniform"],
      view: "front",
    });
    const recorded = recordInteractionRender(asset.doc, {
      interactionId: created.interactionId,
      participantCharacterIds: [c.yuri, c.mio],
      participantReferenceAssetIds: ["ref-yuri", "ref-mio"],
      generatedAssetId: asset.assetId,
      cacheKey: key,
    });

    // The system knows the image is Yuri AND Mio, not "a Yuri asset".
    expect(charactersInAsset(recorded.doc, asset.assetId).sort()).toEqual([c.yuri, c.mio].sort());
    // And the interaction is honestly marked as a composite, not two puppets.
    const interaction = recorded.doc.interactions[created.interactionId];
    expect(interaction.renderMode).toBe("composite");
    expect(interaction.status).toBe("active");
    expect(interaction.renderId).toBe(recorded.renderId);
  });
});

// ─── §12: reuse before generating again ────────────────────────────────────

describe("interaction cache", () => {
  const base = { type: "hug" as const, outfits: ["uniform", "uniform"], view: "front" };

  it("is order independent for participants but not for roles", () => {
    const a = interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "mio"] });
    const b = interactionCacheKey({ ...base, participantCharacterIds: ["mio", "yuri"] });
    expect(a).toBe(b);

    // "Yuri hugs Mio" and "Mio hugs Yuri" are different pictures.
    const hugger = interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "mio"], roles: { subject: "yuri" } });
    const hugged = interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "mio"], roles: { subject: "mio" } });
    expect(hugger).not.toBe(hugged);
  });

  it("never reuses a Yuri/Mio hug for Yuri/Cute Girl", () => {
    expect(interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "mio"] })).not.toBe(
      interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "cute-girl"] }),
    );
  });

  it("distinguishes outfit, view and style", () => {
    const key = (extra: Partial<Parameters<typeof interactionCacheKey>[0]>) =>
      interactionCacheKey({ ...base, participantCharacterIds: ["yuri", "mio"], ...extra });
    expect(key({})).not.toBe(key({ outfits: ["casual", "uniform"] }));
    expect(key({})).not.toBe(key({ view: "back" }));
    expect(key({})).not.toBe(key({ styleProfileId: "shoujo" }));
  });

  it("finds an existing render and ignores one whose asset was archived", () => {
    const c = cast();
    const created = createInteraction(c.doc, { panelId: c.panelId, participantIds: [c.yuri, c.mio], type: "hug" });
    const asset = addAsset(created.doc, {
      category: "character",
      name: "hug",
      storageUrl: "https://example.com/hug.png",
      processedImageUrl: "https://example.com/hug-cut.png",
      width: 900,
      height: 1200,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
    });
    const key = interactionCacheKey({ ...base, participantCharacterIds: [c.yuri, c.mio] });
    const recorded = recordInteractionRender(asset.doc, {
      interactionId: created.interactionId,
      participantCharacterIds: [c.yuri, c.mio],
      participantReferenceAssetIds: ["a", "b"],
      generatedAssetId: asset.assetId,
      cacheKey: key,
    });

    expect(findInteractionRender(recorded.doc, key)?.generatedAssetId).toBe(asset.assetId);
    expect(findInteractionRender(recorded.doc, "different-key")).toBeNull();

    const archived = applyDomainCommand(recorded.doc, { type: "archive-asset", assetId: asset.assetId }).doc;
    expect(findInteractionRender(archived, key)).toBeNull();
  });
});

// ─── Persistence ───────────────────────────────────────────────────────────

describe("durability", () => {
  it("interactions and renders survive save and reload", () => {
    const c = cast();
    const created = createInteraction(c.doc, {
      panelId: c.panelId,
      participantIds: [c.yuri, c.mio],
      type: "hold_hands",
      renderMode: "synchronized",
    });
    const restored = deserializeProject(serializeProject(created.doc));
    const interaction = restored.interactions[created.interactionId];
    expect(interaction.participantIds).toEqual([c.yuri, c.mio]);
    expect(interaction.type).toBe("hold_hands");
    expect(interaction.renderMode).toBe("synchronized");
  });

  it("a v11 document migrates with empty graphs rather than invented edges", () => {
    const c = cast();
    const legacy = JSON.parse(serializeProject(c.doc)) as Record<string, unknown>;
    legacy.schemaVersion = 11;
    delete legacy.relationships;
    delete legacy.interactions;
    delete legacy.interactionRenders;

    const restored = deserializeProject(JSON.stringify(legacy));
    // Two characters sharing a panel is not evidence they are friends.
    expect(restored.relationships).toEqual({});
    expect(restored.interactions).toEqual({});
    expect(restored.interactionRenders).toEqual({});
  });
});
