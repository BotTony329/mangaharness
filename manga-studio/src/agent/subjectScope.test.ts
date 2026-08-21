/**
 * Subject vs scope — the cases from the reported failure.
 *
 * Every one of these is a sentence plus a selection, and the question is only
 * ever: who did the user mean, and where may the Agent write? A selection is
 * evidence; a name is authority.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import type { ID, ProjectDocument } from "@/domain/types";
import { groundPrompt } from "./grounding";
import { resolveSubject } from "./subject";
import { resolveAgentScope, scopeForSubject } from "./scope";
import { deriveSceneIntent, describeIntent } from "./sceneIntent";
import { validateStepScope } from "./tools/schemas";
import { addRelationship } from "@/domain/relationships";

interface Fixture {
  doc: ProjectDocument;
  pageId: ID;
  panelIds: ID[];
  yuri: ID;
  cute: ID;
  mori: ID;
  yuriItem: ID;
  cuteItem: ID;
  lampItem: ID;
  bgItem: ID;
}

function fixture(): Fixture {
  let doc = createProjectDocument("Subject vs scope");
  const ids: Record<string, ID> = {};
  for (const name of ["Yuri", "Cute Girl", "Mori"]) {
    const created = addCharacter(doc, name);
    doc = created.doc;
    ids[name] = created.characterId;
    const asset = addAsset(doc, {
      category: "character",
      name: `${name} standing`,
      storageUrl: `https://example.com/${name}.png`,
      processedImageUrl: `https://example.com/${name}-a.png`,
      width: 800,
      height: 1400,
      metadata: {
        characterId: created.characterId,
        characterAssetRole: "state",
        pose: "standing",
        expression: "neutral",
        outfit: "default outfit",
        view: "front",
      },
    });
    doc = asset.doc;
    ids[`${name}-asset`] = asset.assetId;
  }
  const lamp = addAsset(doc, {
    category: "prop",
    name: "Desk lamp",
    storageUrl: "https://example.com/lamp.png",
    processedImageUrl: "https://example.com/lamp-a.png",
    width: 600,
    height: 600,
  });
  doc = lamp.doc;
  const bg = addAsset(doc, {
    category: "background",
    name: "Classroom",
    storageUrl: "https://example.com/bg.png",
    width: 2000,
    height: 1400,
  });
  doc = bg.doc;

  const pageId = Object.values(doc.pages)[0].id;
  doc = applyDomainCommand(doc, { type: "set-page-layout", pageId, layout: "four-grid" }).doc;
  const panelIds = doc.pages[pageId].panelIds;

  const place = (panelIndex: number, assetId: ID): ID => {
    const result = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[panelIndex], assetId });
    doc = result.doc;
    return result.createdId!;
  };
  const bgItem = place(0, bg.assetId);
  const yuriItem = place(0, ids["Yuri-asset"]);
  const cuteItem = place(0, ids["Cute Girl-asset"]);
  const lampItem = place(0, lamp.assetId);

  return {
    doc,
    pageId,
    panelIds,
    yuri: ids["Yuri"],
    cute: ids["Cute Girl"],
    mori: ids["Mori"],
    yuriItem,
    cuteItem,
    lampItem,
    bgItem,
  };
}

/** The real pipeline up to (not including) the model call. */
function understand(f: Fixture, prompt: string, selectedItemId?: ID) {
  const selection = selectedItemId ? { itemId: selectedItemId, panelId: f.doc.items[selectedItemId].panelId } : {};
  let scope = resolveAgentScope({ doc: f.doc, currentPageId: f.pageId, selection, prompt });
  const selectedItem = selectedItemId ? f.doc.items[selectedItemId] : undefined;
  const selectedCharacterId =
    selectedItem?.kind === "asset"
      ? selectedItem.characterState?.characterId ?? f.doc.assets[selectedItem.sourceAssetId]?.metadata?.characterId
      : undefined;
  const grounding = groundPrompt({
    doc: f.doc,
    prompt,
    selectedCharacterId,
    selectedInstanceId: selectedItemId,
    sceneCharacterIds: [f.yuri, f.cute],
  });
  const subject = resolveSubject({ doc: f.doc, grounding });
  scope = scopeForSubject(scope, subject, f.doc);
  const intent = deriveSceneIntent({ doc: f.doc, prompt, grounding, subject, scope });
  return { grounding, subject, scope, intent };
}

describe("an explicitly named character outranks the selection", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it("CASE A — a selected background does not become the subject", () => {
    const { subject, scope } = understand(f, "Make Cute Girl smile.", f.bgItem);
    expect(subject.characterIds).toEqual([f.cute]);
    expect(subject.basis).toBe("explicit-name");
    expect(subject.usedSelection).toBe(false);
    // The selection stops being a target, but still says which panel we are in.
    expect(scope.kind).toBe("selected-panel");
    expect(scope.demotedFrom).toBe("selected-object");
  });

  it("CASE B — a selected Yuri does not answer for a named Cute Girl", () => {
    const { subject } = understand(f, "Make Cute Girl run.", f.yuriItem);
    expect(subject.characterIds).toEqual([f.cute]);
    expect(subject.usedSelection).toBe(false);
  });

  it("CASE C — a pronoun DOES resolve from the selection", () => {
    const { subject, scope } = understand(f, "Make her smile.", f.cuteItem);
    expect(subject.characterIds).toEqual([f.cute]);
    expect(subject.usedSelection).toBe(true);
    // Nothing was named, so the selection remains the authoritative target.
    expect(scope.kind).toBe("selected-object");
  });

  it("CASE D — a relationship resolves the partner", () => {
    f.doc = addRelationship(f.doc, { characterAId: f.yuri, characterBId: f.mori, type: "close_friend" }).doc;
    const { grounding, subject } = understand(f, "Yuri hugs her close friend.");
    expect(grounding.entities.some((e) => e.characterId === f.mori && e.status === "resolved")).toBe(true);
    expect(subject.characterIds[0]).toBe(f.yuri);
  });

  it("CASE D — a relationship phrase becomes ONE interaction beat, not two poses", () => {
    f.doc = addRelationship(f.doc, { characterAId: f.yuri, characterBId: f.mori, type: "close_friend" }).doc;
    const { intent } = understand(f, "Yuri hugs her close friend.");
    const hug = intent.beats.find((beat) => beat.type === "interaction");
    expect(hug).toMatchObject({ actor: f.yuri, partner: f.mori, interaction: "hug" });
  });

  it("CASE D — deleting the relationship makes the phrase unresolvable, not a guess", () => {
    // No relationship in the graph at all.
    const { grounding, subject } = understand(f, "Yuri hugs her close friend.");
    const phrase = grounding.entities.find((entity) => entity.surface.includes("close friend"));
    expect(phrase?.status).not.toBe("resolved");
    expect(grounding.blocking.length).toBeGreaterThan(0);
    // Nobody was invented and nobody was substituted.
    expect(subject.characterIds).toEqual([f.yuri]);
  });

  it("CASE E — the reported failure: a selected lamp never overrides Cute Girl", () => {
    const prompt = "let Cute girl run to the camera and then shouting Yuri's name";
    const { grounding, subject, scope, intent } = understand(f, prompt, f.lampItem);

    // Understanding
    expect(grounding.entities.filter((e) => e.status === "resolved").map((e) => e.characterId)).toEqual([
      f.cute,
      f.yuri,
    ]);
    // Subject — reading order, not creation order, and not the lamp.
    expect(subject.characterIds[0]).toBe(f.cute);
    expect(subject.usedSelection).toBe(false);

    // Scope widened from the object to its panel, with a stated reason.
    expect(scope.kind).toBe("selected-panel");
    expect(scope.demotionReason).toMatch(/context rather than as the target/);

    // The steps this request needs are no longer scope violations.
    expect(validateStepScope("place_character", { panel: scope.panelNumber, characterName: "Cute Girl" }, scope)).toBeNull();
    expect(validateStepScope("add_speech_bubble", { panel: scope.panelNumber, bubbleType: "shout", text: "Yuri!" }, scope)).toBeNull();

    // Two sequential beats, correct actor, correct dialogue, camera intent kept.
    expect(intent.sequential).toBe(true);
    expect(intent.panelsRequested).toBe(2);
    expect(intent.beats).toHaveLength(2);
    expect(intent.beats[0]).toMatchObject({ type: "movement", actor: f.cute, action: "running", direction: "toward_camera" });
    expect(intent.beats[1]).toMatchObject({ type: "dialogue", actor: f.cute, delivery: "shout", text: "Yuri!" });
    expect(intent.beats[1].references).toEqual([f.yuri]);
    expect(intent.participants).toEqual([
      { characterId: f.cute, role: "subject" },
      { characterId: f.yuri, role: "referenced" },
    ]);
    expect(describeIntent(intent, f.doc)).toEqual([
      "1. Cute Girl running toward the camera",
      '2. Cute Girl shouts "Yuri!"',
    ]);
  });

  it("CASE F — a panel request with no named character keeps panel context", () => {
    const { subject, scope } = understand(f, "make this panel more dramatic", f.bgItem);
    expect(subject.basis).toBe("none");
    expect(subject.characterIds).toEqual([]);
    // No subject means the selection is all the Agent has to go on; keep it.
    expect(scope.kind).toBe("selected-object");
  });

  it("does not invent a subject when the prompt names nobody and nothing is selected", () => {
    const { subject } = understand(f, "add some speed lines");
    expect(subject.basis).toBe("none");
    expect(subject.characterIds).toEqual([]);
  });

  it("scope never asks what kind of object is selected", () => {
    // A bubble, an effect and a prop all produce a usable scope.
    const withBubble = applyDomainCommand(f.doc, {
      type: "add-bubble",
      panelId: f.panelIds[0],
      bubbleType: "speech",
      text: "hi",
    });
    const bubbleId = withBubble.createdId!;
    const scope = resolveAgentScope({
      doc: withBubble.doc,
      currentPageId: f.pageId,
      selection: { itemId: bubbleId, panelId: f.panelIds[0] },
      prompt: "make it louder",
    });
    expect(scope.kind).toBe("selected-object");
    expect(scope.label).toContain("Speech bubble");
  });
});

describe("temporal language", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it("splits on 'then' and asks for panel progression", () => {
    const { intent } = understand(f, "Yuri runs, then stops and smiles");
    expect(intent.sequential).toBe(true);
    expect(intent.panelsRequested).toBe(2);
  });

  it("keeps simultaneous actions in one panel", () => {
    const { intent } = understand(f, "Yuri runs and smiles");
    expect(intent.sequential).toBe(false);
    expect(intent.panelsRequested).toBe(1);
  });
});
