import { NextRequest, NextResponse } from "next/server";
import { detectImageType, MAX_UPLOAD_BYTES } from "@/storage/imageValidation";
import { processAndStoreAsset } from "@/assets/processAndStore";
import type { AssetCategory } from "@/domain/types";

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
    const stored = await processAndStoreAsset({
      data: Buffer.from(bytes),
      mimeType: detected.mimeType,
      extension: detected.extension,
      category,
      keyPrefix: "uploads",
    });
    return NextResponse.json({
      url: stored.processedImageUrl ?? stored.sourceUrl,
      sourceUrl: stored.sourceUrl,
      processedImageUrl: stored.processedImageUrl,
      mimeType: detected.mimeType,
      hasAlpha: stored.hasAlpha,
      backgroundRemoved: stored.backgroundRemoved,
      processingStatus: stored.processingStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseCategory(value: FormDataEntryValue | null): AssetCategory {
  return value === "character" || value === "background" || value === "prop" ? value : "upload";
}
