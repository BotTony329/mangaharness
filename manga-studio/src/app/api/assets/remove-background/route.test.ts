import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadStoredAsset } from "@/assets/loadStoredAsset";
import { defaultAssetPostProcessor } from "@/assets/postProcessor";
import { putObject } from "@/storage/objectStore";
import { POST } from "./route";

vi.mock("@/assets/loadStoredAsset", () => ({ loadStoredAsset: vi.fn() }));
vi.mock("@/assets/postProcessor", () => ({
  defaultAssetPostProcessor: { process: vi.fn() },
}));
vi.mock("@/storage/objectStore", () => ({ putObject: vi.fn() }));

const loadMock = vi.mocked(loadStoredAsset);
const processMock = vi.mocked(defaultAssetPostProcessor.process);
const putMock = vi.mocked(putObject);

beforeEach(() => {
  loadMock.mockReset();
  processMock.mockReset();
  putMock.mockReset();
});

describe("POST /api/assets/remove-background", () => {
  it("reprocesses the immutable source and stores a new transparent derivative", async () => {
    loadMock.mockResolvedValue({ data: Buffer.from("source-image"), mimeType: "image/jpeg" });
    processMock.mockResolvedValue({
      sourceHasAlpha: false,
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
      processedData: Buffer.from("transparent-png"),
      processedMimeType: "image/png",
      processingMethod: "built-in-connectivity:checkerboard-matte",
    });
    putMock.mockResolvedValue({ url: "https://blob.example/cute-girl-alpha.png" });

    const response = await POST(request({
      sourceUrl: "https://blob.example/cute-girl.jpg",
      category: "character",
      assetId: "asset-cute-girl",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      processedImageUrl: "https://blob.example/cute-girl-alpha.png",
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
    });
    expect(processMock).toHaveBeenCalledWith(Buffer.from("source-image"), "character", { forceBackgroundRemoval: true });
    expect(putMock).toHaveBeenCalledWith(expect.stringMatching(/^processed\/manual-/), Buffer.from("transparent-png"), "image/png");
  });

  it("returns a retryable validation error without replacing the source", async () => {
    loadMock.mockResolvedValue({ data: Buffer.from("source-image"), mimeType: "image/jpeg" });
    processMock.mockResolvedValue({
      sourceHasAlpha: false,
      hasAlpha: false,
      backgroundRemoved: false,
      processingStatus: "failed",
      reason: "Opaque checkerboard detected, but no reliable foreground could be extracted",
    });

    const response = await POST(request({ sourceUrl: "https://blob.example/source.jpg", category: "character" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ processingStatus: "failed", hasAlpha: false });
    expect(putMock).not.toHaveBeenCalled();
  });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/assets/remove-background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
