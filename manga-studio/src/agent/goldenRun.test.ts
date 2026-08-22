/**
 * The golden regression: an Agent run must not damage finished work.
 *
 * This encodes the production failure that prompted it — a run asked to add an
 * interaction destroyed an already-composed manga page and still reported
 * success. The assertions are deliberately unforgiving: panels the request did
 * not name must come back BYTE-IDENTICAL, not "visually similar" or "mostly
 * unchanged". Anything less and the check would pass through the exact bug it
 * exists to catch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { charactersInAsset } from "@/domain/interactions";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent-v2";
import { resolveAgentScope } from "./scope";
import { validatePlan } from "./tools/schemas";
import { groundPrompt } from "./grounding";
import { validateGroundedPlan } from "./planValidation";

const PROMPT = "Yuri and Mori hug and they both smile happily.";

interface Fixture {
  yuri: ID;
  mori: ID;
  pageId: ID;
  panelIds: ID[];
}

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

function characterAsset(doc: ProjectDocument, characterId: ID, name: string, pose: string) {
  return addAsset(doc, {
    category: "character",
    name,
    storageUrl: `https://example.com/${name.replace(/\s+/g, "-").toLowerCase()}.png`,
    processedImageUrl: `https://example.com/${name.replace(/\s+/g, "-").toLowerCase()}-alpha.png`,
    width: 900,
    height: 1400,
    metadata: {
      characterId,
      pose,
      expression: "neutral",
      outfit: "school uniform",
      view: "front",
      characterAssetRole: "state",
    },
  });
}

/**
 * A page that looks like real work: four panels, each with a background, a
 * placed character, dialogue and an effect. A test that starts from an empty
 * page cannot detect destruction, because there is nothing to destroy.
 */
function composedPage(): Fixture {
  let doc = createProjectDocument("Golden page");
  const yuri = addCharacter(doc, "Yuri", "quiet second-year");
  doc = yuri.doc;
  const mori = addCharacter(doc, "Mori", "her childhood friend");
  doc = mori.doc;

  const yuriStanding = characterAsset(doc, yuri.characterId, "Yuri standing", "standing");
  doc = yuriStanding.doc;
  const moriStanding = characterAsset(doc, mori.characterId, "Mori standing", "standing");
  doc = moriStanding.doc;
  const background = addAsset(doc, {
    category: "background",
    name: "Rooftop",
    storageUrl: "https://example.com/rooftop.png",
    width: 2000,
    height: 1400,
  });
  doc = background.doc;

  const store = useEditorStore.getState();
  store.loadDocument(doc);
  const pageId = Object.values(doc.pages)[0].id;
  store.dispatch({ type: "set-page-layout", pageId, layout: "four-grid" });

  const panelIds = useEditorStore.getState().doc!.pages[pageId].panelIds;
  panelIds.forEach((panelId, index) => {
    const state = useEditorStore.getState();
    state.dispatch({ type: "add-instance", panelId, assetId: background.assetId });
    state.dispatch({
      type: "add-instance",
      panelId,
      assetId: index % 2 === 0 ? yuriStanding.assetId : moriStanding.assetId,
    });
    state.dispatch({ type: "add-bubble", panelId, bubbleType: "speech", text: `Line ${index + 1}` });
    state.dispatch({ type: "add-effect", panelId, effectKind: "speed-lines" });
  });
  // Panel 4 is where the hug happens: both characters are already standing there.
  const finale = panelIds[3];
  useEditorStore.getState().dispatch({ type: "add-instance", panelId: finale, assetId: yuriStanding.assetId });

  return { yuri: yuri.characterId, mori: mori.characterId, pageId, panelIds };
}

/** Everything about a panel that a creator would notice changing. */
function fingerprint(doc: ProjectDocument, panelId: ID): string {
  const panel = doc.panels[panelId];
  return JSON.stringify({ panel, items: panel.itemIds.map((id) => doc.items[id]) });
}

function jointRenderResponse() {
  return new Response(
    JSON.stringify({
      url: "https://example.com/yuri-mori-hug.png",
      sourceUrl: "https://example.com/yuri-mori-hug.png",
      processedImageUrl: "https://example.com/yuri-mori-hug-alpha.png",
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

function hugPlan(fixture: Fixture) {
  const state = useEditorStore.getState();
  const doc = state.doc!;
  const scope = resolveAgentScope({
    doc,
    currentPageId: fixture.pageId,
    selection: { panelId: fixture.panelIds[3] },
    prompt: PROMPT,
  });
  const grounding = groundPrompt({ doc, prompt: PROMPT });
  const { plan } = validatePlan(
    {
      summary: "Yuri and Mori hug",
      steps: [
        {
          tool: "create_interaction",
          args: {
            panel: 4,
            interaction: "hug",
            subjectCharacterName: "Yuri",
            targetCharacterName: "Mori",
            expressions: { Yuri: "smiling happily", Mori: "smiling happily" },
          },
        },
      ],
    },
    scope,
  );
  return validateGroundedPlan({ plan, doc, grounding, scope, panelCount: scope.panelCount });
}

describe("golden run: an interaction never destroys the page", () => {
  let fixture: Fixture;
  let before: ProjectDocument;
  let generationBodies: string[];
  let historyDepth: number;

  beforeEach(() => {
    fixture = composedPage();
    before = useEditorStore.getState().doc!;
    historyDepth = useEditorStore.getState().past.length;
    generationBodies = [];
    vi.stubGlobal("Image", MockImage);
  });

  function stubProvider(respond: () => Response | Promise<Response>) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        generationBodies.push(String(init?.body ?? ""));
        return respond();
      }
      return new Response(JSON.stringify({ capabilities: { referenceImage: true } }));
    });
  }

  it("draws the hug once, with both identities, and leaves every other panel byte-identical", async () => {
    stubProvider(() => jointRenderResponse());
    const untouched = fixture.panelIds.slice(0, 3).map((id) => fingerprint(before, id));

    const validated = hugPlan(fixture);
    expect(validated.blocked).toBe(false);
    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });

    expect(summary.failed).toBe(0);
    expect(summary.rolledBack).toBe(false);
    expect(summary.validationIssues.filter((issue) => issue.severity === "fatal")).toEqual([]);

    const after = useEditorStore.getState().doc!;

    // 1. The panels the request never mentioned are exactly as they were.
    fixture.panelIds.slice(0, 3).forEach((panelId, index) => {
      expect(fingerprint(after, panelId)).toBe(untouched[index]);
    });

    // 2. One joint render, not two separate poses pretending to be a hug.
    expect(generationBodies).toHaveLength(1);
    const request = JSON.parse(generationBodies[0]);
    expect(request.referenceUrls).toHaveLength(2);
    expect(new Set(request.referenceUrls).size).toBe(2);
    expect(String(request.prompt).toLowerCase()).toContain("smiling happily");

    // 3. Both characters are in the panel, inside one image that knows it.
    const finale = fixture.panelIds[3];
    const present = new Set(
      after.panels[finale].itemIds.flatMap((itemId) => {
        const item = after.items[itemId];
        return item?.kind === "asset" ? charactersInAsset(after, item.sourceAssetId) : [];
      }),
    );
    expect(present.has(fixture.yuri)).toBe(true);
    expect(present.has(fixture.mori)).toBe(true);

    // 4. Nobody new was invented along the way.
    expect(Object.keys(after.characters).sort()).toEqual(Object.keys(before.characters).sort());

    // 5. The dialogue and effects already in the finale panel survived.
    const survivingKinds = after.panels[finale].itemIds.map((id) => after.items[id]?.kind);
    expect(survivingKinds).toContain("bubble");
    expect(survivingKinds).toContain("effect");
  });

  it("reuses the cached hug instead of paying for it twice", async () => {
    stubProvider(() => jointRenderResponse());
    const first = hugPlan(fixture);
    await executePlan(first.plan, () => {}, {
      creationAuthorized: first.creationAuthorized,
      authorizedCreationNames: first.authorizedCreationNames,
    });
    expect(generationBodies).toHaveLength(1);

    const second = hugPlan(fixture);
    const summary = await executePlan(second.plan, () => {}, {
      creationAuthorized: second.creationAuthorized,
      authorizedCreationNames: second.authorizedCreationNames,
    });

    expect(summary.rolledBack).toBe(false);
    expect(generationBodies).toHaveLength(1);
  });

  it("restores the whole page when the provider fails", async () => {
    stubProvider(() => new Response(JSON.stringify({ error: "provider unavailable" }), { status: 502 }));
    const fingerprints = fixture.panelIds.map((id) => fingerprint(before, id));

    const validated = hugPlan(fixture);
    const summary = await executePlan(validated.plan, () => {}, {
      creationAuthorized: validated.creationAuthorized,
      authorizedCreationNames: validated.authorizedCreationNames,
    });

    expect(summary.rolledBack).toBe(true);
    expect(summary.abortReason).toBeTruthy();

    const after = useEditorStore.getState().doc!;
    // Every panel, including the target: a failed hug leaves no trace on the page.
    fixture.panelIds.forEach((panelId, index) => {
      expect(fingerprint(after, panelId)).toBe(fingerprints[index]);
    });
    expect(Object.keys(after.interactions ?? {})).toEqual(Object.keys(before.interactions ?? {}));

    /**
     * A rolled-back run must not eat the undo stack either: the creator's last
     * manual action is still what one Undo takes back.
     */
    expect(useEditorStore.getState().past.length).toBe(historyDepth);
  });
});
