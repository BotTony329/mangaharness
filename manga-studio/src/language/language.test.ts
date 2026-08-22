/**
 * Manga Language Library.
 *
 * The properties being locked in: structured assets stay editable rather than
 * becoming bitmaps, visual assets keep their transparency, attachment is a
 * document relationship rather than a UI convention, and the Agent cannot
 * spend a generation on something the library already holds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { resolvedBubbleStyle } from "@/domain/bubbleStyles";
import {
  addLanguageAsset,
  applyAttachments,
  attachItem,
  deleteLanguageAsset,
  detachItem,
  placeLanguageAsset,
  updateLanguageAsset,
} from "@/domain/languageOps";
import type { ID, ProjectDocument, SpeechBubbleItem } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan, type RunGuards } from "@/agent-v2";
import { groundPrompt } from "@/agent/grounding";
import { validateGroundedPlan } from "@/agent/planValidation";
import { validatePlan } from "@/agent/tools/schemas";
import { bestLanguageAsset, languageLibrary, searchLanguageAssets } from "./library";
import { BUILTIN_LANGUAGE_ASSETS } from "./builtins";

// ─── Fixture: §18's acceptance project ─────────────────────────────────────

interface Fixture {
  doc: ProjectDocument;
  yuri: ID;
  panelId: ID;
  sparkleLanguageId: ID;
}

function fixture(): Fixture {
  let doc = createProjectDocument("Manga FX");
  const yuri = addCharacter(doc, "Yuri", "black-haired high school girl");
  doc = yuri.doc;
  const yuriAsset = addAsset(doc, {
    category: "character",
    name: "Yuri walking",
    storageUrl: "https://example.com/yuri.png",
    processedImageUrl: "https://example.com/yuri-cut.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: {
      characterId: yuri.characterId,
      pose: "walking",
      expression: "neutral",
      outfit: "default outfit",
      view: "front",
      characterAssetRole: "state",
    },
  });
  doc = yuriAsset.doc;

  // An uploaded sparkle, exactly as §18 describes.
  const sparkleImage = addAsset(doc, {
    category: "upload",
    name: "sparkle",
    storageUrl: "https://example.com/sparkle.png",
    processedImageUrl: "https://example.com/sparkle-cut.png",
    width: 512,
    height: 512,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
  });
  doc = sparkleImage.doc;
  const sparkle = addLanguageAsset(doc, {
    category: "decorations",
    name: "My sparkle",
    source: "upload",
    format: "visual",
    assetId: sparkleImage.assetId,
    tags: ["sparkle", "shine", "custom"],
  });
  doc = sparkle.doc;

  const panelId = doc.pages[Object.keys(doc.pages)[0]].panelIds[0];
  const placedYuri = applyDomainCommand(doc, {
    type: "add-instance",
    panelId,
    assetId: yuriAsset.assetId,
  });
  doc = placedYuri.doc;

  return { doc, yuri: yuri.characterId, panelId, sparkleLanguageId: sparkle.languageAssetId };
}

function yuriInstanceId(doc: ProjectDocument, panelId: ID): ID {
  return doc.panels[panelId].itemIds.find((id) => doc.items[id]?.kind === "asset")!;
}

// ─── §1 / §15: the library model ───────────────────────────────────────────

describe("manga language library", () => {
  it("merges built-ins in at read time without storing them", () => {
    const { doc } = fixture();
    const library = languageLibrary(doc);
    expect(library.length).toBe(BUILTIN_LANGUAGE_ASSETS.length + 1);
    // Only the creator's own asset is in the document.
    expect(Object.keys(doc.language)).toHaveLength(1);
    expect(library.filter((asset) => asset.source === "builtin").length).toBe(BUILTIN_LANGUAGE_ASSETS.length);
  });

  it("covers every category with at least one built-in", () => {
    const { doc } = fixture();
    const categories = new Set(languageLibrary(doc).map((asset) => asset.category));
    for (const category of ["bubbles", "effects", "tones", "emotion", "sfx"] as const) {
      expect(categories.has(category), category).toBe(true);
    }
  });

  it("finds a shock effect by an everyday phrasing", () => {
    const { doc } = fixture();
    const hit = bestLanguageAsset(doc, { text: "shocked" });
    expect(hit?.name).toBe("Shock");
  });

  it("ranks an exact name match first, whoever made it", () => {
    const { doc } = fixture();
    expect(searchLanguageAssets(doc, { text: "sparkle" })[0].asset.name).toBe("Sparkle");
  });

  it("ranks a creator's own asset above a built-in at equal relevance", () => {
    const { doc } = fixture();
    // Both carry the "shine" tag and neither matches by name, so the tie-break
    // decides — and the asset the creator made for this project wins.
    const hits = searchLanguageAssets(doc, { text: "shine" });
    expect(hits[0].asset.name).toBe("My sparkle");
    expect(hits.some((hit) => hit.asset.name === "Sparkle")).toBe(true);
  });

  it("returns nothing when the library genuinely lacks an asset", () => {
    const { doc } = fixture();
    expect(bestLanguageAsset(doc, { text: "black ink smoke swirl" })).toBeNull();
  });

  it("never offers a visual asset whose image failed processing", () => {
    let { doc } = fixture();
    const broken = addAsset(doc, {
      category: "upload",
      name: "broken",
      storageUrl: "https://example.com/broken.png",
      width: 100,
      height: 100,
      processingStatus: "failed",
    });
    doc = broken.doc;
    doc = addLanguageAsset(doc, {
      category: "decorations",
      name: "Broken flower",
      source: "upload",
      format: "visual",
      assetId: broken.assetId,
      tags: ["flower"],
    }).doc;
    expect(bestLanguageAsset(doc, { text: "flower" })).toBeNull();
  });

  it("renames and deletes owned assets, and refuses to mutate built-ins", () => {
    const { doc, sparkleLanguageId } = fixture();
    const renamed = updateLanguageAsset(doc, sparkleLanguageId, { name: "Star burst", tags: ["stars"] });
    expect(renamed.language[sparkleLanguageId].name).toBe("Star burst");
    expect(renamed.language[sparkleLanguageId].tags).toEqual(["stars"]);

    const deleted = deleteLanguageAsset(renamed, sparkleLanguageId);
    expect(deleted.language[sparkleLanguageId]).toBeUndefined();

    expect(() => deleteLanguageAsset(doc, "builtin:fx-emotion-shock")).toThrow(/cannot be edited or deleted/);
  });

  it("survives a save/load round trip", () => {
    const { doc, sparkleLanguageId } = fixture();
    const restored = deserializeProject(serializeProject(doc));
    expect(restored.language[sparkleLanguageId].name).toBe("My sparkle");
    expect(restored.language[sparkleLanguageId].tags).toEqual(["sparkle", "shine", "custom"]);
  });

  it("migrates a v10 document by adding an empty library, not built-in clutter", () => {
    const { doc } = fixture();
    const legacy = JSON.parse(serializeProject(doc)) as Record<string, unknown>;
    legacy.schemaVersion = 10;
    delete legacy.language;
    const restored = deserializeProject(JSON.stringify(legacy));
    expect(restored.language).toEqual({});
    // Built-ins still appear, because they are code.
    expect(languageLibrary(restored).length).toBe(BUILTIN_LANGUAGE_ASSETS.length);
  });
});

// ─── §2 / §7 / §8: structured stays editable ───────────────────────────────

describe("structured language assets", () => {
  it("places a built-in bubble as an editable object, not a bitmap", () => {
    const { doc, panelId } = fixture();
    const { doc: next, itemId } = placeLanguageAsset(doc, {
      panelId,
      languageAssetId: "builtin:bubble-horror",
      text: "…something is here",
    });
    const item = next.items[itemId] as SpeechBubbleItem;
    expect(item.kind).toBe("bubble");
    expect(item.bubbleType).toBe("horror");
    expect(item.text).toBe("…something is here");
    // Appearance is parameters. Nothing was rendered or generated.
    const style = resolvedBubbleStyle(item);
    expect(style.shape).toBe("wavy");
    expect(style.borderStyle).toBe("rough");
  });

  it("keeps text editable after a style change, and restyles on a type change", () => {
    const { doc, panelId } = fixture();
    const placed = placeLanguageAsset(doc, { panelId, languageAssetId: "builtin:bubble-speech", text: "Hi" });
    const styled = applyDomainCommand(placed.doc, {
      type: "update-bubble",
      itemId: placed.itemId,
      patch: { style: { borderWeight: 8 } },
    });
    expect(resolvedBubbleStyle(styled.doc.items[placed.itemId] as SpeechBubbleItem).borderWeight).toBe(8);
    expect((styled.doc.items[placed.itemId] as SpeechBubbleItem).text).toBe("Hi");

    const retyped = applyDomainCommand(styled.doc, {
      type: "update-bubble",
      itemId: placed.itemId,
      patch: { bubbleType: "shout" },
    });
    const item = retyped.doc.items[placed.itemId] as SpeechBubbleItem;
    expect(item.text).toBe("Hi");
    expect(resolvedBubbleStyle(item).shape).toBe("spiky");
  });

  it("places SFX as editable text with no balloon and no tail (§14)", () => {
    const { doc, panelId } = fixture();
    const { doc: next, itemId } = placeLanguageAsset(doc, { panelId, languageAssetId: "builtin:sfx-bam" });
    const item = next.items[itemId] as SpeechBubbleItem;
    expect(item.text).toBe("BAM");
    expect(item.tail).toBeUndefined();
    const style = resolvedBubbleStyle(item);
    expect(style.shape).toBe("none");
    expect(style.outlineWidth).toBeGreaterThan(0);
  });

  it("places a built-in effect preset with its own parameters", () => {
    const { doc, panelId } = fixture();
    const { doc: next, itemId } = placeLanguageAsset(doc, { panelId, languageAssetId: "builtin:fx-speed-radial" });
    const item = next.items[itemId];
    expect(item.kind).toBe("effect");
    expect(item.kind === "effect" && item.effectKind).toBe("focus-lines");
    expect(item.kind === "effect" && item.languageAssetId).toBe("builtin:fx-speed-radial");
  });

  it("places a visual asset as an ordinary instance that keeps its transparency", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const { doc: next, itemId } = placeLanguageAsset(doc, { panelId, languageAssetId: sparkleLanguageId });
    const item = next.items[itemId];
    expect(item.kind).toBe("asset");
    const source = next.assets[(item as { sourceAssetId: ID }).sourceAssetId];
    expect(source.hasAlpha).toBe(true);
    expect(source.processedImageUrl).toBe("https://example.com/sparkle-cut.png");
  });
});

// ─── §11: attachment ───────────────────────────────────────────────────────

describe("effect attachment", () => {
  it("makes an attached effect follow the character it belongs to", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, {
      panelId,
      languageAssetId: sparkleLanguageId,
      attachToItemId: yuriItem,
    });
    const before = placed.doc.items[placed.itemId];
    const offsetX = before.cx - placed.doc.items[yuriItem].cx;

    const moved = applyDomainCommand(placed.doc, {
      type: "update-instance-transform",
      instanceId: yuriItem,
      patch: { cx: placed.doc.items[yuriItem].cx + 200, cy: placed.doc.items[yuriItem].cy - 90 },
    });
    const after = moved.doc.items[placed.itemId];
    expect(after.cx).toBeCloseTo(before.cx + 200, 4);
    expect(after.cy).toBeCloseTo(before.cy - 90, 4);
    // The relationship, not the absolute position, is what was preserved.
    expect(after.cx - moved.doc.items[yuriItem].cx).toBeCloseTo(offsetX, 4);
  });

  it("leaves a detached effect in panel space", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, {
      panelId,
      languageAssetId: sparkleLanguageId,
      attachToItemId: yuriItem,
    });
    const detached = detachItem(placed.doc, placed.itemId);
    const before = detached.items[placed.itemId];

    const moved = applyDomainCommand(detached, {
      type: "update-instance-transform",
      instanceId: yuriItem,
      patch: { cx: detached.items[yuriItem].cx + 300 },
    });
    expect(moved.doc.items[placed.itemId].cx).toBe(before.cx);
  });

  it("scales an attached effect when the subject is resized", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, { panelId, languageAssetId: sparkleLanguageId, attachToItemId: yuriItem });
    const beforeWidth = placed.doc.items[placed.itemId].width;

    const resized = applyDomainCommand(placed.doc, {
      type: "update-instance-transform",
      instanceId: yuriItem,
      patch: { height: placed.doc.items[yuriItem].height * 2 },
    });
    expect(resized.doc.items[placed.itemId].width).toBeCloseTo(beforeWidth * 2, 4);
  });

  it("releases the attachment when the subject is deleted rather than snapping to origin", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, { panelId, languageAssetId: sparkleLanguageId, attachToItemId: yuriItem });
    const at = { x: placed.doc.items[placed.itemId].cx, y: placed.doc.items[placed.itemId].cy };

    const removed = applyDomainCommand(placed.doc, { type: "delete-instance", instanceId: yuriItem });
    const survivor = removed.doc.items[placed.itemId];
    expect(survivor.attachment).toBeUndefined();
    expect(survivor.cx).toBe(at.x);
    expect(survivor.cy).toBe(at.y);
  });

  it("refuses to attach across panels or to itself", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, { panelId, languageAssetId: sparkleLanguageId });
    expect(() => attachItem(placed.doc, placed.itemId, placed.itemId)).toThrow(/cannot attach to itself/);

    const otherPanel = placed.doc.pages[Object.keys(placed.doc.pages)[0]].panelIds[1];
    const elsewhere = placeLanguageAsset(placed.doc, { panelId: otherPanel, languageAssetId: sparkleLanguageId });
    expect(() => attachItem(elsewhere.doc, elsewhere.itemId, yuriItem)).toThrow(/same panel/);
  });

  it("is idempotent when nothing moved", () => {
    const { doc, panelId, sparkleLanguageId } = fixture();
    const yuriItem = yuriInstanceId(doc, panelId);
    const placed = placeLanguageAsset(doc, { panelId, languageAssetId: sparkleLanguageId, attachToItemId: yuriItem });
    const once = applyAttachments(placed.doc, panelId);
    const twice = applyAttachments(once, panelId);
    expect(twice.items[placed.itemId].cx).toBeCloseTo(once.items[placed.itemId].cx, 6);
    expect(twice.items[placed.itemId].width).toBeCloseTo(once.items[placed.itemId].width, 6);
  });
});

// ─── §12 / §13 / §18: agent behaviour ──────────────────────────────────────

let generationCalls: string[] = [];

const DENY: RunGuards = { creationAuthorized: false, authorizedCreationNames: [] };

function planFor(steps: { tool: string; args: Record<string, unknown> }[]) {
  return validatePlan({ summary: "test", steps }).plan;
}

describe("agent manga-language behaviour", () => {
  beforeEach(() => {
    generationCalls = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        generationCalls.push(url);
        throw new Error(`Unexpected image generation: ${url}`);
      }
      return new Response(JSON.stringify({ capabilities: { referenceImage: false } }));
    });
  });

  it('C. "Add a shocked manga effect around Yuri" reuses the built-in and generates nothing', async () => {
    const { doc, panelId } = fixture();
    useEditorStore.getState().loadDocument(doc);
    const yuriItem = yuriInstanceId(doc, panelId);

    const summary = await executePlan(
      planFor([
        { tool: "place_manga_effect", args: { panel: 1, query: "shocked", category: "emotion", targetCharacterName: "Yuri" } },
      ]),
      () => {},
      DENY,
    );

    expect(summary.failed).toBe(0);
    expect(generationCalls).toHaveLength(0);

    const after = useEditorStore.getState().doc!;
    const placed = after.panels[panelId].itemIds
      .map((id) => after.items[id])
      .find((item) => item.kind === "effect");
    expect(placed?.kind === "effect" && placed.languageAssetId).toBe("builtin:fx-emotion-shock");
    // "around Yuri" is a relationship, not just a position.
    expect(placed?.attachment?.targetItemId).toBe(yuriItem);
  });

  it("D. an unmatched request is not silently reused as something else", () => {
    const { doc } = fixture();
    useEditorStore.getState().loadDocument(doc);
    expect(bestLanguageAsset(doc, { text: "black ink smoke swirl", category: "decorations" })).toBeNull();
  });

  it("rejects a generation the library can already satisfy, before it runs", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Add a shocked manga effect around Yuri." });
    const result = validateGroundedPlan({
      plan: planFor([
        {
          tool: "generate_manga_effect",
          args: { description: "shocked manga symbol", category: "emotion", panel: 1 },
        },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps).toHaveLength(0);
    expect(result.rejected[0].error).toContain("already has");
    expect(generationCalls).toHaveLength(0);
  });

  it("allows a generation the library genuinely cannot satisfy", () => {
    const { doc } = fixture();
    const grounding = groundPrompt({ doc, prompt: "Add a unique black ink smoke swirl behind Yuri." });
    const result = validateGroundedPlan({
      plan: planFor([
        {
          tool: "generate_manga_effect",
          args: { description: "black ink smoke swirl", category: "decorations", panel: 1, targetCharacterName: "Yuri" },
        },
      ]),
      doc,
      grounding,
      panelCount: 4,
    });
    expect(result.plan.steps).toHaveLength(1);
    // Character grounding still applies to effect placement.
    expect(result.plan.steps[0].args.targetCharacterId).toBeDefined();
  });

  it("respects the selected-panel scope", async () => {
    const { doc } = fixture();
    useEditorStore.getState().loadDocument(doc);
    const page = doc.pages[Object.keys(doc.pages)[0]];
    const grounding = groundPrompt({ doc, prompt: "Add sparkles." });
    const result = validateGroundedPlan({
      plan: planFor([
        { tool: "place_manga_effect", args: { panel: 1, query: "sparkle" } },
        { tool: "place_manga_effect", args: { panel: 3, query: "sparkle" } },
      ]),
      doc,
      grounding,
      scope: {
        kind: "selected-panel",
        pageId: page.id,
        pageName: page.name,
        panelCount: page.panelIds.length,
        panelId: page.panelIds[0],
        panelNumber: 1,
        label: "Selected Panel · Panel 1",
      },
      panelCount: page.panelIds.length,
    });
    expect(result.plan.steps).toHaveLength(1);
    expect(result.rejected[0].error).toContain("Scope violation");
  });

  it("reports the placed effect in the run log without generating", async () => {
    const { doc } = fixture();
    useEditorStore.getState().loadDocument(doc);
    const details: (string | undefined)[] = [];
    await executePlan(
      planFor([{ tool: "place_manga_effect", args: { panel: 1, query: "speed lines" } }]),
      (_index, status, detail) => {
        if (status === "done") details.push(detail);
      },
      DENY,
    );
    expect(details[0]).toMatch(/^Reused /);
    expect(generationCalls).toHaveLength(0);
  });

  it("undoes a whole language run as one step", async () => {
    const { doc, panelId } = fixture();
    useEditorStore.getState().loadDocument(doc);
    const before = useEditorStore.getState().doc!.panels[panelId].itemIds.length;

    await executePlan(
      planFor([
        { tool: "place_manga_effect", args: { panel: 1, query: "speed lines" } },
        { tool: "place_manga_effect", args: { panel: 1, query: "screentone dot" } },
      ]),
      () => {},
      DENY,
    );
    expect(useEditorStore.getState().doc!.panels[panelId].itemIds.length).toBe(before + 2);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc!.panels[panelId].itemIds.length).toBe(before);
  });
});
