import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset } from "@/domain/libraryOps";
import { useEditorStore } from "@/editor/store";
import { removeAssetBackground } from "./clientProcessing";
import { assetRenderUrl } from "./renderSource";

let assetId: string;

beforeEach(() => {
  const created = addAsset(createProjectDocument("Reprocessing"), {
    category: "character",
    name: "Cute Girl",
    storageUrl: "https://blob.example/cute-girl-source.jpg",
    width: 848,
    height: 1264,
    processingStatus: "failed",
    processingReason: "Opaque checkerboard detected",
  });
  assetId = created.assetId;
  useEditorStore.getState().loadDocument(created.doc);
});

describe("manual asset background removal", () => {
  it("updates the same asset with a derivative while preserving its source", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({
        processedImageUrl: "https://blob.example/cute-girl-alpha.png",
        hasAlpha: true,
        backgroundRemoved: true,
        processingStatus: "ready",
        requestId: "request-1",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await removeAssetBackground(assetId);

    const asset = useEditorStore.getState().doc!.assets[assetId];
    expect(asset.storageUrl).toBe("https://blob.example/cute-girl-source.jpg");
    expect(asset).toMatchObject({
      processedImageUrl: "https://blob.example/cute-girl-alpha.png",
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      status: "ready",
    });
    expect(assetRenderUrl(asset)).toBe("https://blob.example/cute-girl-alpha.png");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      sourceUrl: "https://blob.example/cute-girl-source.jpg",
      assetId,
    });
  });

  it("keeps the source retryable when extraction fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      processingStatus: "failed",
      error: "Foreground extraction was uncertain",
    }), { status: 422 })));

    await expect(removeAssetBackground(assetId)).rejects.toThrow("Foreground extraction was uncertain");
    const asset = useEditorStore.getState().doc!.assets[assetId];
    expect(asset.storageUrl).toBe("https://blob.example/cute-girl-source.jpg");
    expect(asset).toMatchObject({ processingStatus: "failed", status: "failed" });
    expect(asset.processedImageUrl).toBeUndefined();
  });
});
