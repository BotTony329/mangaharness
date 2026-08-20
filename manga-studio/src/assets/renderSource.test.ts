import { describe, expect, it } from "vitest";
import type { SourceAsset } from "@/domain/types";
import { assetRenderUrl, isAssetReadyForComposition } from "./renderSource";

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
      expect(assetRenderUrl(asset)).toBe(legacyAsset.storageUrl);
      expect(isAssetReadyForComposition(asset)).toBe(false);
    }
  });
});
