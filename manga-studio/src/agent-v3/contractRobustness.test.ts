/**
 * Golden: CREATIVE TASK MAP CONTRACT ROBUSTNESS.
 *
 * The boundary is Raw → normalizeCreativeTaskMap → single canonical schema.
 * Normalization repairs STRUCTURE only (null/empty optional fields, stray
 * null array entries); it never guesses semantics. Required fields stay
 * strict, and validation errors name the exact field path.
 */

import { describe, expect, it } from "vitest";
import { normalizeCreativeTaskMap, parseCreativeTaskMap } from "./contract/creativeTaskMap";

const BASE = {
  version: 1,
  summary: "Kiki cries in the classroom",
  intent: "new_scene",
  participants: [
    { name: "Kiki", resolutionIntent: "create_if_missing", attributes: ["Japanese", "school girl"], relationships: [] },
  ],
  scene: { description: "a school classroom" },
  objects: [],
  beats: [
    { panel: 1, actor: "Kiki", action: "getting her test result, crying", poseDetails: [], dialogueKind: "speech" },
  ],
  effects: [],
  localEdits: [],
  target: { scope: "current_page" },
};

describe("contract robustness: Raw → Normalize → Validate", () => {
  it("CASE A: optional field = null normalizes to absent and passes", () => {
    const raw = { ...BASE, beats: [{ ...BASE.beats[0], dialogue: null, expression: null }], cameraIntent: null, tone: null };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(error).toBeUndefined();
    expect(map).toBeDefined();
    expect(map!.beats[0].dialogue).toBeUndefined();
    expect(map!.cameraIntent).toBeUndefined();
  });

  it("CASE B: optional empty string normalizes to absent and passes", () => {
    const raw = { ...BASE, beats: [{ ...BASE.beats[0], expression: "", action: " crying " }] };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(error).toBeUndefined();
    expect(map!.beats[0].expression).toBeUndefined();
    // Strings are trimmed, not reinterpreted.
    expect(map!.beats[0].action).toBe("crying");
  });

  it("CASE C: required field = null still fails, with the exact field path", () => {
    const raw = { ...BASE, participants: [{ ...BASE.participants[0], name: null }] };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(map).toBeUndefined();
    expect(error).toContain("participants[0].name");
  });

  it("CASE D: unknown debug/reasoning fields are stripped, consistently", () => {
    const raw = { ...BASE, reasoning: "the user wants sadness", debug: { confidence: 0.9 } };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(error).toBeUndefined();
    expect(map).toBeDefined();
    expect(JSON.stringify(map)).not.toContain("reasoning");
    expect(JSON.stringify(map)).not.toContain("confidence");
  });

  it("CASE E: the live Kiki prompt shape survives optional nulls with semantics intact", () => {
    // Simulated Creative Director output for:
    // "When kiki, a japanese school girl, get her test result she cried in the class room"
    const raw = {
      ...BASE,
      cameraIntent: null,
      clarificationNeeded: null,
      beats: [{ ...BASE.beats[0], dialogue: null, expression: "crying", target: null, interaction: null }],
      scene: { description: "a school classroom", reuseExisting: null },
    };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(error).toBeUndefined();
    // Semantics are the model's, untouched by normalization.
    expect(map!.participants[0].name).toBe("Kiki");
    expect(map!.participants[0].attributes).toEqual(["Japanese", "school girl"]);
    expect(map!.scene?.description).toBe("a school classroom");
    expect(map!.beats[0].action).toContain("test result");
    expect(map!.beats[0].expression).toBe("crying");
    expect(map!.clarificationNeeded).toBeUndefined();
  });

  it("null entries inside optional arrays are removed, not validated", () => {
    const raw = { ...BASE, participants: [null, BASE.participants[0]], beats: [BASE.beats[0], null] };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(error).toBeUndefined();
    expect(map!.participants).toHaveLength(1);
    expect(map!.beats).toHaveLength(1);
  });

  it("normalization never invents semantics: malformed content still fails", () => {
    const raw = { ...BASE, intent: "definitely_not_an_intent" };
    const { map, error } = parseCreativeTaskMap(raw);
    expect(map).toBeUndefined();
    expect(error).toContain("intent");
  });

  it("normalizeCreativeTaskMap is structural: identity on already-clean input", () => {
    expect(normalizeCreativeTaskMap(BASE)).toEqual(BASE);
  });
});
