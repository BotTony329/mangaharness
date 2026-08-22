/**
 * Golden cases for temporal planning and camera intent.
 *
 * These run the REAL pipeline — grounding, subject, scope, scene intent,
 * sequence plan, compilation, validation, transaction — with the external model
 * call stubbed and nothing else. A test that only exercised the helpers would
 * pass while the executor still put both beats in one panel, which is the exact
 * failure this closes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { groundPrompt } from "./grounding";
import { resolveSubject } from "./subject";
import { resolveAgentScope, scopeForPanels, scopeForSubject } from "./scope";
import { deriveSceneIntent } from "./sceneIntent";
import { buildSequencePlan, compileSequencePlan } from "./sequencePlan";
import { executePlan } from "@/agent-v2";
import { validatePlan } from "./tools/schemas";
import { validateGroundedPlan } from "./planValidation";

interface Fixture {
  yuri: ID;
  mori: ID;
  cute: ID;
  pageId: ID;
  /** An untouched panel with content, to prove preservation. */
  bystanderItemId: ID;
}

function seed(): Fixture {
  let doc: ProjectDocument = createProjectDocument("Sequence golden");
  const ids: Record<string, ID> = {};
  for (const name of ["Yuri", "Mori", "Cute Girl"]) {
    const created = addCharacter(doc, name);
    doc = created.doc;
    ids[name] = created.characterId;
    for (const pose of ["standing", "running", "walking", "looking back"]) {
      const asset = addAsset(doc, {
        category: "character",
        name: `${name} ${pose}`,
        storageUrl: `https://example.com/${name}-${pose}.png`,
        processedImageUrl: `https://example.com/${name}-${pose}-a.png`,
        width: 800,
        height: 1400,
        hasAlpha: true,
        backgroundRemoved: true,
        processingStatus: "ready",
        metadata: {
          characterId: created.characterId,
          characterAssetRole: "state",
          pose,
          expression: "neutral",
          outfit: "default outfit",
          view: "front",
        },
      });
      doc = asset.doc;
      ids[`${name}-${pose}`] = asset.assetId;
    }
  }
  const pageId = Object.values(doc.pages)[0].id;
  doc = applyDomainCommand(doc, { type: "set-page-layout", pageId, layout: "two-vertical" }).doc;
  const panelIds = doc.pages[pageId].panelIds;

  // Panel 1 already holds Yuri; panel 2 holds an unrelated bystander bubble.
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId: ids["Yuri-standing"] });
  doc = placed.doc;
  const bystander = applyDomainCommand(doc, {
    type: "add-bubble",
    panelId: panelIds[1],
    bubbleType: "narration",
    text: "Unrelated existing content",
  });
  doc = bystander.doc;

  useEditorStore.getState().loadDocument(doc);
  return { yuri: ids["Yuri"], mori: ids["Mori"], cute: ids["Cute Girl"], pageId, bystanderItemId: bystander.createdId! };
}

/** The real pipeline up to the model call. */
function plan(prompt: string, selectedItemId?: ID) {
  const state = useEditorStore.getState();
  const doc = state.doc!;
  const selection = selectedItemId ? { itemId: selectedItemId, panelId: doc.items[selectedItemId].panelId } : {};
  let scope = resolveAgentScope({ doc, currentPageId: state.currentPageId, selection, prompt });
  const grounding = groundPrompt({ doc, prompt, sceneCharacterIds: [] });
  const subject = resolveSubject({ doc, grounding });
  scope = scopeForSubject(scope, subject, doc);
  const intent = deriveSceneIntent({ doc, prompt, grounding, subject, scope });
  const characterIds = subject.characterIds.length > 0
    ? subject.characterIds
    : grounding.entities.filter((e) => e.characterId).map((e) => e.characterId as ID);
  const sequence = buildSequencePlan({ doc, intent, scope, characterIds });
  scope = scopeForPanels(scope, sequence.allocation.panelNumbers, sequence.needsPanelLevel);
  const steps = compileSequencePlan(sequence, doc);
  return { doc, scope, grounding, subject, intent, sequence, steps };
}

/** Compile, validate and RUN — the whole path, model excluded. */
async function run(prompt: string, selectedItemId?: ID) {
  const built = plan(prompt, selectedItemId);
  const { plan: validPlan } = validatePlan(
    { summary: built.sequence.allocation.reason, steps: built.steps },
    { ...built.scope, panelCount: Math.max(built.scope.panelCount, ...built.sequence.allocation.panelNumbers) },
  );
  const validated = validateGroundedPlan({
    plan: validPlan,
    doc: built.doc,
    grounding: built.grounding,
    scope: built.scope,
    panelCount: Math.max(built.scope.panelCount, ...built.sequence.allocation.panelNumbers),
  });
  const summary = await executePlan(
    validated.plan,
    () => {},
    { creationAuthorized: false, authorizedCreationNames: [] },
    built.sequence,
  );
  return { ...built, summary, after: useEditorStore.getState().doc! };
}

function panelOf(doc: ProjectDocument, pageId: ID, number: number) {
  return doc.panels[doc.pages[pageId].panelIds[number - 1]];
}

function charactersIn(doc: ProjectDocument, pageId: ID, number: number): ID[] {
  const panel = panelOf(doc, pageId, number);
  return (panel?.itemIds ?? [])
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .map((item) => item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId)
    .filter((id): id is ID => Boolean(id));
}

function bubblesIn(doc: ProjectDocument, pageId: ID, number: number) {
  return (panelOf(doc, pageId, number)?.itemIds ?? [])
    .map((id) => doc.items[id])
    .filter((item) => item?.kind === "bubble");
}

describe("temporal planning is enforced, not suggested", () => {
  let f: Fixture;
  beforeEach(() => {
    f = seed();
    // Nothing here may reach a provider; a call would be a bug, not a fixture.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("No generation is allowed in these cases");
    }));
  });

  it("CASE A — 下一格Yuri说你好 puts the line in the NEXT panel", async () => {
    const yuriItem = panelOf(useEditorStore.getState().doc!, f.pageId, 1)!.itemIds[0];
    const result = await run("下一格Yuri说“你好”", yuriItem);

    expect(result.summary.rolledBack).toBe(false);
    expect(result.sequence.beats[0].panelNumber).toBe(2);

    // Yuri is preserved in panel 1 and now also present in panel 2.
    expect(charactersIn(result.after, f.pageId, 1)).toContain(f.yuri);
    expect(charactersIn(result.after, f.pageId, 2)).toContain(f.yuri);

    const lines = bubblesIn(result.after, f.pageId, 2).map((b) => (b as { text: string }).text);
    expect(lines).toContain("你好");
    // Not in panel 1.
    expect(bubblesIn(result.after, f.pageId, 1).map((b) => (b as { text: string }).text)).not.toContain("你好");
  });

  it("CASE E — 第一格Yuri走进来，下一格她看到Mori maps two beats to two panels", async () => {
    const result = await run("第一格Yuri走进来，下一格她看到Mori");

    expect(result.sequence.requiredPanelCount).toBe(2);
    expect(result.sequence.beats.map((b) => b.panelNumber)).toEqual([1, 2]);
    expect(result.summary.rolledBack).toBe(false);
    expect(charactersIn(result.after, f.pageId, 1)).toContain(f.yuri);
    expect(charactersIn(result.after, f.pageId, 2)).toContain(f.yuri);
  });

  it("treats 同时 as ONE moment rather than a new panel", () => {
    const built = plan("Yuri走进来，同时Mori在看她");
    expect(built.intent.sequential).toBe(false);
    expect(built.sequence.requiredPanelCount).toBe(1);
  });

  it("grows the layout instead of overwriting, when the page is too short", async () => {
    // A single-panel page asked for three moments.
    const store = useEditorStore.getState();
    store.dispatch({ type: "set-page-layout", pageId: f.pageId, layout: "single" });
    const built = plan("Yuri走进来，然后她看到Mori，然后她笑了");
    expect(built.sequence.allocation.layoutUpgrade).toBe("three-vertical");
    expect(built.steps[0]).toMatchObject({ tool: "set_page_layout", args: { layout: "three-vertical" } });
  });
});

describe("camera intent reaches the document", () => {
  let f: Fixture;
  beforeEach(() => {
    f = seed();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Camera work must never generate");
    }));
  });

  it("CASE B — Yuri在前景，Mori在后面 orders depth in ONE panel", async () => {
    const result = await run("Yuri在前景，Mori在后面");

    expect(result.sequence.requiredPanelCount).toBe(1);
    expect(result.summary.rolledBack).toBe(false);

    const depth = (characterId: ID) => {
      const panel = panelOf(result.after, f.pageId, 1)!;
      const item = panel.itemIds
        .map((id) => result.after.items[id])
        .find((entry): entry is AssetInstance => {
          if (entry?.kind !== "asset") return false;
          const owner = entry.characterState?.characterId ?? result.after.assets[entry.sourceAssetId]?.metadata?.characterId;
          return owner === characterId;
        });
      return item?.stage?.depth;
    };
    const yuriDepth = depth(f.yuri);
    const moriDepth = depth(f.mori);
    expect(yuriDepth).toBeDefined();
    expect(moriDepth).toBeDefined();
    // Nearer the camera is a SMALLER depth.
    expect(yuriDepth!).toBeLessThan(moriDepth!);
  });

  it("CASE C — 给Yuri一个特写 sets framing and generates nothing", async () => {
    const result = await run("给Yuri一个特写");

    expect(panelOf(result.after, f.pageId, 1)!.camera?.shot).toBe("close-up");
    expect(result.summary.rolledBack).toBe(false);
    // A close-up re-frames existing artwork.
    expect(result.after.generationHistory).toHaveLength(0);
  });

  it("CASE D — 低机位广角拍Yuri sets angle and lens, and generates nothing", async () => {
    const result = await run("低机位广角拍Yuri");
    const camera = panelOf(result.after, f.pageId, 1)!.camera;
    expect(camera?.angle).toBe("low");
    expect(camera?.lens).toBe("wide");
    expect(result.after.generationHistory).toHaveLength(0);
  });

  it("camera work is not blocked by whatever happens to be selected", async () => {
    // A character is selected; the request is about the panel's camera.
    const yuriItem = panelOf(useEditorStore.getState().doc!, f.pageId, 1)!.itemIds[0];
    const result = await run("给Yuri一个特写", yuriItem);

    expect(result.scope.kind).toBe("selected-panel");
    expect(result.scope.demotionReason).toMatch(/camera or framing/);
    expect(result.summary.rolledBack).toBe(false);
    expect(panelOf(result.after, f.pageId, 1)!.camera?.shot).toBe("close-up");
  });

  it("maps the English vocabulary too", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["close-up of Yuri", { shot: "close-up" }],
      ["wide shot", { shot: "wide" }],
      ["low angle on Yuri", { angle: "low" }],
      ["high angle", { angle: "high" }],
      ["eye level", { angle: "eye-level" }],
      ["dutch angle", { angle: "dutch", roll: 12 }],
      ["wide-angle lens", { lens: "wide" }],
      ["telephoto", { lens: "telephoto" }],
    ];
    for (const [prompt, expected] of cases) {
      const built = plan(prompt);
      expect(built.sequence.beats[0]?.camera, prompt).toMatchObject(expected);
    }
  });
});

describe("the combined Chinese acceptance case", () => {
  let f: Fixture;
  beforeEach(() => {
    f = seed();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("This case must not generate");
    }));
  });

  const PROMPT =
    "第一格，Yuri在前景，Mori站在她身后的街道上，用广角低机位。下一格，镜头拉近Yuri，她回头看Mori，说“你怎么来了？”";

  it("CASE F — two panels, correct subjects, camera and dialogue", async () => {
    const result = await run(PROMPT);

    expect(result.summary.rolledBack).toBe(false);
    expect(result.summary.validationIssues.filter((i) => i.severity === "fatal")).toEqual([]);

    // Two beats, two panels, in order.
    expect(result.sequence.beats.map((b) => b.panelNumber)).toEqual([1, 2]);

    // Panel 1: both actors, Yuri nearer, wide lens at a low angle.
    expect(charactersIn(result.after, f.pageId, 1)).toEqual(expect.arrayContaining([f.yuri, f.mori]));
    const first = panelOf(result.after, f.pageId, 1)!;
    expect(first.camera?.lens).toBe("wide");
    expect(first.camera?.angle).toBe("low");

    // Panel 2: Yuri, closer framing, focus on her, and the line.
    const second = panelOf(result.after, f.pageId, 2)!;
    expect(charactersIn(result.after, f.pageId, 2)).toContain(f.yuri);
    expect(second.camera?.shot).toBe("close-up");
    const lines = bubblesIn(result.after, f.pageId, 2).map((b) => (b as { text: string }).text);
    expect(lines).toContain("你怎么来了？");

    // The line is NOT in panel 1.
    expect(bubblesIn(result.after, f.pageId, 1).map((b) => (b as { text: string }).text)).not.toContain("你怎么来了？");
  });

  it("CASE G — unrelated pre-existing content survives", async () => {
    const before = useEditorStore.getState().doc!;
    const bystanderText = (before.items[f.bystanderItemId] as { text: string }).text;
    const result = await run(PROMPT);

    expect(result.after.items[f.bystanderItemId]).toBeDefined();
    expect((result.after.items[f.bystanderItemId] as { text: string }).text).toBe(bystanderText);
    // Every character that existed still exists; none were invented.
    expect(Object.keys(result.after.characters).sort()).toEqual(Object.keys(before.characters).sort());
  });

  it("undo restores the whole document and redo restores the result", async () => {
    const before = structuredClone(useEditorStore.getState().doc!);
    const result = await run(PROMPT);
    const after = structuredClone(result.after);
    expect(after).not.toEqual(before);

    useEditorStore.getState().undo();
    const undone = useEditorStore.getState().doc!;
    expect(undone.panels).toEqual(before.panels);
    expect(undone.items).toEqual(before.items);

    useEditorStore.getState().redo();
    const redone = useEditorStore.getState().doc!;
    expect(redone.panels).toEqual(after.panels);
    expect(redone.items).toEqual(after.items);
  });
});
