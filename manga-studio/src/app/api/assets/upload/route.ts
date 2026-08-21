import { NextRequest, NextResponse } from "next/server";
import { detectImageType, MAX_UPLOAD_BYTES } from "@/storage/imageValidation";
import { processAndStoreAsset } from "@/assets/processAndStore";
import type { AssetCategory } from "@/domain/types";
import { resolveProvider } from "@/server/providerSession";
import { createImageProvider } from "@/ai/providerRegistry";
import { createBackgroundRemovalProvider } from "@/assets/providers/registry";
import { createAssetProcessingPipeline } from "@/assets/processingPipeline";

export const runtime = "nodejs";

/**
 * Upload an image asset. The binary goes to object storage; the domain-level
 * SourceAsset record is created client-side with the returned URL (the
 * project document lives in the browser for MVP).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Image is too large. Maximum size: 10 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImageType(bytes);
  if (!detected) {
    return NextResponse.json({ error: "Unsupported image format. Use PNG, JPG, or WEBP." }, { status: 415 });
  }

  try {
    const category = parseCategory(form.get("category"));
    const imageConfig = resolveProvider(request, "image")?.config;
    const backgroundConfig = resolveProvider(request, "background")?.config;
    const stored = await processAndStoreAsset({
      data: Buffer.from(bytes),
      mimeType: detected.mimeType,
      extension: detected.extension,
      category,
      keyPrefix: "uploads",
      processor: createAssetProcessingPipeline({
        imageProvider: imageConfig ? createImageProvider(imageConfig) : undefined,
        backgroundProvider: backgroundConfig ? createBackgroundRemovalProvider(backgroundConfig) : undefined,
      }),
    });
    return NextResponse.json({
      url: stored.processedImageUrl ?? stored.sourceUrl,
      sourceUrl: stored.sourceUrl,
      processedImageUrl: stored.processedImageUrl,
      mimeType: detected.mimeType,
      hasAlpha: stored.hasAlpha,
      backgroundRemoved: stored.backgroundRemoved,
      processingStatus: stored.processingStatus,
      processingReason: stored.processingReason,
      backgroundRemovalMethod: stored.backgroundRemovalMethod,
      backgroundRemovalProvider: stored.backgroundRemovalProvider,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseCategory(value: FormDataEntryValue | null): AssetCategory {
  /**
   * Tone is deliberately NOT in `requiresTransparency`: a screentone the
   * creator uploads may already be a transparent PNG, and running background
   * removal over an arbitrary pattern would eat the pattern. Existing alpha is
   * preserved; an opaque one is offered the same repair workflow the character
   * shelf uses, on request rather than automatically (§12).
   */
  return value === "character" || value === "background" || value === "prop" || value === "tone" ? value : "upload";
}
