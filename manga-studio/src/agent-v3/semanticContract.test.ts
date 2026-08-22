/**
 * Golden: SEMANTIC CONTRACT GENERALIZATION.
 *
 * Creative language ("arrived", "comforts", "lonely and oppressive") enters
 * the Task Map as natural strings; translation to editor enums happens once,
 * in the routing semantics layer. Unknown wording is SOFT (fallback +
 * warning, raw intent preserved); only structure/identity stays HARD.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { parseCreativeTaskMap } from "./contract/creativeTaskMap";
import { resolveTaskMap } from "./resolution/entityResolver";
import { compileTaskMap, creationAuthorization } from "./routing/capabilityRouter";
import { resolveInteraction } from "./routing/interactionSemantics";
import { resolveDialogueDelivery } from "./routing/dialogueSemantics";

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

beforeEach(() => {
  useEditorStore.getState().loadDocument(createProjectDocument("Semantics golden"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate")) {
      return new Response(
        JSON.stringify({
          url: "https://example.com/g.png",
          sourceUrl: "https://example.com/g.png",
          processedImageUrl: "https://example.com/g-a.png",
          mimeType: "image/png",
          hasAlpha: true,
          processingStatus: "ready",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

const BASE = {
  version: 1,
  summary: "s",
  intent: "new_scene",
  participants: [
    { name: "Kiki", resolutionIntent: "create_if_missing", attributes: ["Japanese", "school girl"], relationships: [] },
  ],
  objects: [],
  effects: [],
  localEdits: [],
  target: { scope: "current_page" },
};

function compileRaw(raw: unknown) {
  const { map, error } = parseCreativeTaskMap(raw);
  if (!map) throw new Error(`contract rejected: ${error}`);
  const doc = useEditorStore.getState().doc!;
  const resolution = resolveTaskMap(map, doc);
  return { map, resolution, ...compileTaskMap(map, resolution) };
}

describe("semantic contract generalization", () => {
  it("CASE A: 'arrived at the school gate' — no enum, no fake interaction, run completes", async () => {
    const { plan, warnings } = compileRaw({
      ...BASE,
      summary: "A cool Japanese school girl arrived at the school gate",
      scene: { description: "a school gate" },
      beats: [{ panel: 1, actor: "Kiki", action: "arriving at the school gate", poseDetails: [], dialogueKind: "speech" }],
    });
    // Single-actor movement: place_character with the raw action, NO interaction step.
    const placement = plan.steps.find((s) => s.tool === "place_character");
    expect(placement?.args.pose).toBe("arriving at the school gate");
    expect(plan.steps.some((s) => s.tool === "create_interaction")).toBe(false);

    const names = creationAuthorization(resolveTaskMap(parseCreativeTaskMap({ ...BASE, scene: { description: "a school gate" }, beats: [{ panel: 1, actor: "Kiki", action: "arriving at the school gate", poseDetails: [] }] }).map!, useEditorStore.getState().doc!));
    const summary = await executePlan(plan, () => {}, { creationAuthorized: names.length > 0, authorizedCreationNames: names });
    expect(summary.status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  it("CASE B: 'runs toward' — free action wording accepted, preserved for generation", () => {
    const { plan } = compileRaw({
      ...BASE,
      beats: [{ panel: 1, actor: "Kiki", action: "running toward the school gate", poseDetails: [], dialogueKind: "speech" }],
    });
    const generation = plan.steps.find((s) => s.tool === "generate_character_asset" && s.args.kind === "pose");
    expect(String(generation?.args.instruction)).toContain("running toward the school gate");
  });

  it("CASE C: 'hugs' is a true interaction → create_interaction with editor enum", () => {
    const { plan } = compileRaw({
      ...BASE,
      participants: [
        BASE.participants[0],
        { name: "Mori", resolutionIntent: "create_if_missing", attributes: [], relationships: [] },
      ],
      beats: [{ panel: 1, actor: "Kiki", target: "Mori", interaction: "hugs", poseDetails: [], dialogueKind: "speech" }],
    });
    const interaction = plan.steps.find((s) => s.tool === "create_interaction");
    expect(interaction?.args.interaction).toBe("hug");
  });

  it("CASE D: 'argues with' — no contract failure; maps to face_to_face", () => {
    const { plan, warnings } = compileRaw({
      ...BASE,
      participants: [
        BASE.participants[0],
        { name: "Mori", resolutionIntent: "create_if_missing", attributes: [], relationships: [] },
      ],
      beats: [{ panel: 1, actor: "Kiki", target: "Mori", interaction: "argues with", poseDetails: [], dialogueKind: "speech" }],
    });
    const interaction = plan.steps.find((s) => s.tool === "create_interaction");
    expect(interaction?.args.interaction).toBe("face_to_face");
    expect(warnings).toEqual([]);
  });

  it("CASE E: 'comforts a crying Mori' — accepted, maps to hug, no strict enum failure", () => {
    expect(resolveInteraction("comforts")?.type).toBe("hug");
    const { plan } = compileRaw({
      ...BASE,
      participants: [
        BASE.participants[0],
        { name: "Mori", resolutionIntent: "create_if_missing", attributes: ["crying"], relationships: [] },
      ],
      beats: [{ panel: 1, actor: "Kiki", target: "Mori", interaction: "comforts", poseDetails: [], dialogueKind: "speech" }],
    });
    expect(plan.steps.some((s) => s.tool === "create_interaction")).toBe(true);
  });

  it("CASE F: 'leans against the wall, exhausted' — free pose wording, no enum failure", () => {
    const { plan } = compileRaw({
      ...BASE,
      beats: [
        { panel: 1, actor: "Kiki", action: "leaning against the wall", poseDetails: ["looking exhausted"], dialogueKind: "speech" },
      ],
    });
    const generation = plan.steps.find((s) => s.tool === "generate_character_asset" && s.args.kind === "pose");
    expect(String(generation?.args.instruction)).toContain("leaning against the wall");
    expect(String(generation?.args.instruction)).toContain("looking exhausted");
  });

  it("CASE G: 'lonely and oppressive' tone — free mood wording passes", () => {
    const { plan } = compileRaw({ ...BASE, beats: [], tone: { mood: "lonely and oppressive" } });
    expect(plan.steps.find((s) => s.tool === "apply_tone")?.args.mood).toBe("lonely and oppressive");
  });

  it("CASE H: 'uncomfortable, claustrophobic camera' — unknown words survive with warning", () => {
    const { plan, warnings } = compileRaw({
      ...BASE,
      beats: [],
      cameraIntent: { shot: "claustrophobic", lens: "uncomfortable" },
    });
    expect(plan.steps.some((s) => s.tool === "set_camera")).toBe(true);
    expect(warnings.join(" ")).toContain("claustrophobic");
    expect(warnings.join(" ")).toContain("uncomfortable");
  });

  it("CASE I: 'enters the classroom and sits beside Mori' — multiple actions in one beat, no enum squeeze", () => {
    const { plan } = compileRaw({
      ...BASE,
      participants: [
        BASE.participants[0],
        { name: "Mori", resolutionIntent: "create_if_missing", attributes: [], relationships: [] },
      ],
      beats: [
        {
          panel: 1,
          actor: "Kiki",
          action: "entering the classroom, sitting down",
          target: "Mori",
          interaction: "sit beside",
          poseDetails: [],
          dialogueKind: "speech",
        },
      ],
    });
    const interaction = plan.steps.find((s) => s.tool === "create_interaction");
    expect(interaction?.args.interaction).toBe("sit_together");
    const generation = plan.steps.find((s) => s.tool === "generate_character_asset" && s.args.kind === "pose");
    expect(String(generation?.args.instruction)).toContain("entering the classroom");
  });

  it("CASE J: participant.name = null is still a HARD failure", () => {
    const { map, error } = parseCreativeTaskMap({
      ...BASE,
      participants: [{ ...BASE.participants[0], name: null }],
    });
    expect(map).toBeUndefined();
    expect(error).toContain("participants[0].name");
  });

  it("anti-overfitting: unseen paraphrases survive via raw fallback, never enum death", () => {
    // Arrive family — none of these are editor enums; all must survive.
    for (const wording of ["arrives", "reaches", "gets to", "walks up to", "comes to"]) {
      const { plan } = compileRaw({
        ...BASE,
        beats: [{ panel: 1, actor: "Kiki", action: `${wording} the gate`, poseDetails: [], dialogueKind: "speech" }],
      });
      expect(plan.steps.some((s) => s.tool === "place_character")).toBe(true);
    }
    // Interaction paraphrases — mapped where a capability exists.
    expect(resolveInteraction("confronts")?.type).toBe("face_to_face");
    expect(resolveInteraction("reassures")?.type).toBe("hug");
    expect(resolveInteraction("checks on")?.type).toBe("look_at");
    // Truly unknown interaction: raw preserved, warning, no throw.
    const unknown = resolveInteraction("wordlessly reconciles with");
    expect(unknown?.type).toBeUndefined();
    expect(unknown?.raw).toBe("wordlessly reconciles with");
    expect(unknown?.warning).toBeDefined();
    // Delivery paraphrases.
    expect(resolveDialogueDelivery("yells").bubbleType).toBe("shout");
    expect(resolveDialogueDelivery("voiceover").bubbleType).toBe("narration");
    expect(resolveDialogueDelivery("sings").bubbleType).toBe("speech");
    expect(resolveDialogueDelivery("sings").warning).toBeDefined();
  });
});
