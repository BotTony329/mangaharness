import { describe, expect, it } from "vitest";
import type { SourceAsset } from "@/domain/types";
import { assetRenderUrl } from "./renderSource";

const legacyAsset = {
  id: "asset-1",
  projectId: "project-1",
  category: "character",
  name: "Yuri",
  storageUrl: "https://example.com/yuri-source.jpg",
  width: 100,
  height: 200,
  createdAt: "2026-08-20T00:00:00.000Z",
} satisfies SourceAsset;

describe("asset render source", () => {
  it("keeps old assets compatible by falling back to the source image", () => {
    expect(assetRenderUrl(legacyAsset)).toBe(legacyAsset.storageUrl);
  });

  it("makes canvas and export consumers prefer the transparent derivative", () => {
    expect(assetRenderUrl({ ...legacyAsset, processedImageUrl: "https://example.com/yuri-alpha.png" })).toBe(
      "https://example.com/yuri-alpha.png",
    );
  });
});
