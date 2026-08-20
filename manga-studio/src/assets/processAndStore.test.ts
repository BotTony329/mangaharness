import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { putObject } from "@/storage/objectStore";
import { processAndStoreAsset } from "./processAndStore";
import type { AssetPostProcessor } from "./postProcessor";

vi.mock("@/storage/objectStore", () => ({ putObject: vi.fn() }));

const putObjectMock = vi.mocked(putObject);

beforeEach(() => putObjectMock.mockReset());

describe("process and store asset", () => {
  it("automatically creates a transparent derivative for an uploaded character", async () => {
    putObjectMock
      .mockResolvedValueOnce({ url: "https://blob.example/source.png" })
      .mockResolvedValueOnce({ url: "https://blob.example/processed.png" });
    const source = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from(`<svg width="16" height="24"><rect width="16" height="24" fill="#111"/></svg>`), left: 12, top: 8 }])
      .png()
      .toBuffer();

    const result = await processAndStoreAsset({
      data: source,
      mimeType: "image/png",
      extension: "png",
      category: "character",
      keyPrefix: "uploads",
    });

    expect(result).toMatchObject({
      sourceUrl: "https://blob.example/source.png",
      processedImageUrl: "https://blob.example/processed.png",
      hasAlpha: true,
      backgroundRemoved: true,
      processingStatus: "ready",
    });
    expect(putObjectMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the stored source when background removal fails", async () => {
    putObjectMock.mockResolvedValueOnce({ url: "https://blob.example/source.png" });
    const failingProcessor: AssetPostProcessor = {
      process: vi.fn().mockResolvedValue({
        sourceHasAlpha: false,
        hasAlpha: false,
        backgroundRemoved: false,
        processingStatus: "failed",
        reason: "foreground uncertain",
      }),
    };

    const result = await processAndStoreAsset({
      data: Buffer.from("opaque source"),
      mimeType: "image/png",
      extension: "png",
      category: "character",
      keyPrefix: "generated",
      processor: failingProcessor,
    });

    expect(result).toEqual({
      sourceUrl: "https://blob.example/source.png",
      processedImageUrl: undefined,
      hasAlpha: false,
      backgroundRemoved: false,
      processingStatus: "failed",
      processingReason: "foreground uncertain",
    });
    expect(putObjectMock).toHaveBeenCalledTimes(1);
  });
});
