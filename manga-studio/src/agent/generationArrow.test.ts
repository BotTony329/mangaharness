/**
 * The arrow that was missing: PROMPT → REQUIREMENT → GENERATION → USE.
 *
 * The production failure this encodes: "The bad guy roach man punching to the
 * camera" returned "Roach Man does not exist in the project's character
 * inventory, and creating new characters is forbidden for this run." Nothing
 * was wrong with the sentence. The Agent could identify what the request
 * needed and could generate assets, and there was no arrow between the two.
 *
 * These tests run the whole path with the network stubbed, so what they prove
 * is the WIRING — that a character the library has never heard of ends up in
 * the library, with a drawable asset, placed on the page — not the quality of
 * any image. The one thing they cannot cover is the provider call itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfAsset } from "@/characters/identity";
import { deriveAssetRequirements } from "./assetRequirements";
import { fulfilRequirements } from "./fulfilRequirements";
import { executePlan } from "./executor";
import { groundPrompt, groundingContext } from "./grounding";
import { resolveSubject } from "./subject";
import { deriveSceneIntent } from "./sceneIntent";
import { buildSequencePlan } from "./sequencePlan";
import { resolveAgentScope, scopeForPanels, scopeForSubject } from "./scope";
import { validateGroundedPlan } from "./planValidation";
import { validatePlan } from "./tools/schemas";

const PROMPT = "The bad guy Roach Man punching to the camera";

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

let generatedPrompts: string[] = [];

function stubNetwork() {
  generatedPrompts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/provider/status")) {
      return new Response(JSON.stringify({ capabilities: { referenceImage: true, supportsTransparentBackground: true } }), { status: 200 });
    }
    if (url.includes("/api/generate")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      generatedPrompts.push(body.prompt ?? "");
      const n = generatedPrompts.length;
      return new Response(
        JSON.stringify({
          url: `https://example.com/generated-${n}.png`,
          sourceUrl: `https://example.com/generated-${n}.png`,
          processedImageUrl: `https://example.com/generated-${n}-alpha.png`,
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
  const doc = createProjectDocument("Generation arrow");
  useEditorStore.getState().loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "two-vertical" });
  return { pageId, panelIds: useEditorStore.getState().doc!.pages[pageId].panelIds };
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

describe("a character the library has never heard of", () => {
  it("is CREATED and GENERATED rather than refused", async () => {
    openProject();
    const { requirements } = understand(PROMPT);

    expect(requirements.generationCount).toBeGreaterThan(0);
    const result = await fulfilRequirements(requirements.requirements);

    // The character now exists, in the ordinary library, under the creator's name.
    expect(result.created.map((c) => c.name)).toContain("Roach Man");
    const doc = useEditorStore.getState().doc!;
    const created = Object.values(doc.characters).find((c) => c.name === "Roach Man");
    expect(created).toBeDefined();

    // And has a drawable asset attributed to them.
    const owned = Object.values(doc.assets).filter((asset) => characterIdOfAsset(doc, asset.id) === created!.id);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((asset) => asset.processingStatus === "ready")).toBe(true);
  });

  it("describes the character to the image model in the creator's own words", async () => {
    openProject();
    const { requirements } = understand(PROMPT);
    await fulfilRequirements(requirements.requirements);
    expect(generatedPrompts.join(" ").toLowerCase()).toContain("roach man");
  });

  it("is REUSED, not re-created, the second time they are named", async () => {
    openProject();
    await fulfilRequirements(understand(PROMPT).requirements.requirements);
    const afterFirst = Object.keys(useEditorStore.getState().doc!.characters).length;

    const second = understand("Roach Man punching to the camera again");
    expect(second.subject.newCharacters).toHaveLength(0);
    expect(second.requirements.requirements.some((r) => r.fulfilment.how === "create-entity")).toBe(false);
    await fulfilRequirements(second.requirements.requirements);
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(afterFirst);
  });

  it("lands on the PAGE — the whole point of the request", async () => {
    const { pageId, panelIds } = openProject();
    const { requirements, grounding, scope } = understand(PROMPT);
    await fulfilRequirements(requirements.requirements);

    const doc = useEditorStore.getState().doc!;
    const { plan: agentPlan } = validatePlan({
      summary: "Roach Man punches toward the camera",
      steps: [{ tool: "place_character", args: { characterName: "Roach Man", panel: 1, pose: "punching" } }],
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
    expect(summary.failed).toBe(0);

    const after = useEditorStore.getState().doc!;
    const roach = Object.values(after.characters).find((c) => c.name === "Roach Man")!;
    const placed = after.panels[panelIds[0]].itemIds
      .map((id) => after.items[id])
      .filter((item) => item.kind === "asset" && characterIdOfAsset(after, item.sourceAssetId) === roach.id);
    expect(placed.length).toBeGreaterThan(0);
    expect(after.pages[pageId]).toBeDefined();
  });
});

describe("validation does not reject what the run is about to create", () => {
  it("accepts a step naming a character that does not exist YET", () => {
    const { panelIds } = openProject();
    const { grounding, scope } = understand(PROMPT);
    const doc = useEditorStore.getState().doc!;
    expect(Object.values(doc.characters)).toHaveLength(0);

    const { plan: agentPlan } = validatePlan({
      summary: "Place Roach Man",
      steps: [{ tool: "place_character", args: { characterName: "Roach Man", panel: 1 } }],
    });
    const validated = validateGroundedPlan({ plan: agentPlan!, doc, grounding, scope, panelCount: panelIds.length });
    expect(validated.rejected).toHaveLength(0);
    expect(validated.blocked).toBe(false);
  });
});

describe("an existing character is never re-created by the arrow", () => {
  it("generates only the missing STATE", async () => {
    openProject();
    let doc = useEditorStore.getState().doc!;
    const yuri = addCharacter(doc, "Yuri", "quiet second-year");
    doc = yuri.doc;
    const canonical = addAsset(doc, {
      category: "character",
      name: "Yuri canonical reference",
      storageUrl: "https://example.com/yuri.png",
      processedImageUrl: "https://example.com/yuri-alpha.png",
      width: 900,
      height: 1400,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: yuri.characterId, characterAssetRole: "canonical", pose: "standing", expression: "neutral", outfit: "default outfit", view: "front" },
    });
    doc = canonical.doc;
    doc = { ...doc, characters: { ...doc.characters, [yuri.characterId]: { ...doc.characters[yuri.characterId], referenceAssetId: canonical.assetId } } };
    useEditorStore.getState().loadDocument(doc);

    const { requirements } = understand("Yuri punching to the camera");
    expect(requirements.requirements.some((r) => r.fulfilment.how === "create-entity")).toBe(false);

    const before = Object.keys(useEditorStore.getState().doc!.characters).length;
    await fulfilRequirements(requirements.requirements);
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(before);
    const punching = Object.values(useEditorStore.getState().doc!.assets).find((asset) => asset.metadata?.pose === "punching");
    expect(punching).toBeDefined();
  });
});

/**
 * The refusal the creator actually saw was written by the MODEL, not thrown by
 * the runtime — because the context block handed to it said creation was
 * forbidden. Fixing the runtime alone would have left the message intact.
 */
describe("what the planner is told", () => {
  it("never calls an introduced character a forbidden creation", () => {
    openProject();
    const { grounding } = understand(PROMPT);
    const context = groundingContext(grounding).join("\n");

    expect(context).not.toContain("CHARACTER CREATION: FORBIDDEN");
    expect(context).toContain("CHARACTER CREATION: AUTHORIZED");
    expect(context).toContain("Roach Man");
    expect(context).toMatch(/NEW CHARACTER/);
    // And it is told they will already be drawable, so it composes with them.
    expect(context).toMatch(/BEFORE your steps run/);
  });

  it("still forbids inventing an answer to a POINTING reference", () => {
    openProject();
    const doc = useEditorStore.getState().doc!;
    const yuri = addCharacter(doc, "Yuri", "quiet second-year");
    useEditorStore.getState().loadDocument(yuri.doc);

    const { grounding } = understand("Yuri hugs her sister");
    const context = groundingContext(grounding).join("\n");
    expect(context).toContain("UNRESOLVED");
    expect(context).toContain("do not create one");
  });
});
