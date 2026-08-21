import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ImageGenerationProvider } from "@/ai/types";
import type { BackgroundRemovalProvider } from "./providers/types";
import { createAssetProcessingPipeline } from "./processingPipeline";

describe("asset processing cascade", () => {
  it("accepts real native alpha without calling another provider", async () => {
    const editImage = vi.fn();
    const removeBackground = vi.fn();
    const result = await createAssetProcessingPipeline({
      imageProvider: imageProvider(editImage),
      backgroundProvider: backgroundProvider(removeBackground),
    }).process(await transparentSubject(), "character");

    expect(result).toMatchObject({ processingStatus: "ready", hasAlpha: true, backgroundRemoved: false });
    expect(editImage).not.toHaveBeenCalled();
    expect(removeBackground).not.toHaveBeenCalled();
  });

  it("uses the image-provider edit pass and validates its alpha", async () => {
    const edited = await transparentSubject();
    const editImage = vi.fn().mockResolvedValue({ mimeType: "image/png", data: edited });
    const result = await createAssetProcessingPipeline({ imageProvider: imageProvider(editImage) })
      .process(await opaqueSubject(), "character", { sourceMimeType: "image/jpeg", sourceUrl: "https://blob.example/source.jpg" });

    expect(result).toMatchObject({
      processingStatus: "ready",
      backgroundRemoved: true,
      processingMethod: "image-edit",
      processingProvider: "image-test",
    });
    expect(editImage).toHaveBeenCalledWith(expect.objectContaining({
      image: expect.objectContaining({ mimeType: "image/jpeg", url: "https://blob.example/source.jpg" }),
    }));
  });

  it("falls through an opaque edit response to a dedicated provider", async () => {
    const editImage = vi.fn().mockResolvedValue({ mimeType: "image/png", data: await opaqueSubject() });
    const removeBackground = vi.fn().mockResolvedValue({
      success: true,
      processedImage: await transparentSubject(),
      mimeType: "image/png",
      alphaValidation: { valid: true },
      providerMetadata: { id: "background-test", name: "Background Test" },
    });
    const result = await createAssetProcessingPipeline({
      imageProvider: imageProvider(editImage),
      backgroundProvider: backgroundProvider(removeBackground),
    }).process(await opaqueSubject(), "character");

    expect(editImage).toHaveBeenCalledOnce();
    expect(removeBackground).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      processingStatus: "ready",
      processingMethod: "dedicated-provider",
      processingProvider: "background-test",
    });
  });

  it("uses the built-in extraction only after provider attempts fail", async () => {
    const events: string[] = [];
    const editImage = vi.fn().mockRejectedValue(new Error("edit unavailable"));
    const removeBackground = vi.fn().mockResolvedValue({
      success: false,
      alphaValidation: { valid: false, reason: "no mask" },
      providerMetadata: { id: "background-test", name: "Background Test" },
      safeError: "no mask",
    });
    const result = await createAssetProcessingPipeline({
      imageProvider: imageProvider(editImage),
      backgroundProvider: backgroundProvider(removeBackground),
      trace: (stage, details) => {
        if (stage === "background_removal_attempt_start") events.push(String(details?.method));
      },
    }).process(await opaqueSubject(), "character");

    expect(events).toEqual(["image_edit", "dedicated_provider", "local_fallback"]);
    expect(result).toMatchObject({ processingStatus: "ready", processingProvider: "built-in-connectivity" });
  });

  it("does not report success when every method returns an unusable mask", async () => {
    const checker = await opaqueCheckerboard();
    const result = await createAssetProcessingPipeline({
      imageProvider: imageProvider(vi.fn().mockResolvedValue({ mimeType: "image/png", data: checker })),
      backgroundProvider: backgroundProvider(vi.fn().mockResolvedValue({
        success: false,
        alphaValidation: { valid: false, reason: "opaque output" },
        providerMetadata: { id: "background-test", name: "Background Test" },
      })),
    }).process(checker, "character");

    expect(result).toMatchObject({ processingStatus: "failed", hasAlpha: false, backgroundRemoved: false });
    expect(result.reason).toContain("Foreground extraction fallback");
  });
});

function imageProvider(editImage: ImageGenerationProvider["editImage"]): ImageGenerationProvider {
  return {
    id: "image-test",
    label: "Image Test",
    model: "test-model",
    capabilities: {
      textToImage: true,
      supportsReferenceImage: true,
      supportsTransparentBackground: false,
      supportsImageEditing: true,
      referenceImage: true,
      imageVariation: true,
      transparentOutput: false,
      asyncGeneration: false,
    },
    testConnection: vi.fn(),
    generateImage: vi.fn(),
    editImage,
  };
}

function backgroundProvider(removeBackground: BackgroundRemovalProvider["removeBackground"]): BackgroundRemovalProvider {
  return { id: "background-test", name: "Background Test", removeBackground };
}

async function transparentSubject(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 28, height: 42, channels: 4, background: "#194fa0" } }).png().toBuffer(), left: 18, top: 10 }])
    .png()
    .toBuffer();
}

async function opaqueSubject(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } })
    .composite([{ input: await sharp({ create: { width: 28, height: 42, channels: 3, background: "#194fa0" } }).png().toBuffer(), left: 18, top: 10 }])
    .png()
    .toBuffer();
}

async function opaqueCheckerboard(): Promise<Buffer> {
  const tile = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 188 : 245;
      tile.fill(value, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
    }
  }
  return sharp(tile, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
}
