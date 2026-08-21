/**
 * Golden cases for scene-local apposition co-resolution.
 *
 * The production failure these pin: "his rival, the bad character Roachman"
 * grounded as TWO participants — one unresolved rival that blocked the run,
 * one new Roachman — when the sentence introduces ONE person twice. The merge
 * is structural (a pointing phrase bound to a name-carrying phrase across a
 * comma or dash), not a list of relationship words.
 *
 * Equally pinned: the merge must NEVER weaken the pointing rule. "Yuri hugs
 * her sister" with no sister on record still blocks, because nothing in that
 * sentence names her.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { addRelationship } from "@/domain/relationships";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfAsset } from "@/characters/identity";
import { deriveAssetRequirements } from "./assetRequirements";
import { findAppositions } from "./coreference";
import { fulfilRequirements } from "./fulfilRequirements";
import { executePlan } from "./executor";
import { groundPrompt, groundingContext } from "./grounding";
import { resolveSubject } from "./subject";
import { deriveSceneIntent } from "./sceneIntent";
import { buildSequencePlan } from "./sequencePlan";
import { resolveAgentScope, scopeForPanels, scopeForSubject } from "./scope";
import { validateGroundedPlan } from "./planValidation";
import { validatePlan } from "./tools/schemas";

const CASE_A = "The supermate is fighting with his rival, the bad character Roachman, in Melbourne";

class MockImage {
  naturalWidth = 900;
  naturalHeight = 1400;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    this.onload?.();
  }
}

function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/provider/status")) {
      return new Response(JSON.stringify({ capabilities: { referenceImage: true, supportsTransparentBackground: true } }), { status: 200 });
    }
    if (url.includes("/api/generate")) {
      return new Response(
        JSON.stringify({
          url: "https://example.com/generated.png",
          sourceUrl: "https://example.com/generated.png",
          processedImageUrl: "https://example.com/generated-alpha.png",
          mimeType: "image/png",
          hasAlpha: true,
          backgroundRemoved: true,
          processingStatus: "ready",
          provider: "test-provider",
          model: "test-model",
          referenceUsed: true,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
}

function openProject(): { pageId: ID; panelIds: ID[] } {
  const doc = createProjectDocument("Co-reference golden");
  useEditorStore.getState().loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "two-vertical" });
  return { pageId, panelIds: useEditorStore.getState().doc!.pages[pageId].panelIds };
}

function withCharacter(name: string, description: string): { doc: ProjectDocument; characterId: ID } {
  const doc = useEditorStore.getState().doc!;
  const added = addCharacter(doc, name, description);
  const canonical = addAsset(added.doc, {
    category: "character",
    name: `${name} canonical reference`,
    storageUrl: `https://example.com/${name}.png`,
    processedImageUrl: `https://example.com/${name}-alpha.png`,
    width: 900,
    height: 1400,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: added.characterId, characterAssetRole: "canonical", pose: "standing", expression: "neutral", outfit: "default outfit", view: "front" },
  });
  const next = {
    ...canonical.doc,
    characters: {
      ...canonical.doc.characters,
      [added.characterId]: { ...canonical.doc.characters[added.characterId], referenceAssetId: canonical.assetId },
    },
  };
  useEditorStore.getState().loadDocument(next);
  return { doc: next, characterId: added.characterId };
}

/** Everything the panel does between "Run" and the first mutation. */
function understand(prompt: string) {
  const doc = useEditorStore.getState().doc!;
  const pageId = Object.values(doc.pages)[0].id;
  let scope = resolveAgentScope({ doc, currentPageId: pageId, selection: {}, prompt });
  const grounding = groundPrompt({ doc, prompt });
  const subject = resolveSubject({ doc, grounding });
  scope = scopeForSubject(scope, subject, doc);
  const intent = deriveSceneIntent({ doc, prompt, grounding, subject, scope });
  const plan = buildSequencePlan({ doc, intent, scope, characterIds: subject.characterIds });
  scope = scopeForPanels(scope, plan.allocation.panelNumbers, plan.needsPanelLevel);
  const requirements = deriveAssetRequirements({ doc, plan, newCharacters: subject.newCharacters });
  return { doc, grounding, subject, scope, plan, requirements };
}

beforeEach(() => {
  vi.stubGlobal("Image", MockImage as unknown as typeof Image);
  stubNetwork();
  useEditorStore.setState({ doc: null, undoStack: [], redoStack: [] } as never);
});

describe("apposition detection is structural, not vocabulary", () => {
  it("binds every form in the brief", () => {
    const forms = [
      "his rival, the bad character Roachman",
      "her sister, Mori",
      "her friend, Yuri",
      "the teacher, Mr Chen",
      "his enemy — Roachman",
    ];
    for (const form of forms) {
      const bindings = findAppositions(`x ${form}`);
      expect(bindings, form).toHaveLength(1);
      expect(bindings[0].aliasSurface.length).toBeGreaterThan(0);
      expect(bindings[0].canonicalSurface.length).toBeGreaterThan(0);
    }
  });

  it("does not bind a list of names, a location, or a bare pointing phrase", () => {
    expect(findAppositions("Yuri, Mori, and Hana run")).toHaveLength(0);
    expect(findAppositions("Yuri hugs her sister")).toHaveLength(0);
    const bindings = findAppositions(CASE_A);
    // "the bad character Roachman, in Melbourne": the place is not a participant.
    expect(bindings).toHaveLength(1);
    expect(bindings[0].aliasSurface).toBe("his rival");
    expect(bindings[0].canonicalSurface).toBe("the bad character Roachman");
  });
});

describe("CASE A — the brief's production failure", () => {
  it("grounds as exactly TWO participants: Supermate EXISTING, Roachman CREATE", () => {
    openProject();
    withCharacter("Supermate", "earnest hero");
    const { grounding, subject } = understand(CASE_A);

    expect(grounding.blocking).toHaveLength(0);
    // No separate "his rival" participant survives the merge.
    expect(grounding.entities.some((e) => /his rival/i.test(e.surface))).toBe(false);
    expect(grounding.entities).toHaveLength(2);

    const supermate = grounding.entities.find((e) => e.resolution?.status === "existing");
    expect(supermate?.name).toBe("Supermate");

    const roachman = grounding.entities.find((e) => e.resolution?.status === "create");
    expect(roachman?.resolution).toMatchObject({ status: "create", proposedName: "Roachman" });
    expect(roachman?.sceneLocalAliases).toContain("his rival");
    expect(roachman?.sceneRelation).toMatchObject({ type: "rival" });

    expect(subject.newCharacters.map((c) => c.proposedName)).toEqual(["Roachman"]);
    expect(subject.newCharacters).toHaveLength(1);
  });

  it("the full arrow lands: created, drawable, and placeable in one run", async () => {
    const { panelIds } = openProject();
    withCharacter("Supermate", "earnest hero");
    const { requirements, grounding, scope } = understand(CASE_A);

    const result = await fulfilRequirements(requirements.requirements);
    expect(result.created.map((c) => c.name)).toContain("Roachman");
    expect(result.created.map((c) => c.name)).not.toContain("His Rival");

    const doc = useEditorStore.getState().doc!;
    const roachman = Object.values(doc.characters).find((c) => c.name === "Roachman")!;
    const owned = Object.values(doc.assets).filter((asset) => characterIdOfAsset(doc, asset.id) === roachman.id);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((asset) => asset.processingStatus === "ready")).toBe(true);

    const { plan: agentPlan } = validatePlan({
      summary: "Supermate fights Roachman in Melbourne",
      steps: [
        { tool: "generate_background", args: { description: "Melbourne street", name: "Melbourne" } },
        { tool: "create_interaction", args: { panel: 1, interaction: "fight", subjectCharacterName: "Supermate", targetCharacterName: "Roachman" } },
      ],
    });
    const validated = validateGroundedPlan({ plan: agentPlan!, doc, grounding, scope, panelCount: panelIds.length });
    expect(validated.blocked).toBe(false);
    expect(validated.rejected).toHaveLength(0);

    const summary = await executePlan(
      validated.plan,
      () => {},
      { creationAuthorized: validated.creationAuthorized, authorizedCreationNames: validated.authorizedCreationNames },
    );
    expect(summary.rolledBack).toBe(false);

    const after = useEditorStore.getState().doc!;
    expect(Object.keys(after.relationships)).toHaveLength(0); // scene-local rival is never persisted
  });

  it("tells the planner the two surfaces are one participant", () => {
    openProject();
    withCharacter("Supermate", "earnest hero");
    const { grounding } = understand(CASE_A);
    const context = groundingContext(grounding).join("\n");
    expect(context).toContain("his rival");
    expect(context).not.toContain("UNRESOLVED");
  });
});

describe("CASE B — a bare pointing reference still blocks", () => {
  it('"Yuri hugs her sister" with no sister on record is UNRESOLVED and creates nothing', () => {
    openProject();
    withCharacter("Yuri", "quiet second-year");
    const { grounding, subject } = understand("Yuri hugs her sister");

    expect(grounding.blocking.length).toBeGreaterThan(0);
    expect(grounding.entities.some((e) => e.resolution?.status === "unresolved")).toBe(true);
    expect(subject.newCharacters).toHaveLength(0);
  });
});

describe("CASE C — apposition onto an EXISTING character", () => {
  it('"Yuri hugs her sister, Mori" grounds as exactly two existing participants', () => {
    openProject();
    withCharacter("Yuri", "quiet second-year");
    withCharacter("Mori", "cheerful classmate");
    const { grounding, subject } = understand("Yuri hugs her sister, Mori");

    expect(grounding.blocking).toHaveLength(0);
    expect(grounding.entities).toHaveLength(2);
    const mori = grounding.entities.find((e) => e.name === "Mori");
    expect(mori?.resolution?.status).toBe("existing");
    expect(mori?.sceneLocalAliases).toContain("her sister");
    expect(subject.newCharacters).toHaveLength(0);
  });
});

describe("CASE D — apposition that introduces someone new", () => {
  it('"Yuri hugs her sister, Mori" with no Mori creates exactly one character', () => {
    openProject();
    withCharacter("Yuri", "quiet second-year");
    const { grounding, subject } = understand("Yuri hugs her sister, Mori");

    expect(grounding.blocking).toHaveLength(0);
    expect(grounding.entities).toHaveLength(2);
    const mori = grounding.entities.find((e) => e.resolution?.status === "create");
    expect(mori?.resolution).toMatchObject({ status: "create", proposedName: "Mori" });
    expect(mori?.sceneLocalAliases).toContain("her sister");
    expect(mori?.sceneRelation?.type).toBe("sibling");
    expect(subject.newCharacters.map((c) => c.proposedName)).toEqual(["Mori"]);
  });
});

describe("CASE E — named introduction without a comma", () => {
  it('"The villain named Kumo attacks Yuri" creates Kumo and no one else', () => {
    openProject();
    withCharacter("Yuri", "quiet second-year");
    const { grounding, subject } = understand("The villain named Kumo attacks Yuri");

    expect(grounding.blocking).toHaveLength(0);
    expect(subject.newCharacters.map((c) => c.proposedName)).toEqual(["Kumo"]);
    expect(grounding.entities.filter((e) => e.resolution?.status === "create")).toHaveLength(1);
  });
});

describe("CASE F — dash apposition", () => {
  it('"Supermate fights his enemy — Roachman" is two participants, not three', () => {
    openProject();
    withCharacter("Supermate", "earnest hero");
    const { grounding, subject } = understand("Supermate fights his enemy — Roachman");

    expect(grounding.blocking).toHaveLength(0);
    expect(grounding.entities).toHaveLength(2);
    expect(grounding.entities.some((e) => /his enemy/i.test(e.surface))).toBe(false);
    const roachman = grounding.entities.find((e) => e.resolution?.status === "create");
    expect(roachman?.resolution).toMatchObject({ status: "create", proposedName: "Roachman" });
    expect(roachman?.sceneLocalAliases).toContain("his enemy");
    expect(subject.newCharacters).toHaveLength(1);
  });
});

describe("the merge never overrides recorded project data", () => {
  it("does not rebind a phrase the relationship graph already answers differently", () => {
    openProject();
    const { characterId: yuriId } = withCharacter("Yuri", "quiet second-year");
    const { characterId: hanaId } = withCharacter("Hana", "older sister");
    withCharacter("Mori", "cheerful classmate");
    const doc = useEditorStore.getState().doc!;
    const linked = addRelationship(doc, { characterAId: yuriId, characterBId: hanaId, type: "sibling" });
    useEditorStore.getState().loadDocument(linked.doc);

    // "her sister" IS Hana by project data; the apposition claims Mori. The
    // graph wins — no silent merge.
    const { grounding } = understand("Yuri hugs her sister, Mori");
    const sister = grounding.entities.find((e) => /her sister/i.test(e.surface));
    const mori = grounding.entities.find((e) => e.name === "Mori");
    expect(sister?.characterId).toBe(hanaId);
    expect(mori?.sceneLocalAliases ?? []).not.toContain("her sister");
  });
});
