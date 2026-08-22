/**
 * Golden: AGENT V3 — LLM Creative Director → Creative Task Map → deterministic
 * harness. These tests feed FIXED Task Map fixtures (the LLM is stubbed by
 * construction) through resolution → compile → execute → verify, so the whole
 * harness is tested deterministically with no model involved.
 *
 * CASE 1–10 pin the architecture red lines: names-only refs, upstream camera,
 * reuse over generate, scope isolation, rollback honesty, byte-exact dialogue.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import type { CommandResult, DomainCommand } from "@/domain/commands";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { literalLock } from "./contract/literalLock";
import { parseCreativeTaskMap, type CreativeTaskMap } from "./contract/creativeTaskMap";
import { resolveTaskMap } from "./resolution/entityResolver";
import { compileTaskMap, creationAuthorization } from "./routing/capabilityRouter";
import { panelScopeFingerprints, verifyTaskMap } from "./verification/deterministicVerifier";

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

function generatedImageResponse(name: string) {
  return new Response(
    JSON.stringify({
      url: `https://example.com/${name}.png`,
      sourceUrl: `https://example.com/${name}.png`,
      processedImageUrl: `https://example.com/${name}-alpha.png`,
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

let generations = 0;
let failOnGeneration = -1;

beforeEach(() => {
  useEditorStore.getState().loadDocument(createProjectDocument("V3 golden"));
  const pageId = Object.values(useEditorStore.getState().doc!.pages)[0].id;
  useEditorStore.getState().dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });
  generations = 0;
  failOnGeneration = -1;
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/generate") || url.includes("/api/assets/edit")) {
      const index = generations++;
      if (index === failOnGeneration) return new Response("boom", { status: 500 });
      return generatedImageResponse(`gen-${index}`);
    }
    return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
  });
});

function taskMap(raw: unknown): CreativeTaskMap {
  const { map, error } = parseCreativeTaskMap(raw);
  if (!map) throw new Error(`fixture invalid: ${error}`);
  return map;
}

async function runMap(raw: unknown) {
  const before = useEditorStore.getState().doc!;
  const pageId = useEditorStore.getState().currentPageId;
  const map = taskMap(raw);
  const resolution = resolveTaskMap(map, before);
  const { plan } = compileTaskMap(map, resolution);
  const names = creationAuthorization(resolution);
  const fingerprints = panelScopeFingerprints(before);
  const summary = await executePlan(plan, () => {}, {
    creationAuthorized: names.length > 0,
    authorizedCreationNames: names,
  });
  const after = useEditorStore.getState().doc!;
  const verification = verifyTaskMap(map, resolution, before, after, fingerprints, pageId);
  return { map, resolution, plan, summary, verification, after };
}

/** Pre-seed a character through the real creation path (they now exist). */
async function seedCharacter(name: string, appearance: string) {
  await executePlan(
    {
      summary: `seed ${name}`,
      steps: [
        { tool: "create_character", args: { name, appearance } },
        { tool: "generate_character_asset", args: { characterName: name, kind: "reference" } },
      ],
    },
    () => {},
    { creationAuthorized: true, authorizedCreationNames: [name.toLowerCase()] },
  );
}

const MOMO_SCENE = {
  version: 1,
  summary: "Momo walks and shouts",
  intent: "new_scene",
  participants: [
    { name: "Momo", resolutionIntent: "create_if_missing", attributes: ["a girl"], relationships: [] },
  ],
  scene: { description: "rainy Shanghai-style street at night" },
  objects: [],
  beats: [
    {
      panel: 1,
      actor: "Momo",
      action: "walking toward the camera",
      poseDetails: [],
      dialogue: "Wait!",
      dialogueKind: "shout",
    },
  ],
  effects: [],
  localEdits: [],
  target: { scope: "current_page" },
};

describe("golden V3: Creative Task Map → deterministic harness", () => {
  it("CASE 1: new character + new scene + exact dialogue lands and verifies clean", async () => {
    const { summary, verification, after } = await runMap(MOMO_SCENE);
    expect(summary.status).toBe("completed");
    expect(summary.rolledBack).toBe(false);
    expect(verification.issues).toEqual([]);

    const momo = Object.values(after.characters).find((c) => c.name === "Momo");
    expect(momo).toBeDefined();
    const pageId = Object.values(after.pages)[0].id;
    const panel = after.panels[after.pages[pageId].panelIds[0]];
    const items = panel.itemIds.map((id) => after.items[id]);
    expect(
      items.some((i) => i?.kind === "asset" && after.assets[i.sourceAssetId]?.metadata?.characterId === momo!.id),
    ).toBe(true);
    expect(items.some((i) => i?.kind === "bubble" && i.text === "Wait!")).toBe(true);
  });

  it("CASE 2: an existing participant is reused — no create step, no duplicate", async () => {
    await seedCharacter("Akari", "a girl with short hair");
    const before = useEditorStore.getState().doc!;
    const akariId = Object.values(before.characters).find((c) => c.name === "Akari")!.id;

    const { plan, summary, after, resolution } = await runMap({
      ...MOMO_SCENE,
      summary: "Akari waves",
      scene: undefined,
      participants: [{ name: "Akari", resolutionIntent: "existing", attributes: [], relationships: [] }],
      beats: [{ panel: 2, actor: "Akari", action: "waving", poseDetails: [], dialogueKind: "speech" }],
    });
    expect(resolution.participants.get("Akari")?.characterId).toBe(akariId);
    expect(plan.steps.some((s) => s.tool === "create_character")).toBe(false);
    expect(summary.status).toBe("completed");
    expect(Object.values(after.characters).filter((c) => c.name === "Akari")).toHaveLength(1);
  });

  it("CASE 3: dialogue-only intent generates nothing", async () => {
    await seedCharacter("Akari", "a girl");
    await runMap({
      version: 1,
      summary: "Akari in panel 1",
      intent: "new_scene",
      participants: [{ name: "Akari", resolutionIntent: "existing", attributes: [], relationships: [] }],
      beats: [{ panel: 1, actor: "Akari", poseDetails: [], dialogueKind: "speech" }],
      objects: [],
      effects: [],
      localEdits: [],
      target: { scope: "current_page" },
    });

    const { plan, summary, verification } = await runMap({
      version: 1,
      summary: "Akari says hi",
      intent: "dialogue_only",
      participants: [{ name: "Akari", resolutionIntent: "existing", attributes: [], relationships: [] }],
      beats: [{ panel: 1, actor: "Akari", poseDetails: [], dialogue: "Hi there.", dialogueKind: "speech" }],
      objects: [],
      effects: [],
      localEdits: [],
      target: { scope: "current_page" },
    });
    expect(plan.steps.filter((s) => s.tool.startsWith("generate_"))).toEqual([]);
    expect(summary.status).toBe("completed");
    expect(verification.issues).toEqual([]);
  });

  it("CASE 4: an interaction beat compiles to a coordinated interaction, addressed by name", async () => {
    await seedCharacter("Akari", "a girl");
    const { plan } = await runMap({
      version: 1,
      summary: "Momo hugs Akari",
      intent: "new_scene",
      participants: [
        { name: "Momo", resolutionIntent: "create_if_missing", attributes: ["a girl"], relationships: [] },
        { name: "Akari", resolutionIntent: "existing", attributes: [], relationships: [] },
      ],
      beats: [
        { panel: 1, actor: "Momo", poseDetails: [], target: "Akari", interaction: "hug", dialogueKind: "speech" },
      ],
      objects: [],
      effects: [],
      localEdits: [],
      target: { scope: "current_page" },
    });
    const interaction = plan.steps.find((s) => s.tool === "create_interaction");
    expect(interaction).toBeDefined();
    expect(interaction!.args.subjectCharacterName).toBe("Momo");
    expect(interaction!.args.targetCharacterName).toBe("Akari");
    expect(JSON.stringify(interaction!.args)).not.toMatch(/char_|_placeholder/i);
  });

  it("CASE 5: a redrawn camera reaches GENERATION upstream — never a post-hoc enlarge", async () => {
    const { plan } = await runMap({
      ...MOMO_SCENE,
      scene: undefined,
      cameraIntent: { shot: "full", angle: "low", dramaticIntent: "heroic tension", requiresRedraw: true },
    });
    const poseGeneration = plan.steps.find(
      (s) => s.tool === "generate_character_asset" && s.args.kind === "pose",
    );
    expect(String(poseGeneration?.args.instruction)).toContain("low");
    expect(String(poseGeneration?.args.instruction)).toContain("heroic tension");
    expect(plan.steps.some((s) => s.tool === "set_camera")).toBe(true);
  });

  it("CASE 6: no new state needed → no generation step is emitted for the actor", async () => {
    await seedCharacter("Akari", "a girl");
    const { plan } = await runMap({
      version: 1,
      summary: "Place Akari",
      intent: "continue_scene",
      participants: [{ name: "Akari", resolutionIntent: "existing", attributes: [], relationships: [] }],
      beats: [{ panel: 1, actor: "Akari", poseDetails: [], dialogueKind: "speech" }],
      objects: [],
      effects: [],
      localEdits: [],
      target: { scope: "current_page" },
    });
    expect(plan.steps.some((s) => s.tool === "generate_character_asset")).toBe(false);
  });

  it("CASE 7: a missing 'existing' participant blocks resolution — nothing is invented", async () => {
    const doc = useEditorStore.getState().doc!;
    const map = taskMap({
      ...MOMO_SCENE,
      participants: [{ name: "Ghost", resolutionIntent: "existing", attributes: [], relationships: [] }],
      beats: [{ panel: 1, actor: "Ghost", poseDetails: [], dialogueKind: "speech" }],
    });
    const resolution = resolveTaskMap(map, doc);
    expect(resolution.unresolved).toContain("Ghost");
  });

  it("CASE 8: panels outside the target scope are byte-for-byte untouched", async () => {
    const before = useEditorStore.getState().doc!;
    const pageId = Object.values(before.pages)[0].id;
    const otherPanels = before.pages[pageId].panelIds.slice(1);

    const { summary, after } = await runMap(MOMO_SCENE);
    expect(summary.status).toBe("completed");
    for (const panelId of otherPanels) {
      expect(JSON.stringify({ panel: after.panels[panelId], items: after.panels[panelId].itemIds.map((id) => after.items[id]) })).toBe(
        JSON.stringify({ panel: before.panels[panelId], items: before.panels[panelId].itemIds.map((id) => before.items[id]) }),
      );
    }
  });

  it("CASE 9: no command, asset or step ever carries a placeholder or invented ID", async () => {
    const commandLog: string[] = [];
    const store = useEditorStore.getState();
    const originalDispatch = store.dispatch;
    useEditorStore.setState({
      dispatch: (command: DomainCommand): CommandResult => {
        commandLog.push(JSON.stringify(command));
        return originalDispatch(command);
      },
    });
    try {
      const { plan, summary, after } = await runMap(MOMO_SCENE);
      expect(summary.status).toBe("completed");
      const idLike = /new_|tmp_|semantic_|_placeholder/i;
      expect(commandLog.join("\n")).not.toMatch(idLike);
      expect(JSON.stringify(plan.steps.map((s) => s.args))).not.toMatch(idLike);
      expect(JSON.stringify(Object.values(after.assets).map((a) => a.metadata))).not.toMatch(idLike);
    } finally {
      useEditorStore.setState({ dispatch: originalDispatch });
    }
  });

  it("CASE 10: a failed generation rolls the page back and says what survived", async () => {
    const before = useEditorStore.getState().doc!;
    failOnGeneration = 1; // the scene generation after the character reference succeeds
    const { summary, after } = await runMap(MOMO_SCENE);
    expect(summary.status).toBe("failed");
    expect(summary.rolledBack).toBe(true);
    /**
     * Preserved-asset honesty: anything the failed run left in the library
     * must be NAMED in preservedAssets — never "nothing changed" while the
     * library quietly grew. (If nothing survived, the list is legitimately
     * empty.)
     */
    const survivors = Object.values(after.assets).filter((a) => !before.assets[a.id]);
    for (const survivor of survivors) {
      expect(summary.preservedAssets).toContain(survivor.name);
    }
    const pageId = Object.values(after.pages)[0].id;
    expect(after.pages[pageId].panelIds.every((id) => after.panels[id].itemIds.length === 0)).toBe(true);
  });
});

describe("golden V3: Literal Lock is phrasing-independent", () => {
  it("paraphrases of the same request extract the same immutable evidence", () => {
    const doc = useEditorStore.getState().doc!;
    const phrasings = [
      'A girl named Momo walks over and shouts "Wait!"',
      'Create a girl called Momo. She walks over, shouting "Wait!"',
      'Momo — a new girl — walks over. She shouts: "Wait!"',
    ];
    const locks = phrasings.map((prompt) => literalLock({ prompt, doc }));
    // Quoted dialogue is byte-identical evidence regardless of phrasing.
    for (const lock of locks) {
      expect(lock.quotedDialogue).toEqual(["Wait!"]);
    }
    // Explicit naming evidence appears exactly where a naming marker exists
    // ("named"/"called"); the third phrasing has none and must invent none.
    expect(locks[0].explicitNames.map((n) => n.toLowerCase())).toContain("momo");
    expect(locks[1].explicitNames.map((n) => n.toLowerCase())).toContain("momo");
    expect(locks[2].explicitNames).toEqual([]);
  });
});
