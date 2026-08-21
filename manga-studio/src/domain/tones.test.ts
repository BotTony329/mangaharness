/**
 * The tone system's two load-bearing promises.
 *
 * 1. A tone NEVER changes what is underneath. Not when added, not when edited,
 *    not when masked, not when deleted. This is the whole reason tone is a
 *    layer rather than a filter, so it is tested against the actual bytes.
 * 2. "Dot 30%" means thirty percent ink. The presets are named after real
 *    coverage, so the arithmetic that produces a dot radius has to hold.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "./commands";
import { createProjectDocument } from "./factory";
import { addAsset } from "./libraryOps";
import { dotRadiusFor, spacingFor } from "@/render/tonePainter";
import { moireRisk, normalizeToneParams, TONE_PRESETS, tonePreset } from "./tones";
import { describeTone } from "./toneDescribe";
import { hitTestItem } from "@/canvas/hitStack";
import type { ID, ProjectDocument, ToneItem } from "./types";

function page(): { doc: ProjectDocument; panelId: ID; assetId: ID } {
  let doc = createProjectDocument("Tone test");
  const art = addAsset(doc, {
    category: "character",
    name: "Yuri standing",
    storageUrl: "https://example.com/yuri.png",
    processedImageUrl: "https://example.com/yuri-alpha.png",
    width: 900,
    height: 1400,
  });
  doc = art.doc;
  const pageId = Object.values(doc.pages)[0].id;
  doc = applyDomainCommand(doc, { type: "set-page-layout", pageId, layout: "two-vertical" }).doc;
  const panelId = doc.pages[pageId].panelIds[0];
  doc = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: art.assetId }).doc;
  return { doc, panelId, assetId: art.assetId };
}

/** Everything a creator would notice about the artwork, ignoring tone layers. */
function artworkFingerprint(doc: ProjectDocument): string {
  const items = Object.values(doc.items)
    .filter((item) => item.kind !== "tone")
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ items, assets: doc.assets });
}

describe("tone is non-destructive", () => {
  it("adding, editing, masking and deleting never touch the artwork", () => {
    const { doc, panelId } = page();
    const before = artworkFingerprint(doc);

    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const toneId = added.createdId!;
    expect(artworkFingerprint(added.doc)).toBe(before);

    const edited = applyDomainCommand(added.doc, {
      type: "update-tone",
      itemId: toneId,
      patch: { params: { density: 0.6 }, opacity: 0.4 },
    });
    expect(artworkFingerprint(edited.doc)).toBe(before);

    const masked = applyDomainCommand(edited.doc, {
      type: "update-tone",
      itemId: toneId,
      patch: { mask: { shapes: [{ kind: "rect", x: 0.2, y: 0.2, width: 0.3, height: 0.4 }] } },
    });
    expect(artworkFingerprint(masked.doc)).toBe(before);

    const removed = applyDomainCommand(masked.doc, { type: "delete-instance", instanceId: toneId });
    // Deleting the tone leaves the page exactly as it started.
    expect(artworkFingerprint(removed.doc)).toBe(before);
    expect(Object.values(removed.doc.items).some((item) => item.kind === "tone")).toBe(false);
  });

  it("hiding a tone is reversible and changes nothing else", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const toneId = added.createdId!;
    const withTone = JSON.stringify(added.doc.items[toneId]);

    const hidden = applyDomainCommand(added.doc, { type: "set-instance-props", instanceId: toneId, patch: { visible: false } });
    expect((hidden.doc.items[toneId] as ToneItem).visible).toBe(false);
    expect(artworkFingerprint(hidden.doc)).toBe(artworkFingerprint(added.doc));

    const shown = applyDomainCommand(hidden.doc, { type: "set-instance-props", instanceId: toneId, patch: { visible: true } });
    // Returns unchanged — not "similar", the same tone with the same dials.
    expect(JSON.stringify({ ...(shown.doc.items[toneId] as ToneItem), visible: undefined }))
      .toBe(JSON.stringify({ ...JSON.parse(withTone), visible: undefined }));
  });

  it("sits above the artwork and below the lettering", () => {
    const { doc, panelId } = page();
    const withBubble = applyDomainCommand(doc, { type: "add-bubble", panelId, bubbleType: "speech", text: "Hi" });
    const added = applyDomainCommand(withBubble.doc, { type: "add-tone", panelId, presetId: "dot-30" });

    const order = added.doc.panels[panelId].itemIds.map((id) => added.doc.items[id].kind);
    expect(order.indexOf("tone")).toBeGreaterThan(order.indexOf("asset"));
    // Toning over the dialogue would grey out the words.
    expect(order.indexOf("tone")).toBeLessThan(order.indexOf("bubble"));
  });
});

describe("procedural tones are real patterns, not labels", () => {
  it("Dot 30% covers thirty percent of the area", () => {
    const preset = tonePreset("dot-30")!;
    const spacing = spacingFor(preset.params.frequency);
    const radius = dotRadiusFor(spacing, preset.params.density);
    // One dot per grid cell: coverage is dot area over cell area.
    const coverage = (Math.PI * radius * radius) / (spacing * spacing);
    expect(coverage).toBeCloseTo(0.3, 5);
  });

  it("every dot preset's name matches its coverage", () => {
    for (const preset of TONE_PRESETS.filter((p) => /^Dot \d+%$/.test(p.name))) {
      const declared = Number(preset.name.match(/(\d+)/)![1]) / 100;
      const spacing = spacingFor(preset.params.frequency);
      const radius = dotRadiusFor(spacing, preset.params.density);
      expect((Math.PI * radius * radius) / (spacing * spacing)).toBeCloseTo(declared, 5);
    }
  });

  it("frequency changes pattern size, not coverage", () => {
    const coarse = spacingFor(12);
    const fine = spacingFor(52);
    expect(fine).toBeLessThan(coarse);
    const coverage = (s: number) => (Math.PI * dotRadiusFor(s, 0.3) ** 2) / (s * s);
    // A finer tone is not a darker tone.
    expect(coverage(fine)).toBeCloseTo(coverage(coarse), 5);
  });

  it("clamps nonsense from an older or newer document instead of throwing", () => {
    const params = normalizeToneParams({ type: "spiral", density: 9, frequency: -4, angle: 900 });
    expect(params.type).toBe("dot");
    expect(params.density).toBe(1);
    expect(params.frequency).toBeGreaterThanOrEqual(6);
    expect(params.angle).toBeGreaterThanOrEqual(0);
    expect(params.angle).toBeLessThan(180);
  });
});

describe("naming", () => {
  it("calls a preset by its name until it is edited", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const toneId = added.createdId!;
    expect(describeTone(added.doc, added.doc.items[toneId] as ToneItem)).toBe("Dot 30%");

    const edited = applyDomainCommand(added.doc, { type: "update-tone", itemId: toneId, patch: { params: { density: 0.55 } } });
    // Still calling it "Dot 30%" would make the Layers panel lie.
    expect(describeTone(edited.doc, edited.doc.items[toneId] as ToneItem)).toBe("Dots 55%");
  });
});

describe("moire", () => {
  it("warns about two different dot grids at nearly the same angle", () => {
    expect(moireRisk({ type: "dot", density: 0.3, frequency: 26, angle: 45 }, { type: "dot", density: 0.3, frequency: 34, angle: 48 })).toBe(true);
  });

  it("stays quiet when the grids are properly separated", () => {
    expect(moireRisk({ type: "dot", density: 0.3, frequency: 26, angle: 15 }, { type: "dot", density: 0.3, frequency: 34, angle: 75 })).toBe(false);
  });

  it("does not warn about stacking the identical tone", () => {
    const same = { type: "dot" as const, density: 0.3, frequency: 26, angle: 45 };
    // Two 30% screens on top of each other is a darker tone, not moiré.
    expect(moireRisk(same, same)).toBe(false);
  });
});

describe("masking is a stored region, not a change to the pixels", () => {
  it("the tone is clickable only where it was painted", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const masked = applyDomainCommand(added.doc, {
      type: "update-tone",
      itemId: added.createdId!,
      // The left quarter only — think "the shirt".
      patch: { mask: { shapes: [{ kind: "rect", x: 0, y: 0, width: 0.25, height: 1 }] } },
    });
    const tone = masked.doc.items[added.createdId!] as ToneItem;

    const at = (fx: number, fy: number) => ({
      x: tone.cx - tone.width / 2 + tone.width * fx,
      y: tone.cy - tone.height / 2 + tone.height * fy,
    });
    expect(hitTestItem(masked.doc, tone, at(0.1, 0.5)).hit).toBe(true);
    // Outside the mask the tone is not there, so clicks reach the art beneath.
    expect(hitTestItem(masked.doc, tone, at(0.8, 0.5)).hit).toBe(false);
  });

  it("invert flips which side is toned", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const masked = applyDomainCommand(added.doc, {
      type: "update-tone",
      itemId: added.createdId!,
      patch: { mask: { shapes: [{ kind: "rect", x: 0, y: 0, width: 0.25, height: 1 }] }, invert: true },
    });
    const tone = masked.doc.items[added.createdId!] as ToneItem;
    const at = (fx: number) => ({
      x: tone.cx - tone.width / 2 + tone.width * fx,
      y: tone.cy,
    });
    expect(hitTestItem(masked.doc, tone, at(0.1)).hit).toBe(false);
    expect(hitTestItem(masked.doc, tone, at(0.8)).hit).toBe(true);
  });

  it("a brush stroke masks along its path", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const masked = applyDomainCommand(added.doc, {
      type: "update-tone",
      itemId: added.createdId!,
      patch: { mask: { shapes: [{ kind: "stroke", radius: 0.08, points: [0.2, 0.2, 0.5, 0.5] }] } },
    });
    const tone = masked.doc.items[added.createdId!] as ToneItem;
    const at = (fx: number, fy: number) => ({
      x: tone.cx - tone.width / 2 + tone.width * fx,
      y: tone.cy - tone.height / 2 + tone.height * fy,
    });
    expect(hitTestItem(masked.doc, tone, at(0.2, 0.2)).hit).toBe(true);
    expect(hitTestItem(masked.doc, tone, at(0.9, 0.9)).hit).toBe(false);
  });

  it("clearing the mask returns the tone to the whole panel", () => {
    const { doc, panelId } = page();
    const added = applyDomainCommand(doc, { type: "add-tone", panelId, presetId: "dot-30" });
    const masked = applyDomainCommand(added.doc, {
      type: "update-tone",
      itemId: added.createdId!,
      patch: { mask: { shapes: [{ kind: "rect", x: 0, y: 0, width: 0.25, height: 1 }] } },
    });
    const cleared = applyDomainCommand(masked.doc, {
      type: "update-tone",
      itemId: added.createdId!,
      patch: { mask: null },
    });
    expect((cleared.doc.items[added.createdId!] as ToneItem).mask).toBeUndefined();
  });
});
