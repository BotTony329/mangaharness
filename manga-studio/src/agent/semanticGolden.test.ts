/**
 * Semantic Integrity golden cases — the P0 production failure and its proofs.
 *
 * The failure: "A cute Japanese high school girl called Kiki, walking, face
 * to the camera, towards to school on a little Kyoto style street" produced
 * characters "Japanese" and "Kyoto", lost Kiki, and never recognised the
 * street as a scene. Everything downstream faithfully executed a wrong
 * meaning.
 *
 * These tests pin the CONTRACT, not the incident: no place name, nationality,
 * or test string appears in the implementation — the rules are structural
 * (explicit naming structures, location prepositions, attribute binding), so
 * CASE 2 ("a villain named Kyoto") proving Kyoto CAN be a character is the
 * anti-hardcode proof.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addCharacter } from "@/domain/libraryOps";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { extractLiteralEvidence } from "./literalEvidence";
import { detectCreationIntent, groundPrompt } from "./grounding";
import { validatePlanSemantics } from "./semanticValidation";
import { validateGroundedPlan } from "./planValidation";
import { validatePlan, type AgentPlan } from "./tools/schemas";

const P0 = "A cute Japanese high school girl called Kiki, walking, face to the camera, towards to school on a little Kyoto style street";

function freshProject(): ProjectDocument {
  const doc = createProjectDocument("Semantic golden");
  useEditorStore.getState().loadDocument(doc);
  return doc;
}

/** What a wrong-meaning LLM actually returned in production. */
function planCreating(names: string[]): AgentPlan {
  return validatePlan(
    {
      summary: "wrong-meaning plan",
      steps: names.map((name) => ({ tool: "create_character", args: { name } })),
    },
    undefined,
  ).plan;
}

beforeEach(() => {
  freshProject();
});

describe("CASE P0: Kiki — explicit naming beats every other reading", () => {
  it("extracts Kiki as the ONLY explicit name, with the descriptors bound as attributes", () => {
    const evidence = extractLiteralEvidence(P0);
    expect(evidence.explicitNames.map((entry) => entry.name)).toEqual(["Kiki"]);
    const bound = evidence.explicitNames[0].attributes.join(" ");
    expect(bound).toMatch(/cute/i);
    expect(bound).toMatch(/japanese/i);
    expect(bound).toMatch(/high school girl/i);
  });

  it("reads Kyoto as scene/location evidence, never as a name", () => {
    const evidence = extractLiteralEvidence(P0);
    expect(evidence.explicitNameSet.has("kyoto")).toBe(false);
    expect(evidence.locationSet.has("kyoto")).toBe(true);
  });

  it("explicit naming alone authorizes creating Kiki (no creation verb in the prompt)", () => {
    const creation = detectCreationIntent(P0);
    expect(creation.allowed).toBe(true);
    expect(creation.requestedNames).toEqual(["Kiki"]);
  });

  it("grounding resolves Kiki as CREATE and invents no other entity", () => {
    const report = groundPrompt({ doc: useEditorStore.getState().doc!, prompt: P0 });
    const names = report.entities.map((entity) => entity.surface);
    expect(names).toContain("Kiki");
    expect(names).not.toContain("Japanese");
    expect(names).not.toContain("Kyoto");
    expect(report.blocking).toEqual([]);
  });

  it("semantic validation BLOCKS the production plan that created Japanese/Kyoto/School/Girl", () => {
    const doc = useEditorStore.getState().doc!;
    const grounding = groundPrompt({ doc, prompt: P0 });
    const plan = planCreating(["Japanese", "Kyoto", "School", "Girl"]);
    const violations = validatePlanSemantics({
      prompt: P0,
      plan,
      grounding,
      authorizedNames: ["Kiki"],
      projectCharacters: [],
    });
    const blockedNames = violations.map((v) => v.message);
    expect(violations.length).toBe(4);
    expect(blockedNames.join("\n")).toMatch(/Japanese/);
    expect(blockedNames.join("\n")).toMatch(/Kyoto/);
    expect(violations.every((v) => v.rule !== "explicit-name-preservation")).toBe(true);

    const validated = validateGroundedPlan({ plan, doc, grounding, prompt: P0 });
    expect(validated.blocked).toBe(true);
    expect(validated.plan.steps).toHaveLength(0);
  });

  it("a plan creating Kiki — and only Kiki — passes", () => {
    const doc = useEditorStore.getState().doc!;
    const grounding = groundPrompt({ doc, prompt: P0 });
    const plan = planCreating(["Kiki"]);
    const validated = validateGroundedPlan({ plan, doc, grounding, prompt: P0 });
    expect(validated.blocked).toBe(false);
    expect(validated.plan.steps).toHaveLength(1);
  });
});

describe("CASE 2: 'A villain named Kyoto attacks Kiki' — location protection is not hardcode", () => {
  const PROMPT = "A villain named Kyoto attacks Kiki.";

  it("explicit naming makes Kyoto a legitimate character", () => {
    const evidence = extractLiteralEvidence(PROMPT);
    expect(evidence.explicitNameSet.has("kyoto")).toBe(true);
    const doc = useEditorStore.getState().doc!;
    const grounding = groundPrompt({ doc, prompt: PROMPT });
    const plan = planCreating(["Kyoto", "Kiki"]);
    const validated = validateGroundedPlan({ plan, doc, grounding, prompt: PROMPT });
    expect(validated.blocked).toBe(false);
    expect(validated.plan.steps.map((s) => s.args.name)).toEqual(["Kyoto", "Kiki"]);
  });
});

describe("CASE 3: 'Kiki arrives in Kyoto' — same word, place reading", () => {
  it("Kyoto is a location, not a character", () => {
    const PROMPT = "Kiki arrives in Kyoto.";
    const evidence = extractLiteralEvidence(PROMPT);
    expect(evidence.explicitNameSet.has("kyoto")).toBe(false);
    expect(evidence.locationSet.has("kyoto")).toBe(true);

    const doc = useEditorStore.getState().doc!;
    const grounding = groundPrompt({ doc, prompt: PROMPT });
    const violations = validatePlanSemantics({
      prompt: PROMPT,
      plan: planCreating(["Kyoto"]),
      grounding,
      authorizedNames: [],
      projectCharacters: [],
    });
    expect(violations.map((v) => v.rule)).toEqual(["location-protection"]);
  });
});

describe("CASE 4: 'A Japanese girl named Mori meets Kiki in Melbourne'", () => {
  it("Mori CREATE, Kiki EXISTING, Japanese attribute, Melbourne location", () => {
    const PROMPT = "A Japanese girl named Mori meets Kiki in Melbourne.";
    const evidence = extractLiteralEvidence(PROMPT);
    expect(evidence.explicitNames.map((e) => e.name)).toEqual(["Mori"]);
    expect(evidence.explicitNames[0].attributes.join(" ")).toMatch(/japanese/i);
    expect(evidence.locationSet.has("melbourne")).toBe(true);

    // Kiki already in the library → EXISTING, never recreated.
    let doc = freshProject();
    const kiki = addCharacter(doc, "Kiki", "a high school girl");
    doc = kiki.doc;
    useEditorStore.getState().loadDocument(doc);
    const grounding = groundPrompt({ doc, prompt: PROMPT });
    const kikiEntity = grounding.entities.find((e) => e.surface === "Kiki");
    expect(kikiEntity?.status).toBe("resolved");
    expect(kikiEntity?.characterId).toBe(kiki.characterId);
    expect(grounding.entities.map((e) => e.surface)).not.toContain("Melbourne");
    expect(grounding.entities.map((e) => e.surface)).not.toContain("Japanese");
  });
});

describe("CASE 5: 'Yuri hugs her sister' — UNRESOLVED blocks, nothing is invented", () => {
  it("no sister on record means the run does not start", () => {
    let doc = freshProject();
    const yuri = addCharacter(doc, "Yuri", "quiet second-year");
    doc = yuri.doc;
    useEditorStore.getState().loadDocument(doc);
    const grounding = groundPrompt({ doc, prompt: "Yuri hugs her sister." });
    expect(grounding.blocking.length).toBeGreaterThan(0);
    expect(grounding.entities.map((e) => e.surface)).not.toContain("Sister");
  });
});

describe("CASE 6: apposition is one participant, never two", () => {
  it("'his rival, the villain Roachman' validates as a single identity", () => {
    const PROMPT = "Supermate fights his rival, the villain Roachman.";
    const doc = useEditorStore.getState().doc!;
    const grounding = groundPrompt({ doc, prompt: PROMPT });
    const roachmen = grounding.entities.filter((e) => /roachman/i.test(e.surface));
    expect(roachmen).toHaveLength(1);

    // The model saying the same name twice as both participants is caught.
    const plan = validatePlan(
      {
        summary: "fight",
        steps: [
          {
            tool: "create_interaction",
            args: {
              panel: 1,
              interaction: "face_to_face",
              subjectCharacterName: "Roachman",
              targetCharacterName: "Roachman",
            },
          },
        ],
      },
      undefined,
    ).plan;
    const violations = validatePlanSemantics({
      prompt: PROMPT,
      plan,
      grounding,
      authorizedNames: ["Supermate", "Roachman"],
      projectCharacters: [],
    });
    expect(violations.map((v) => v.rule)).toContain("duplicate-participant");
  });
});

describe("CASE 7: compound pose is never downgraded", () => {
  it("'back to the viewer, half-crouching, head turned over shoulder' keeps its full visual state", () => {
    const PROMPT =
      "Kiki has her back toward the viewer, half-crouches, turns her head over her shoulder and looks toward the camera.";
    let doc = freshProject();
    const kiki = addCharacter(doc, "Kiki", "a high school girl");
    doc = kiki.doc;
    useEditorStore.getState().loadDocument(doc);
    const grounding = groundPrompt({ doc, prompt: PROMPT });
    const kikiEntity = grounding.entities.find((e) => e.surface === "Kiki");
    expect(kikiEntity?.status).toBe("resolved");
    // The pose vocabulary must not collapse the compound state into "standing".
    const serialized = JSON.stringify(grounding.entities);
    expect(serialized).not.toMatch(/"standing"/);
  });
});
