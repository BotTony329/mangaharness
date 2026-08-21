import { describe, expect, it } from "vitest";
import type { SourceAsset } from "@/domain/types";
import { assetPreviewUrl, assetRenderUrl, isAssetReadyForComposition } from "./renderSource";

const legacyAsset = {
  id: "asset-1",
  projectId: "project-1",
  category: "character",
  type: "character-visual",
  name: "Yuri",
  storageUrl: "https://example.com/yuri-source.jpg",
  sourceUrl: "https://example.com/yuri-source.jpg",
  status: "ready",
  width: 100,
  height: 200,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
} satisfies SourceAsset;

describe("asset render source", () => {
  it("keeps old assets compatible by falling back to the source image", () => {
    expect(assetRenderUrl(legacyAsset)).toBe(legacyAsset.storageUrl);
  });

  it("makes canvas and export consumers prefer the transparent derivative", () => {
    const ready = {
      ...legacyAsset,
      processedImageUrl: "https://example.com/yuri-alpha.png",
      processingStatus: "ready" as const,
      hasAlpha: true,
    };
    expect(assetRenderUrl(ready)).toBe(
      "https://example.com/yuri-alpha.png",
    );
    expect(isAssetReadyForComposition(ready)).toBe(true);
  });

  it("never promotes raw, processing, or failed character derivatives to composition", () => {
    for (const processingStatus of ["raw", "processing", "failed"] as const) {
      const asset = {
        ...legacyAsset,
        processedImageUrl: "https://example.com/yuri-alpha.png",
        processingStatus,
        hasAlpha: processingStatus === "failed" ? false : undefined,
      };
      // No composition URL at all. Returning the raw source here is what
      // painted the opaque generated background into panels and exports.
      expect(assetRenderUrl(asset)).toBeUndefined();
      expect(isAssetReadyForComposition(asset)).toBe(false);
      // Library chrome may still show the raw source next to a Retry control.
      expect(assetPreviewUrl(asset)).toBe(legacyAsset.storageUrl);
    }
  });
});

// ─── The render-URL contract ───────────────────────────────────────────────

/**
 * The production purple fringe was not a renderer bug: the renderer correctly
 * used `processedImageUrl`, which `processAndStoreAsset` had aliased to the raw
 * source for any asset whose provider supplied its own alpha. These pin both
 * halves so neither can be reintroduced.
 */
describe("render URL contract", () => {
  const base = {
    id: "a",
    projectId: "p",
    name: "Friend",
    type: "character-visual" as const,
    sourceUrl: "https://example.com/raw.png",
    storageUrl: "https://example.com/raw.png",
    width: 800,
    height: 1200,
    status: "ready" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("never falls back to the raw source for a processed character", () => {
    const asset = {
      ...base,
      category: "character" as const,
      processingStatus: "ready" as const,
      hasAlpha: true,
      processedImageUrl: undefined,
    };
    // Contract fails without a derivative, so there is nothing renderable —
    // and crucially NOT the contaminated source.
    expect(assetRenderUrl(asset)).toBeUndefined();
    expect(isAssetReadyForComposition(asset)).toBe(false);
  });

  it("renders the derivative when one exists", () => {
    expect(
      assetRenderUrl({
        ...base,
        category: "character" as const,
        processingStatus: "ready" as const,
        hasAlpha: true,
        processedImageUrl: "https://example.com/processed.png",
      }),
    ).toBe("https://example.com/processed.png");
  });

  it("still grandfathers documents written before the pipeline existed", () => {
    // No processing state at all: an old project must not go blank.
    expect(assetRenderUrl({ ...base, category: "character" as const })).toBe(base.storageUrl);
  });

  it("a failed extraction is not renderable, only previewable", () => {
    const asset = {
      ...base,
      category: "character" as const,
      processingStatus: "failed" as const,
      hasAlpha: false,
    };
    expect(assetRenderUrl(asset)).toBeUndefined();
    expect(assetPreviewUrl(asset)).toBe(base.storageUrl);
  });
});
