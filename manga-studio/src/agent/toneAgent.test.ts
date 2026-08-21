/**
 * The Agent reaches for tone the way a creator does — and through the same
 * commands. "Make this panel feel gloomy" must produce an ordinary tone layer
 * the creator can then edit, reorder, hide and delete, not a special
 * Agent-owned thing and never a change baked into the artwork.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ID, ProjectDocument, ToneItem } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { toneForMood } from "@/tones/mood";
import { TONE_PRESETS } from "@/domain/tones";
import { executePlan } from "./executor";
import { validatePlan } from "./tools/schemas";

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

function studio(): { pageId: ID; panelIds: ID[]; yuri: ID } {
  let doc: ProjectDocument = createProjectDocument("Tone agent");
  const yuri = addCharacter(doc, "Yuri", "quiet second-year");
  doc = yuri.doc;
  const art = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/yuri.png",
    processedImageUrl: "https://example.com/yuri-alpha.png",
    width: 900,
    height: 1400,
    metadata: { characterId: yuri.characterId, pose: "standing", expression: "neutral", outfit: "uniform", view: "front" },
  });
  doc = art.doc;

  useEditorStore.getState().loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "two-vertical" });
  const panelIds = useEditorStore.getState().doc!.pages[pageId].panelIds;
  useEditorStore.getState().dispatch({ type: "add-instance", panelId: panelIds[0], assetId: art.assetId });
  return { pageId, panelIds, yuri: yuri.characterId };
}

async function run(steps: { tool: string; args: Record<string, unknown> }[]) {
  const { plan } = validatePlan({ summary: "tone", steps });
  expect(plan).toBeDefined();
  return executePlan(plan!, () => {}, { creationAuthorized: false, authorizedCreationNames: [] });
}

function tones(): ToneItem[] {
  const doc = useEditorStore.getState().doc!;
  return Object.values(doc.items).filter((item): item is ToneItem => item.kind === "tone");
}

beforeEach(() => {
  vi.stubGlobal("Image", MockImage as unknown as typeof Image);
  useEditorStore.setState({ doc: null, undoStack: [], redoStack: [] } as never);
});

describe("mood becomes a real tone", () => {
  it("understands the words creators actually use", () => {
    expect(toneForMood("make this panel feel gloomy")?.family).toBe("dark-mood");
    expect(toneForMood("she is panicking")?.id).toBe("anxiety-hatch");
    expect(toneForMood("a romantic moment")?.family).toBeDefined();
    expect(toneForMood("add speed lines")?.id).toBe("speed-diagonal");
  });

  it("says so rather than guessing when nothing matches", () => {
    expect(toneForMood("a bowl of soup")).toBeUndefined();
    expect(toneForMood(undefined)).toBeUndefined();
  });

  it("'make this panel feel gloomy' lays a Dark Mood tone", async () => {
    const { panelIds } = studio();
    const before = JSON.stringify(useEditorStore.getState().doc!.assets);

    const summary = await run([{ tool: "apply_tone", args: { panel: 1, mood: "make this panel feel gloomy" } }]);
    expect(summary.failed).toBe(0);

    const [tone] = tones();
    expect(tone).toBeDefined();
    expect(tone.panelId).toBe(panelIds[0]);
    expect(tone.tone.source === "procedural" && tone.tone.presetId).toBe("gloom");
    // The artwork it shades is untouched.
    expect(JSON.stringify(useEditorStore.getState().doc!.assets)).toBe(before);
  });
});

describe("the Agent uses the creator's own editor", () => {
  it("produces a layer that is editable and removable like any other", async () => {
    studio();
    await run([{ tool: "apply_tone", args: { panel: 1, presetId: "dot-30", opacity: 0.5 } }]);
    const [tone] = tones();
    expect(tone.opacity).toBeCloseTo(0.5, 5);

    // Edited through the ordinary command, not an Agent-only path.
    useEditorStore.getState().dispatch({ type: "update-tone", itemId: tone.id, patch: { params: { density: 0.7 } } });
    const edited = tones()[0];
    expect(edited.tone.source === "procedural" && edited.tone.params.density).toBeCloseTo(0.7, 5);

    useEditorStore.getState().dispatch({ type: "delete-instance", instanceId: tone.id });
    expect(tones()).toHaveLength(0);
  });

  it("confines the tone to a named character when asked", async () => {
    studio();
    await run([{ tool: "apply_tone", args: { panel: 1, presetId: "dot-30", maskToCharacterName: "Yuri" } }]);
    const [tone] = tones();
    // A resolvable region: where Yuri actually stands.
    expect(tone.mask?.shapes).toHaveLength(1);
    const shape = tone.mask!.shapes[0];
    expect(shape.kind).toBe("rect");
    if (shape.kind === "rect") {
      expect(shape.width).toBeGreaterThan(0);
      expect(shape.height).toBeGreaterThan(0);
    }
  });

  it("refuses a tone it cannot identify rather than applying a random one", async () => {
    studio();
    const summary = await run([{ tool: "apply_tone", args: { panel: 1, mood: "a bowl of soup" } }]);
    expect(summary.failed).toBe(1);
    expect(tones()).toHaveLength(0);
  });

  it("one undo removes the whole tone run", async () => {
    const { panelIds } = studio();
    const before = useEditorStore.getState().doc!.panels[panelIds[0]].itemIds.length;
    await run([{ tool: "apply_tone", args: { panel: 1, presetId: "dot-30" } }]);
    expect(tones()).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc!.panels[panelIds[0]].itemIds).toHaveLength(before);
  });
});

/**
 * A tool the runtime accepts but the model is never told about is a tool that
 * does not exist. `apply_tone` was exactly that for one commit — registered in
 * the schema, absent from the documentation the planner actually reads — which
 * is the same shape as the "CHARACTER CREATION: FORBIDDEN" failure.
 */
describe("every tool the runtime accepts is documented to the planner", () => {
  it("documents apply_tone, with the presets it may name", async () => {
    const { TOOL_DOCS } = await import("./tools/schemas");
    expect(TOOL_DOCS).toContain("apply_tone");
    expect(TOOL_DOCS).toContain("gloom");
    expect(TOOL_DOCS).toContain("maskToCharacterName");
    // The property that makes tone safe for an agent to reach for at all.
    expect(TOOL_DOCS).toContain("NON-DESTRUCTIVE");
  });

  it("leaves no tool undocumented", async () => {
    const { TOOL_DOCS, toolSchemas } = await import("./tools/schemas");
    // Derived from the schema itself, so the next tool added cannot slip
    // through the same gap apply_tone did.
    const undocumented = Object.keys(toolSchemas).filter((name) => !TOOL_DOCS.includes(name));
    expect(undocumented).toEqual([]);
  });

  it("names only presets that actually exist", async () => {
    const { TOOL_DOCS } = await import("./tools/schemas");
    const line = TOOL_DOCS.slice(TOOL_DOCS.indexOf("apply_tone")).split("\n")[0];
    // The explicit run of ids between "dot-10/20/30/40/50" and "otherwise".
    const listed = line.slice(line.indexOf("dot-10"), line.indexOf("otherwise"));
    const advertised = (listed.match(/\b[a-z]+-[a-z]+\b/g) ?? []).filter((id) => id !== "built-in");
    const unknown = advertised.filter((id) => !TONE_PRESETS.some((preset) => preset.id === id));
    expect(unknown).toEqual([]);
    // And the shorthand really does cover the numbered dot presets.
    for (const id of ["dot-10", "dot-20", "dot-30", "dot-40", "dot-50"]) {
      expect(TONE_PRESETS.some((preset) => preset.id === id)).toBe(true);
    }
  });
});
