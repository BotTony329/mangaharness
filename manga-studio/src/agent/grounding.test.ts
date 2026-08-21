/**
 * Entity grounding: the P0 reliability suite.
 *
 * The production failure being locked out: the agent resolved characters by
 * bidirectional substring match at execution time, returned the first
 * arbitrary hit with no ambiguity detection, and — when it found nothing — was
 * free to invent a persistent Character. These tests assert the three
 * invariants that replaced that behaviour:
 *
 *   1. An explicitly named existing character is NEVER substituted.
 *   2. NOT_FOUND never means create.
 *   3. Nothing mutates and nothing generates until identity is resolved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan, type RunGuards } from "./executor";
import { detectCreationIntent, groundPrompt, resolveCharacterReference } from "./grounding";
import { validateGroundedPlan } from "./planValidation";
import { resolveAgentScope } from "./scope";
import { validatePlan } from "./tools/schemas";

// ─── Fixture: the exact project from the bug report ─────────────────────────

interface Fixture {
  doc: ProjectDocument;
  yuri: ID;
  cuteGirl: ID;
  mio: ID;
}

function characterState(
  doc: ProjectDocument,
  characterId: ID,
  name: string,
  pose: string,
  expression: string,
): { doc: ProjectDocument; assetId: ID } {
  return addAsset(doc, {
    category: "character",
    name,
    storageUrl: `https://example.com/${name.replace(/\s+/g, "-")}.png`,
    width: 800,
    height: 1600,
    metadata: {
      characterId,
      pose,
      expression,
      outfit: "default outfit",
      view: "front",
      characterAssetRole: "state",
    },
  });
}

function fixture(): Fixture {
  let doc = createProjectDocument("Grounding");
  const yuri = addCharacter(doc, "Yuri", "black-haired high school girl");
  doc = yuri.doc;
  const cuteGirl = addCharacter(doc, "Cute Girl", "black-haired girl with twin tails");
  doc = cuteGirl.doc;
  const mio = addCharacter(doc, "Mio", "black-haired quiet girl");
  doc = mio.doc;

  doc = characterState(doc, yuri.characterId, "Yuri walking", "walking", "neutral").doc;
  doc = characterState(doc, yuri.characterId, "Yuri shocked", "walking", "shocked").doc;
  doc = characterState(doc, cuteGirl.characterId, "Cute Girl walking", "walking", "neutral").doc;
  doc = characterState(doc, mio.characterId, "Mio standing", "standing", "neutral").doc;

  return { doc, yuri: yuri.characterId, cuteGirl: cuteGirl.characterId, mio: mio.characterId };
}

function withoutYuri(base: Fixture): ProjectDocument {
  const doc = structuredClone(base.doc);
  delete doc.characters[base.yuri];
  for (const [id, asset] of Object.entries(doc.assets)) {
    if (asset.metadata?.characterId === base.yuri) delete doc.assets[id];
  }
  return doc;
}

function characters(doc: ProjectDocument) {
  return Object.values(doc.characters);
}

// ─── §3 / §17: the canonical resolver ──────────────────────────────────────

describe("resolveCharacterReference", () => {
  it("resolves an exact name to that character and nothing else", () => {
    const { doc, yuri } = fixture();
    const result = resolveCharacterReference({ query: "Yuri", projectCharacters: characters(doc) });
    expect(result).toMatchObject({ status: "resolved", characterId: yuri, matchType: "exact-name" });
  });

  it("normalizes case and surrounding space", () => {
    const { doc, yuri } = fixture();
    for (const query of ["yuri", "YURI", " Yuri ", "  yUrI  "]) {
      const result = resolveCharacterReference({ query, projectCharacters: characters(doc) });
      expect(result.status, query).toBe("resolved");
      expect(result.status === "resolved" && result.characterId, query).toBe(yuri);
    }
  });

  it("resolves an ID directly", () => {
    const { doc, cuteGirl } = fixture();
    expect(resolveCharacterReference({ query: cuteGirl, projectCharacters: characters(doc) })).toMatchObject({
      status: "resolved",
      characterId: cuteGirl,
      matchType: "id",
    });
  });

  it("resolves an explicitly stored alias, and only an explicitly stored one", () => {
    const { doc, yuri } = fixture();
    const aliased = characters(doc).map((character) =>
      character.id === yuri ? { ...character, aliases: ["Yu-chan"] } : character,
    );
    expect(resolveCharacterReference({ query: "Yu-chan", projectCharacters: aliased })).toMatchObject({
      status: "resolved",
      characterId: yuri,
      matchType: "alias",
    });
    // The same nickname is NOT inferable without the stored alias.
    expect(resolveCharacterReference({ query: "Yu-chan", projectCharacters: characters(doc) }).status).toBe(
      "not-found",
    );
  });

  it("does NOT substitute a different character for an unknown name", () => {
    const base = fixture();
    const doc = withoutYuri(base);
    const result = resolveCharacterReference({ query: "Yuri", projectCharacters: characters(doc) });
    expect(result.status).toBe("not-found");
  });

  it("never matches on a bare substring — the original defect", () => {
    const { doc } = fixture();
    // "Yu" is a substring of "Yuri"; the old resolver returned Yuri here.
    expect(resolveCharacterReference({ query: "Yu", projectCharacters: characters(doc) }).status).toBe("not-found");
    // "Girl" is a substring of "Cute Girl"; matching it would be a guess.
    expect(resolveCharacterReference({ query: "Girl", projectCharacters: characters(doc) }).status).toBe("not-found");
  });

  it("accepts a safe unique token match", () => {
    const { doc, yuri } = fixture();
    expect(resolveCharacterReference({ query: "Yuri-chan", projectCharacters: characters(doc) })).toMatchObject({
      status: "resolved",
      characterId: yuri,
      matchType: "unique-token",
    });
  });

  it("reports AMBIGUOUS rather than picking one when a token matches several", () => {
    let doc = createProjectDocument("Ambiguity");
    doc = addCharacter(doc, "Yuri Tanaka").doc;
    doc = addCharacter(doc, "Yuri Sato").doc;
    const result = resolveCharacterReference({ query: "Yuri", projectCharacters: characters(doc) });
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates).toHaveLength(2);
  });

  it("reports AMBIGUOUS on a duplicate name collision instead of first-wins", () => {
    let doc = createProjectDocument("Collision");
    doc = addCharacter(doc, "Yuri").doc;
    doc = addCharacter(doc, "Yuri").doc;
    const result = resolveCharacterReference({ query: "Yuri", projectCharacters: characters(doc) });
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates).toHaveLength(2);
  });

  it('does not auto-resolve a split spelling like "Yu ri"', () => {
    const { doc } = fixture();
    const result = resolveCharacterReference({ query: "Yu ri", projectCharacters: characters(doc) });
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.reason).toContain("Did you mean");
  });

  it('reports AMBIGUOUS for a description like "the black-haired girl"', () => {
    const { doc } = fixture();
    const result = resolveCharacterReference({ query: "the black-haired girl", projectCharacters: characters(doc) });
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates.length).toBeGreaterThan(1);
  });

  it("refuses relationship guessing that is not structured project data", () => {
    const { doc } = fixture();
    for (const query of ["her best friend", "the best friend", "Yuri's friend", "Mio's rival"]) {
      expect(resolveCharacterReference({ query, projectCharacters: characters(doc) }).status, query).not.toBe(
        "resolved",
      );
    }
  });

  // ── §13: pronoun priority ──
  it("resolves a pronoun to the selected instance first", () => {
    const { doc, yuri, mio } = fixture();
    expect(
      resolveCharacterReference({
        query: "her",
        projectCharacters: characters(doc),
        selectedCharacterId: yuri,
        sceneCharacterIds: [mio],
      }),
    ).toMatchObject({ status: "resolved", characterId: yuri, matchType: "selected-instance" });
  });

  it("falls back to the recent operation, then to a sole scene character", () => {
    const { doc, yuri, mio } = fixture();
    expect(
      resolveCharacterReference({ query: "her", projectCharacters: characters(doc), recentCharacterId: yuri }),
    ).toMatchObject({ status: "resolved", characterId: yuri, matchType: "recent-operation" });
    expect(
      resolveCharacterReference({ query: "her", projectCharacters: characters(doc), sceneCharacterIds: [mio] }),
    ).toMatchObject({ status: "resolved", characterId: mio, matchType: "sole-scene-character" });
  });

  it("reports AMBIGUOUS for a pronoun with two characters in scene and no selection", () => {
    const { doc, yuri, cuteGirl } = fixture();
    const result = resolveCharacterReference({
      query: "her",
      projectCharacters: characters(doc),
      sceneCharacterIds: [yuri, cuteGirl],
    });
    expect(result.status).toBe("ambiguous");
  });
});

// ─── §6 / §18: creation requires explicit intent ───────────────────────────

describe("detectCreationIntent", () => {
  const allowed = [
    "Create a new character named Hana.",
    "Add a new teacher character.",
    "Design a new villain.",
    "Create a character called Hana",
    "Introduce a new rival for Yuri.",
  ];
  const forbidden = [
    "Yuri walks into the room.",
    "Her friend appears.",
    "Put the girl beside Yuri.",
    "Hana enters the room.",
    "Make her shocked.",
    "Add a shocked manga effect around Yuri.",
    "Add speed lines to panel 2.",
    "Yuri is walking past Cute Girl.",
  ];

  it.each(allowed)("authorizes creation for %s", (prompt) => {
    expect(detectCreationIntent(prompt).allowed).toBe(true);
  });

  it.each(forbidden)("refuses creation for %s", (prompt) => {
    expect(detectCreationIntent(prompt).allowed).toBe(false);
  });

  it("captures the requested name so creation cannot drift to another one", () => {
    expect(detectCreationIntent("Create a new character named Hana.").requestedNames).toEqual(["Hana"]);
  });
});

// ─── §2 / §16: grounding a whole prompt ────────────────────────────────────

describe("groundPrompt", () => {
  it("resolves every named character to a stable ID before planning", () => {
    const { doc, yuri, cuteGirl } = fixture();
    const report = groundPrompt({ doc, prompt: "Yuri looks shocked when Cute Girl walks past." });
    const byName = Object.fromEntries(report.entities.map((entity) => [entity.surface, entity]));
    expect(byName.Yuri).toMatchObject({ status: "resolved", characterId: yuri });
    expect(byName["Cute Girl"]).toMatchObject({ status: "resolved", characterId: cuteGirl });
    expect(report.blocking).toEqual([]);
    expect(report.creation.allowed).toBe(false);
  });

  it("treats an unknown NAME as a character to create, never as a substitution", () => {
    const base = fixture();
    const report = groundPrompt({ doc: withoutYuri(base), prompt: "Yuri walks in." });
    const yuri = report.entities.find((entity) => entity.surface === "Yuri");

    // The library does not recognise her — but a name is self-identifying, so
    // the answer is "create Yuri", not "the request cannot be fulfilled".
    expect(yuri?.status).toBe("not-found");
    expect(yuri?.resolution).toMatchObject({ status: "create", kind: "character", proposedName: "Yuri" });
    expect(report.blocking).toEqual([]);

    // The safety property that actually mattered: she is never silently
    // resolved to somebody else who does exist.
    expect(yuri?.characterId).toBeUndefined();
  });

  it("does not block a name the user explicitly asked to create", () => {
    const { doc } = fixture();
    const report = groundPrompt({ doc, prompt: "Create a new character named Hana." });
    expect(report.blocking).toEqual([]);
    expect(report.creation).toMatchObject({ allowed: true, requestedNames: ["Hana"] });
  });

  it("still blocks a reference that POINTS at project data it cannot answer", () => {
    const { doc } = fixture();
    // "her sister" means nothing without a relationship; inventing one would put
    // a character in the creator's manga that they never wrote.
    const report = groundPrompt({ doc, prompt: "Yuri hugs her sister." });
    const sister = report.entities.find((entity) => entity.surface.includes("sister"));
    expect(sister?.resolution?.status).toBe("unresolved");
    expect(report.blocking.length).toBeGreaterThan(0);
  });

  it("names a new character from the words the creator actually used", () => {
    const { doc } = fixture();
    const report = groundPrompt({ doc, prompt: "The bad guy Roach Man punching to the camera" });
    const roach = report.entities.find((entity) => /roach/i.test(entity.surface));
    expect(roach?.resolution).toMatchObject({ status: "create", proposedName: "Roach Man" });
    expect(report.blocking).toEqual([]);
  });

  it("does not mistake manga vocabulary for character names", () => {
    const { doc } = fixture();
    const report = groundPrompt({ doc, prompt: "Add speed lines to Panel 2 and make it a Close-up." });
    expect(report.blocking).toEqual([]);
  });
});

// ─── §10 / §11: grounded plan validation ───────────────────────────────────

function planFor(steps: { tool: string; args: Record<string, unknown> }[]) {
  return validatePlan({ summary: "test", steps }).plan;
}

describe("validateGroundedPlan", () => {
  it("rewrites names into stable IDs (§11)", () => {
    const { doc, yuri } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Place Yuri in panel 2." });
    const result = validateGroundedPlan({
      plan: planFor([{ tool: "place_character", args: { panel: 2, characterName: "Yuri" } }]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.blocked).toBe(false);
    expect(result.plan.steps[0].args.characterId).toBe(yuri);
  });

  it("rejects create_character for a name the creator never typed (§5/§6)", () => {
    const base = fixture();
    const doc = withoutYuri(base);
    const grounding = groundPrompt({ doc, prompt: "Yuri walks in." });
    const result = validateGroundedPlan({
      plan: planFor([
        // The prompt introduced Yuri. It said nothing whatsoever about Kenji —
        // a planner inventing a supporting cast is still refused.
        { tool: "create_character", args: { name: "Kenji", appearance: "a boy" } },
        { tool: "generate_character_asset", args: { characterName: "Kenji", kind: "reference" } },
        { tool: "place_character", args: { panel: 1, characterName: "Kenji" } },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps).toHaveLength(0);
    expect(result.blocked).toBe(true);
    expect(result.rejected[0].error).toContain("authorized for");
  });

  it("allows create_character only for the name the user asked for", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Create a new character named Hana." });
    const result = validateGroundedPlan({
      plan: planFor([
        { tool: "create_character", args: { name: "Hana" } },
        { tool: "create_character", args: { name: "Rei" } },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps.map((step) => step.args.name)).toEqual(["Hana"]);
    expect(result.rejected[0].error).toContain("authorized for hana");
  });

  it("lets a later step reference a character the plan creates earlier", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Create a new character named Hana and put her in panel 1." });
    const result = validateGroundedPlan({
      plan: planFor([
        { tool: "create_character", args: { name: "Hana" } },
        { tool: "generate_character_asset", args: { characterName: "Hana", kind: "reference" } },
        { tool: "place_character", args: { panel: 1, characterName: "Hana" } },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps).toHaveLength(3);
    expect(result.blocked).toBe(false);
  });

  it("refuses to duplicate a state that already exists (§9)", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Make Yuri shocked." });
    const result = validateGroundedPlan({
      plan: planFor([
        {
          tool: "generate_character_asset",
          args: { characterName: "Yuri", kind: "expression", pose: "walking", expression: "shocked" },
        },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps).toHaveLength(0);
    expect(result.rejected[0].error).toContain("already has a cached");
  });

  it("refuses a second canonical reference", () => {
    const { doc, yuri } = fixture();
    const withReference = structuredClone(doc);
    withReference.characters[yuri].canonicalReferenceAssetId = "asset-ref";
    const grounding = groundPrompt({ doc: withReference, prompt: "Redraw Yuri." });
    const result = validateGroundedPlan({
      plan: planFor([{ tool: "generate_character_asset", args: { characterName: "Yuri", kind: "reference" } }]),
      doc: withReference,
      grounding,
      panelCount: 4,
    });
    expect(result.rejected[0].error).toContain("already has a canonical reference");
  });

  it("rejects a panel that does not exist", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Place Yuri in panel 9." });
    const result = validateGroundedPlan({
      plan: planFor([{ tool: "place_character", args: { panel: 9, characterName: "Yuri" } }]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.rejected[0].error).toContain("does not exist");
  });

  /**
   * The reported production bug: "Yuri walks past Cute Girl" composed a panel
   * containing ONLY Cute Girl, because the step naming Yuri failed on its own
   * while the rest of the run carried on.
   *
   * The run used to be blocked outright. It no longer is — a proper name the
   * library has never heard of is a character the creator is introducing, so
   * Yuri is created rather than refused. What must NEVER happen either way is
   * the original bug: a panel that silently contains one of the two people the
   * sentence named. So the assertion is about the participants, not the verdict.
   */
  it("never composes a panel missing one of the characters the sentence named", () => {
    const base = fixture();
    const doc = withoutYuri(base);
    const grounding = groundPrompt({ doc, prompt: "Yuri walks past Cute Girl." });
    const result = validateGroundedPlan({
      plan: planFor([
        { tool: "place_character", args: { panel: 1, characterName: "Yuri" } },
        { tool: "place_character", args: { panel: 1, characterName: "Cute Girl" } },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });

    // Neither participant is dropped: either both survive, or nothing runs.
    const placed = result.plan.steps
      .filter((step) => step.tool === "place_character")
      .map((step) => String(step.args.characterName).toLowerCase());
    if (!result.blocked) {
      expect(placed).toContain("yuri");
      expect(placed).toContain("cute girl");
      // And Yuri is going to exist by the time that step runs.
      expect(result.authorizedCreationNames).toContain("yuri");
    }
    expect(result.rejected.map((entry) => entry.error).join(" ")).not.toContain("Cute Girl");
  });
});

// ─── §16 / §15 / §19: end-to-end through the real executor ─────────────────

let generationCalls: string[] = [];

function seedStore(doc: ProjectDocument) {
  useEditorStore.getState().loadDocument(doc);
}

function panelItems(panelIndex: number): AssetInstance[] {
  const state = useEditorStore.getState();
  const doc = state.doc!;
  const page = doc.pages[state.currentPageId!];
  const panel = doc.panels[page.panelIds[panelIndex - 1]];
  return panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset");
}

function characterIdsIn(panelIndex: number): (ID | undefined)[] {
  const doc = useEditorStore.getState().doc!;
  return panelItems(panelIndex).map(
    (item) => item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId,
  );
}

const DENY: RunGuards = { creationAuthorized: false, authorizedCreationNames: [] };

describe("agent run: existing character references are sacred", () => {
  beforeEach(() => {
    generationCalls = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        generationCalls.push(url);
        throw new Error(`Unexpected image generation during this run: ${url}`);
      }
      return new Response(JSON.stringify({ capabilities: { referenceImage: false } }));
    });
  });

  it('"Yuri is walking past Cute Girl" reuses both existing characters and creates nothing', async () => {
    const base = fixture();
    seedStore(base.doc);
    const state = useEditorStore.getState();
    const prompt = "Yuri is walking past Cute Girl.";
    const scope = resolveAgentScope({
      doc: state.doc!,
      currentPageId: state.currentPageId,
      selection: {},
      prompt,
    });
    const grounding = groundPrompt({ doc: state.doc!, prompt });
    const validated = validateGroundedPlan({
      plan: planFor([
        { tool: "place_character", args: { panel: 1, characterName: "Yuri", pose: "walking" } },
        { tool: "place_character", args: { panel: 1, characterName: "Cute Girl", pose: "walking" } },
      ]),
      doc: state.doc!,
      grounding,
      scope,
      panelCount: scope.panelCount,
    });
    expect(validated.blocked).toBe(false);

    const charactersBefore = Object.keys(state.doc!.characters).length;
    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });

    expect(summary.failed).toBe(0);
    expect(generationCalls).toHaveLength(0);
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(charactersBefore);
    // Both characters, each itself.
    expect(characterIdsIn(1).sort()).toEqual([base.yuri, base.cuteGirl].sort());
    // Only the targeted panel changed.
    expect(panelItems(2)).toHaveLength(0);
    expect(summary.validationIssues.filter((issue) => issue.code === "identity-mismatch")).toEqual([]);
  });

  it('"Yuri looks shocked" searches Yuri only and cannot land on Cute Girl', async () => {
    const base = fixture();
    seedStore(base.doc);
    const state = useEditorStore.getState();
    const grounding = groundPrompt({ doc: state.doc!, prompt: "Yuri looks shocked." });
    const validated = validateGroundedPlan({
      plan: planFor([
        { tool: "place_character", args: { panel: 1, characterName: "Yuri", expression: "shocked" } },
      ]),
      doc: state.doc!,
      grounding,
      panelCount: 4,
    });

    expect(validated.plan.steps[0].args.characterId).toBe(base.yuri);
    await executePlan(validated.plan, () => {}, DENY);

    expect(generationCalls).toHaveLength(0);
    expect(characterIdsIn(1)).toEqual([base.yuri]);
    const placed = panelItems(1)[0];
    const asset = useEditorStore.getState().doc!.assets[placed.sourceAssetId];
    expect(asset.metadata?.expression).toBe("shocked");
    expect(asset.metadata?.characterId).toBe(base.yuri);
  });

  it("a removed character is re-created under her own name, never substituted", async () => {
    const base = fixture();
    const doc = withoutYuri(base);
    seedStore(doc);
    const grounding = groundPrompt({ doc, prompt: "Yuri walks in." });

    expect(grounding.blocking).toEqual([]);
    expect(grounding.entities.find((e) => e.surface === "Yuri")?.resolution).toMatchObject({
      status: "create",
      proposedName: "Yuri",
    });

    // Creating HER is authorized; nothing here may reach another character.
    const validated = validateGroundedPlan({
      plan: planFor([
        { tool: "create_character", args: { name: "Yuri" } },
        { tool: "generate_character_asset", args: { characterName: "Yuri", kind: "reference" } },
        { tool: "place_character", args: { panel: 1, characterName: "Yuri" } },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(validated.blocked).toBe(false);
    expect(validated.creationAuthorized).toBe(true);
    expect(validated.authorizedCreationNames).toContain("yuri");
    // Still exactly two characters until the run actually executes.
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(2);
    expect(generationCalls).toHaveLength(0);
  });

  it("the executor itself refuses an unauthorized creation, even if validation is bypassed (§19)", async () => {
    const base = fixture();
    seedStore(withoutYuri(base));
    const before = Object.keys(useEditorStore.getState().doc!.characters).length;

    const summary = await executePlan(
      planFor([{ tool: "create_character", args: { name: "Yuri", appearance: "a girl" } }]),
      () => {},
      DENY,
    );

    expect(summary.failed).toBe(1);
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(before);
  });

  it("the executor refuses to substitute when a name reaches it unresolved", async () => {
    const base = fixture();
    seedStore(withoutYuri(base));
    const summary = await executePlan(
      planFor([{ tool: "place_character", args: { panel: 1, characterName: "Yuri" } }]),
      () => {},
      DENY,
    );
    expect(summary.failed).toBe(1);
    expect(panelItems(1)).toHaveLength(0);
    expect(generationCalls).toHaveLength(0);
  });

  it("authorized creation succeeds and is reported as authorized", async () => {
    const base = fixture();
    seedStore(base.doc);
    const before = Object.keys(useEditorStore.getState().doc!.characters).length;
    const grounding = groundPrompt({ doc: base.doc, prompt: "Create a new character named Hana." });
    const validated = validateGroundedPlan({
      plan: planFor([{ tool: "create_character", args: { name: "Hana", appearance: "a shy transfer student" } }]),
      doc: base.doc,
      grounding,
      panelCount: 4,
    });

    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });

    expect(summary.failed).toBe(0);
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(before + 1);
    // An authorized creation must not be flagged by the post-condition check.
    expect(summary.validationIssues.filter((i) => i.code === "unauthorized-character-creation")).toEqual([]);
  });

  it("post-conditions verify the document, not the command return value (§15)", async () => {
    const base = fixture();
    seedStore(base.doc);
    const grounding = groundPrompt({ doc: base.doc, prompt: "Place Yuri in panel 2." });
    const validated = validateGroundedPlan({
      plan: planFor([{ tool: "place_character", args: { panel: 2, characterName: "Yuri", pose: "walking" } }]),
      doc: base.doc,
      grounding,
      scope: resolveAgentScope({
        doc: base.doc,
        currentPageId: useEditorStore.getState().currentPageId,
        selection: {},
        prompt: "Place Yuri in panel 2.",
      }),
      panelCount: 4,
    });
    const summary = await executePlan(validated.plan, () => {}, DENY);

    expect(summary.validationIssues.filter((i) => i.code === "identity-mismatch")).toEqual([]);
    expect(characterIdsIn(2)).toEqual([base.yuri]);
  });
});

// ─── §21: repeated deterministic acceptance ────────────────────────────────

/**
 * Stability is not demonstrable from one successful prompt. This sweeps the
 * fixed inventory with many phrasings and asserts the three invariants on
 * every one — including against a deliberately hostile planner that tries to
 * create and substitute characters on each run.
 */
describe("repeated resolution acceptance", () => {
  const TEMPLATES = [
    (a: string, b: string) => `${a} is walking past ${b}.`,
    (a: string, b: string) => `${a} looks shocked when ${b} walks past.`,
    (a: string, b: string) => `Put ${a} beside ${b} in panel 2.`,
    (a: string, b: string) => `Show ${a} and ${b} talking in the classroom.`,
    (a: string, b: string) => `Make ${a} smile at ${b}.`,
    (a: string, b: string) => `${a.toLowerCase()} runs toward ${b.toLowerCase()}.`,
    (a: string, b: string) => `${a.toUpperCase()} STARES AT ${b.toUpperCase()}.`,
    (a: string, b: string) => `  ${a}   turns away from   ${b}  .`,
    (a: string, b: string) => `Place ${a} in panel 1 and ${b} in panel 1.`,
    (a: string, b: string) => `Add a close-up of ${a}, then a wide shot with ${b}.`,
    (a: string, b: string) => `${a}, still in her walking pose, notices ${b}.`,
    (a: string, b: string) => `Give ${a} a speech bubble and keep ${b} silent.`,
    (a: string, b: string) => `Zoom in on ${a} while ${b} stands behind her.`,
    (a: string, b: string) => `${a} bumps into ${b} at the school gate.`,
    (a: string, b: string) => `Reframe panel 1 around ${a}, keeping ${b} in frame.`,
    (a: string, b: string) => `A dramatic low angle of ${a} facing ${b}.`,
    (a: string, b: string) => `${a} waves; ${b} pretends not to see.`,
    (a: string, b: string) => `Set the panel so ${a} is in the foreground and ${b} in the background.`,
  ];

  it("runs 100+ scenarios with zero creations, zero substitutions, zero scope violations", () => {
    const base = fixture();
    const namesById: Record<ID, string> = {
      [base.yuri]: "Yuri",
      [base.cuteGirl]: "Cute Girl",
      [base.mio]: "Mio",
    };
    const pairs: [ID, ID][] = [
      [base.yuri, base.cuteGirl],
      [base.cuteGirl, base.yuri],
      [base.yuri, base.mio],
      [base.mio, base.yuri],
      [base.cuteGirl, base.mio],
      [base.mio, base.cuteGirl],
    ];

    let scenarios = 0;
    let accidentalCreations = 0;
    let substitutions = 0;
    let scopeViolations = 0;

    for (const template of TEMPLATES) {
      for (const [aId, bId] of pairs) {
        scenarios += 1;
        const aName = namesById[aId];
        const bName = namesById[bId];
        const prompt = template(aName, bName);

        const grounding = groundPrompt({ doc: base.doc, prompt });

        // Invariant 1: nothing in this sweep may authorize character creation.
        if (grounding.creation.allowed) accidentalCreations += 1;

        // Invariant 2: every named character resolves to ITS OWN id.
        for (const [id, name] of [
          [aId, aName],
          [bId, bName],
        ] as [ID, string][]) {
          const entity = grounding.entities.find((candidate) => candidate.characterId === id);
          if (!entity || entity.status !== "resolved" || entity.name !== name) substitutions += 1;
        }
        if (grounding.blocking.length > 0) substitutions += 1;

        // A hostile planner: invent a character, substitute the other one, and
        // wander outside the scoped panel.
        const scope = resolveAgentScope({
          doc: base.doc,
          currentPageId: Object.keys(base.doc.pages)[0],
          selection: { panelId: base.doc.pages[Object.keys(base.doc.pages)[0]].panelIds[0] },
          prompt,
        });
        const validated = validateGroundedPlan({
          plan: planFor([
            { tool: "create_character", args: { name: `${aName} Clone` } },
            { tool: "place_character", args: { panel: 1, characterName: aName } },
            { tool: "place_character", args: { panel: 1, characterName: bName } },
            { tool: "place_character", args: { panel: 3, characterName: aName } },
          ]),
          doc: base.doc,
          grounding,
          scope,
          panelCount: scope.panelCount,
        });

        if (validated.plan.steps.some((step) => step.tool === "create_character")) accidentalCreations += 1;
        if (validated.plan.steps.some((step) => step.tool === "place_character" && step.args.panel !== 1)) {
          scopeViolations += 1;
        }
        for (const step of validated.plan.steps) {
          if (step.tool !== "place_character") continue;
          const expected = step.args.characterName === aName ? aId : bId;
          if (step.args.characterId !== expected) substitutions += 1;
        }
      }
    }

    expect(scenarios).toBeGreaterThanOrEqual(100);
    expect(accidentalCreations).toBe(0);
    expect(substitutions).toBe(0);
    expect(scopeViolations).toBe(0);
  });

  it("sweeps adversarial spellings without a single silent substitution", () => {
    const base = fixture();
    const cases: { query: string; expect: "resolved" | "ambiguous" | "not-found"; id?: ID }[] = [
      { query: "Yuri", expect: "resolved", id: base.yuri },
      { query: "yuri", expect: "resolved", id: base.yuri },
      { query: "YURI", expect: "resolved", id: base.yuri },
      { query: " Yuri ", expect: "resolved", id: base.yuri },
      { query: "YuRi", expect: "resolved", id: base.yuri },
      { query: "Yuri-chan", expect: "resolved", id: base.yuri },
      { query: "Cute Girl", expect: "resolved", id: base.cuteGirl },
      { query: "cute girl", expect: "resolved", id: base.cuteGirl },
      { query: "CUTE  GIRL", expect: "resolved", id: base.cuteGirl },
      { query: "Mio", expect: "resolved", id: base.mio },
      { query: "Yu ri", expect: "ambiguous" },
      { query: "the black-haired girl", expect: "ambiguous" },
      { query: "the girl in the back", expect: "ambiguous" },
      { query: "Yu", expect: "not-found" },
      { query: "Girl", expect: "not-found" },
      // A leading-token match is unique and deterministic, so it resolves;
      // the trailing generic noun above does not. Two "Cute *" characters
      // would make this ambiguous rather than first-wins.
      { query: "Cute", expect: "resolved", id: base.cuteGirl },
      { query: "Yuri's friend", expect: "ambiguous" },
      { query: "Hana", expect: "not-found" },
      { query: "Yurika", expect: "not-found" },
      { query: "best friend", expect: "not-found" },
      { query: "", expect: "not-found" },
    ];

    for (const testCase of cases) {
      const result = resolveCharacterReference({ query: testCase.query, projectCharacters: characters(base.doc) });
      expect(result.status, testCase.query).toBe(testCase.expect);
      if (testCase.id) expect(result.status === "resolved" && result.characterId, testCase.query).toBe(testCase.id);
    }
  });
});
