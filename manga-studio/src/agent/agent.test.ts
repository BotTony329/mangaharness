import { describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { buildAgentContext } from "./contextBuilder";
import { findCharacter, resolveCharacterAsset, resolveLibraryAsset } from "./resolver";
import { selectSkills } from "./skills/selector";
import { validatePlan, MAX_PLAN_STEPS } from "./tools/schemas";

// ─── Plan validation (never execute raw model output) ───────────────────────

describe("validatePlan", () => {
  it("accepts a well-formed plan", () => {
    const { plan, rejected } = validatePlan({
      summary: "Build a scene",
      steps: [
        { tool: "set_page_layout", args: { layout: "four-grid" } },
        { tool: "place_asset", args: { panel: 1, characterName: "Akari", cropMode: "fill" } },
        { tool: "add_speech_bubble", args: { panel: 1, bubbleType: "speech", text: "Hi!" } },
      ],
    });
    expect(plan.steps).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it("rejects unknown tools individually without killing the plan", () => {
    const { plan, rejected } = validatePlan({
      summary: "x",
      steps: [
        { tool: "delete_everything", args: {} },
        { tool: "run_shell_command", args: { cmd: "rm -rf /" } },
        { tool: "add_effect", args: { panel: 2, effectKind: "speed-lines" } },
      ],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBe("add_effect");
    expect(rejected).toHaveLength(2);
  });

  it("rejects malformed arguments (bounds, enums, lengths)", () => {
    const { plan, rejected } = validatePlan({
      summary: "x",
      steps: [
        { tool: "place_asset", args: { panel: 99 } }, // panel out of bounds
        { tool: "add_speech_bubble", args: { panel: 1, bubbleType: "scream", text: "hi" } }, // bad enum
        { tool: "add_speech_bubble", args: { panel: 1, bubbleType: "speech", text: "y".repeat(500) } }, // too long
      ],
    });
    expect(plan.steps).toHaveLength(0);
    expect(rejected).toHaveLength(3);
  });

  it("caps plan length", () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 5 }, () => ({
      tool: "add_effect",
      args: { panel: 1, effectKind: "screentone" },
    }));
    expect(() => validatePlan({ summary: "big", steps })).toThrow();
  });

  it("throws on garbage", () => {
    expect(() => validatePlan("not a plan")).toThrow();
    expect(() => validatePlan({ steps: "nope" })).toThrow();
  });
});

// ─── Skill selection ────────────────────────────────────────────────────────

describe("selectSkills", () => {
  it("always includes the composition skill", () => {
    const skills = selectSkills("do something");
    expect(skills.map((s) => s.id)).toContain("manga-composition");
  });

  it("picks yonkoma + dialogue skills for a gag strip request", () => {
    const ids = selectSkills("Create a funny four-panel manga where Ken confesses to Akari").map((s) => s.id);
    expect(ids).toContain("yonkoma");
    expect(ids).toContain("dialogue-layout");
  });

  it("picks the action skill for dramatic requests", () => {
    const ids = selectSkills("make this panel more dramatic with speed lines").map((s) => s.id);
    expect(ids).toContain("action-scene");
  });
});

// ─── Semantic asset resolution ──────────────────────────────────────────────

function libraryDoc() {
  let doc = createProjectDocument("Resolver");
  const akari = addCharacter(doc, "Akari");
  doc = akari.doc;
  const mk = (name: string, pose?: string, expression?: string) => {
    const added = addAsset(doc, {
      category: "character",
      name,
      storageUrl: `https://example.com/${name}.png`,
      width: 800,
      height: 1600,
      metadata: { characterId: akari.characterId, pose, expression },
    });
    doc = added.doc;
    return added.assetId;
  };
  const reference = mk("Akari reference");
  const running = mk("Akari running", "running", "neutral");
  const crying = mk("Akari crying", "standing", "crying");
  const bg = addAsset(doc, {
    category: "background",
    name: "Classroom A",
    storageUrl: "https://example.com/bg.png",
    width: 2000,
    height: 1400,
  });
  doc = bg.doc;
  return { doc, akariId: akari.characterId, reference, running, crying, bgId: bg.assetId };
}

describe("asset resolver", () => {
  it("finds characters case-insensitively and partially", () => {
    const { doc } = libraryDoc();
    expect(findCharacter(doc, "akari")?.name).toBe("Akari");
    expect(findCharacter(doc, "AKARI-chan")?.name).toBe("Akari");
    expect(findCharacter(doc, "Ken")).toBeNull();
  });

  it("prefers exact slot matches", () => {
    const { doc, running, crying } = libraryDoc();
    const character = findCharacter(doc, "Akari")!;
    expect(resolveCharacterAsset(doc, character, { pose: "running" })?.id).toBe(running);
    expect(resolveCharacterAsset(doc, character, { expression: "crying" })?.id).toBe(crying);
  });

  it("does not mislabel a compatible asset as an exact full-state match", () => {
    const { doc } = libraryDoc();
    const character = findCharacter(doc, "Akari")!;
    // A missing combination must generate instead of silently resetting pose.
    expect(resolveCharacterAsset(doc, character, { pose: "running", expression: "crying" })).toBeNull();
  });

  it("returns no match for unknown slots so the state resolver can generate them", () => {
    const { doc } = libraryDoc();
    const character = findCharacter(doc, "Akari")!;
    expect(resolveCharacterAsset(doc, character, { pose: "backflip" })).toBeNull();
  });

  it("resolves backgrounds by name fragment and category", () => {
    const { doc, bgId } = libraryDoc();
    expect(resolveLibraryAsset(doc, { assetName: "classroom" })?.id).toBe(bgId);
    expect(resolveLibraryAsset(doc, { category: "background" })?.id).toBe(bgId);
    expect(resolveLibraryAsset(doc, { assetName: "space station" })).toBeNull();
  });
});

// ─── Context builder ────────────────────────────────────────────────────────

describe("buildAgentContext", () => {
  it("includes the reusable inventory and page structure", () => {
    const { doc } = libraryDoc();
    const pageId = Object.keys(doc.pages)[0];
    const context = buildAgentContext({ doc, currentPageId: pageId, selection: {} });
    expect(context).toContain("Akari");
    expect(context).toContain("pose:running");
    expect(context).toContain("expression:crying");
    expect(context).toContain("Classroom A");
    expect(context).toContain("Panel 1:");
    expect(context).toContain("- empty");
  });

  it("marks the selection so contextual prompts can target it", () => {
    const { doc } = libraryDoc();
    const pageId = Object.keys(doc.pages)[0];
    const panelId = doc.pages[pageId].panelIds[2];
    const context = buildAgentContext({ doc, currentPageId: pageId, selection: { panelId } });
    expect(context).toContain("Panel 3:  [SELECTED]");
  });
});
