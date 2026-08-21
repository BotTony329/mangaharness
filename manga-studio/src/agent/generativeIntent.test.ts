/**
 * Grounding is not a creation gate.
 *
 * "The bad guy Roach Man punching to the camera" used to end at
 *
 *     "…Roach Man does not exist in the project's character inventory, and
 *      creating new characters is forbidden for this run."
 *
 * Kumanga's thesis is that AI makes the assets and the creator composes them,
 * so a missing asset is a REQUIREMENT. What must still block is a reference
 * that POINTS at project data — "her sister" — because answering that with a
 * fabrication puts a character in the creator's manga that they never wrote.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { addRelationship } from "@/domain/relationships";
import type { ID, ProjectDocument } from "@/domain/types";
import { groundPrompt } from "./grounding";
import { resolveSubject } from "./subject";
import { resolveAgentScope, scopeForPanels, scopeForSubject } from "./scope";
import { deriveSceneIntent } from "./sceneIntent";
import { buildSequencePlan } from "./sequencePlan";
import { deriveAssetRequirements } from "./assetRequirements";
import { classifyReference, proposedNameFor } from "./entityResolution";

interface Cast {
  doc: ProjectDocument;
  yuri: ID;
  mori: ID;
  pageId: ID;
}

function cast(): Cast {
  let doc = createProjectDocument("Generative intent");
  const ids: Record<string, ID> = {};
  for (const name of ["Yuri", "Mori"]) {
    const created = addCharacter(doc, name);
    doc = created.doc;
    ids[name] = created.characterId;
    const asset = addAsset(doc, {
      category: "character",
      name: `${name} canonical`,
      storageUrl: `https://example.com/${name}.png`,
      processedImageUrl: `https://example.com/${name}-cut.png`,
      width: 800,
      height: 1400,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: created.characterId, characterAssetRole: "canonical" },
    });
    doc = asset.doc;
    doc = applyDomainCommand(doc, { type: "set-character-reference", characterId: created.characterId, assetId: asset.assetId }).doc;
  }
  const pageId = Object.values(doc.pages)[0].id;
  return { doc, yuri: ids.Yuri, mori: ids.Mori, pageId };
}

/** The real pipeline up to the model call. */
function understand(c: Cast, prompt: string) {
  let scope = resolveAgentScope({ doc: c.doc, currentPageId: c.pageId, selection: {}, prompt });
  const grounding = groundPrompt({ doc: c.doc, prompt });
  const subject = resolveSubject({ doc: c.doc, grounding });
  scope = scopeForSubject(scope, subject, c.doc);
  const intent = deriveSceneIntent({ doc: c.doc, prompt, grounding, subject, scope });
  const plan = buildSequencePlan({
    doc: c.doc,
    intent,
    scope,
    characterIds: subject.characterIds,
  });
  scope = scopeForPanels(scope, plan.allocation.panelNumbers, plan.needsPanelLevel);
  const requirements = deriveAssetRequirements({ doc: c.doc, plan, newCharacters: subject.newCharacters });
  return { grounding, subject, intent, plan, requirements, scope };
}

describe("reference form decides create vs block", () => {
  it("classifies self-identifying references", () => {
    for (const surface of [
      "Roach Man",
      "the bad guy Roach Man",
      "a cockroach superhero",
      "a new villain",
      "a man named Roach Man",
      "a robot",
    ]) {
      expect(classifyReference(surface), surface).toBe("self-identifying");
    }
  });

  it("classifies pointing references", () => {
    for (const surface of [
      "her sister",
      "his teacher",
      "the teacher",
      "that man",
      "the same girl",
      "the character from panel 1",
      "her",
      "Yuri's sister",
    ]) {
      expect(classifyReference(surface), surface).toBe("pointing");
    }
  });

  it("names a new character from the creator's own words", () => {
    expect(proposedNameFor("the bad guy Roach Man")).toBe("Roach Man");
    expect(proposedNameFor("a man named Roach Man")).toBe("Roach Man");
    expect(proposedNameFor("a cockroach superhero")).toBe("Cockroach Superhero");
  });
});

describe("the screenshot case", () => {
  let c: Cast;
  beforeEach(() => {
    c = cast();
  });

  const PROMPT = "The bad guy Roach Man punching to the camera";

  it("has a SUBJECT even though the library has never heard of him", () => {
    const { subject, grounding } = understand(c, PROMPT);

    expect(grounding.blocking).toEqual([]);
    expect(subject.basis).toBe("explicit-name");
    expect(subject.newCharacters.map((n) => n.proposedName)).toContain("Roach Man");
    // The old failure: "No character subject".
    expect(subject.explanation).toMatch(/Roach Man/);
  });

  it("turns him into asset requirements rather than a refusal", () => {
    const { requirements } = understand(c, PROMPT);
    const identity = requirements.requirements.find((r) => r.kind === "character-identity");

    expect(identity).toMatchObject({
      label: "Roach Man",
      needsGeneration: true,
      fulfilment: { how: "create-entity", proposedName: "Roach Man" },
    });
    expect(requirements.lines.join("\n")).toMatch(/Roach Man — not in the library, create the character/);
    expect(requirements.generationCount).toBeGreaterThan(0);
  });

  it("keeps the punch as a state requirement on the new character", () => {
    const { requirements } = understand(c, PROMPT);
    const state = requirements.requirements.find((r) => r.kind === "character-state");
    expect(state?.label).toMatch(/Roach Man/);
    expect(state?.needsGeneration).toBe(true);
  });
});

describe("safety is preserved", () => {
  let c: Cast;
  beforeEach(() => {
    c = cast();
  });

  it("BLOCKS 'Yuri hugs her sister' — no sister is invented", () => {
    const { grounding, subject } = understand(c, "Yuri hugs her sister.");
    const sister = grounding.entities.find((e) => /sister/.test(e.surface));

    expect(sister?.resolution?.status).toBe("unresolved");
    expect(grounding.blocking.length).toBeGreaterThan(0);
    expect(subject.newCharacters.map((n) => n.proposedName)).not.toContain("Sister");
  });

  it("resolves 'her close friend' when the relationship exists", () => {
    const withEdge = { ...c, doc: addRelationship(c.doc, { characterAId: c.yuri, characterBId: c.mori, type: "close_friend" }).doc };
    const { grounding } = understand(withEdge, "Yuri hugs her close friend.");
    const friend = grounding.entities.find((e) => /close friend/.test(e.surface));
    expect(friend?.resolution).toMatchObject({ status: "existing", entityId: c.mori });
    expect(grounding.blocking).toEqual([]);
  });

  it("blocks an AMBIGUOUS reference rather than creating a second one", () => {
    let doc = c.doc;
    doc = addRelationship(doc, { characterAId: c.yuri, characterBId: c.mori, type: "friend" }).doc;
    const third = addCharacter(doc, "Aya");
    doc = third.doc;
    doc = addRelationship(doc, { characterAId: c.yuri, characterBId: third.characterId, type: "friend" }).doc;

    const grounding = groundPrompt({ doc, prompt: "Yuri hugs her friend." });
    const friend = grounding.entities.find((e) => /her friend/.test(e.surface));
    expect(friend?.resolution?.status).toBe("unresolved");
  });
});

describe("existing characters are reused, never re-created", () => {
  let c: Cast;
  beforeEach(() => {
    c = cast();
  });

  it("an existing character needing a new pose generates only the STATE", () => {
    const { requirements, subject } = understand(c, "Yuri punching to the camera");

    expect(subject.newCharacters).toEqual([]);
    const identity = requirements.requirements.find((r) => r.kind === "character-identity");
    expect(identity).toBeUndefined();

    const state = requirements.requirements.find((r) => r.kind === "character-state");
    expect(state?.fulfilment).toMatchObject({ how: "generate-state", characterId: c.yuri });
  });

  it("an existing state costs nothing", () => {
    let doc = c.doc;
    const punch = addAsset(doc, {
      category: "character",
      name: "Yuri punching",
      storageUrl: "https://example.com/punch.png",
      processedImageUrl: "https://example.com/punch-cut.png",
      width: 800,
      height: 1400,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: {
        characterId: c.yuri,
        characterAssetRole: "state",
        pose: "punching",
        expression: "neutral",
        outfit: "default outfit",
        view: "front",
      },
    });
    doc = punch.doc;

    const { requirements } = understand({ ...c, doc }, "Yuri punching to the camera");
    const state = requirements.requirements.find((r) => r.kind === "character-state");
    expect(state?.fulfilment).toMatchObject({ how: "exact-asset", assetId: punch.assetId });
    expect(state?.needsGeneration).toBe(false);
    expect(requirements.generationCount).toBe(0);
  });
});

describe("a new participant in an interaction", () => {
  it("Yuri hugs a new robot named Kumo — Yuri existing, Kumo created", () => {
    const c = cast();
    const { grounding, subject, requirements } = understand(c, "Yuri hugs a new robot named Kumo.");

    expect(grounding.blocking).toEqual([]);
    expect(subject.characterIds).toContain(c.yuri);
    expect(subject.newCharacters.map((n) => n.proposedName)).toContain("Kumo");
    expect(requirements.requirements.some((r) => r.kind === "character-identity" && r.label === "Kumo")).toBe(true);
    // Yuri is reused: no identity requirement for her.
    expect(requirements.requirements.some((r) => r.kind === "character-identity" && r.label === "Yuri")).toBe(false);
  });
});
