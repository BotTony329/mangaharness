/**
 * Repairing assets processed by an older pipeline.
 *
 * A pipeline fix only reaches images processed after it ships — the derivative
 * already in object storage keeps whatever bytes it was written with. These
 * pin the two properties that make a bulk rebuild safe to offer: it repairs,
 * and it cannot break an asset that currently works.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import type { ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { removeAssetBackground, repairAssetTransparency, repairableAssetIds } from "./clientProcessing";
import { assetRenderUrl } from "./renderSource";

function seed(): { doc: ProjectDocument; characterId: ID; assetIds: ID[] } {
  let doc = createProjectDocument("Repair");
  const character = addCharacter(doc, "友達");
  doc = character.doc;
  const assetIds: ID[] = [];
  for (const name of ["canonical", "walking", "shocked"]) {
    const added = addAsset(doc, {
      category: "character",
      name,
      storageUrl: `https://example.com/${name}-source.png`,
      processedImageUrl: `https://example.com/${name}-old.png`,
      width: 800,
      height: 1200,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      metadata: { characterId: character.characterId },
    });
    doc = added.doc;
    assetIds.push(added.assetId);
  }
  return { doc, characterId: character.characterId, assetIds };
}

const asset = (id: ID) => useEditorStore.getState().doc!.assets[id];

describe("transparency repair", () => {
  beforeEach(() => {
    const { doc } = seed();
    useEditorStore.getState().loadDocument(doc);
  });

  it("finds every render of a character, including archived-free props", () => {
    const { doc, characterId, assetIds } = seed();
    useEditorStore.getState().loadDocument(doc);
    expect(repairableAssetIds(characterId).sort()).toEqual([...assetIds].sort());
  });

  it("replaces the derivative and leaves the original source untouched", async () => {
    const { doc, assetIds } = seed();
    useEditorStore.getState().loadDocument(doc);
    const target = assetIds[0];
    const originalSource = asset(target).storageUrl;

    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          processedImageUrl: "https://example.com/rebuilt.png",
          hasAlpha: true,
          backgroundRemoved: true,
          processingStatus: "ready",
          backgroundRemovalMethod: "native-alpha+decontaminated",
        }),
      ),
    );

    await removeAssetBackground(target, { preserveOnFailure: true });

    expect(asset(target).processedImageUrl).toBe("https://example.com/rebuilt.png");
    expect(asset(target).storageUrl).toBe(originalSource);
    expect(assetRenderUrl(asset(target))).toBe("https://example.com/rebuilt.png");
    expect(asset(target).backgroundRemovalMethod).toContain("decontaminated");
  });

  it("a failed rebuild leaves a working asset exactly as it was", async () => {
    const { doc, assetIds } = seed();
    useEditorStore.getState().loadDocument(doc);
    const target = assetIds[0];
    const before = { ...asset(target) };

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "provider down" }), { status: 502 }));

    await expect(removeAssetBackground(target, { preserveOnFailure: true })).rejects.toThrow();

    // Still renderable — a repair attempt must never take a character off the page.
    expect(asset(target).processingStatus).toBe("ready");
    expect(asset(target).processedImageUrl).toBe(before.processedImageUrl);
    expect(assetRenderUrl(asset(target))).toBe(before.processedImageUrl);
  });

  it("without preservation a failure still marks the asset failed", async () => {
    const { doc, assetIds } = seed();
    useEditorStore.getState().loadDocument(doc);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }));

    await expect(removeAssetBackground(assetIds[0])).rejects.toThrow();
    expect(asset(assetIds[0]).processingStatus).toBe("failed");
    expect(assetRenderUrl(asset(assetIds[0]))).toBeUndefined();
  });

  it("rebuilds a whole character and reports progress", async () => {
    const { doc, characterId, assetIds } = seed();
    useEditorStore.getState().loadDocument(doc);
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      // One provider hiccup in the middle must not abort the batch.
      if (call === 2) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      return new Response(
        JSON.stringify({
          processedImageUrl: `https://example.com/rebuilt-${call}.png`,
          hasAlpha: true,
          backgroundRemoved: true,
          processingStatus: "ready",
        }),
      );
    });

    const seen: number[] = [];
    const result = await repairAssetTransparency(repairableAssetIds(characterId), (p) => seen.push(p.done));

    expect(result).toEqual({ done: 3, total: 3, failed: 1 });
    expect(seen).toEqual([1, 2, 3]);
    // The two that succeeded were rebuilt; the one that failed kept its old
    // derivative and is still renderable.
    const rebuilt = assetIds.map((id) => asset(id).processedImageUrl);
    expect(rebuilt.filter((url) => url?.includes("rebuilt"))).toHaveLength(2);
    expect(assetIds.every((id) => assetRenderUrl(asset(id)))).toBe(true);
  });
});
