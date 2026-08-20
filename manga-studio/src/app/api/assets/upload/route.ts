import { NextRequest, NextResponse } from "next/server";
import { putObject } from "@/storage/objectStore";
import { detectImageType, MAX_UPLOAD_BYTES } from "@/storage/imageValidation";

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
    const stored = await putObject(
      `uploads/${crypto.randomUUID()}.${detected.extension}`,
      Buffer.from(bytes),
      detected.mimeType,
    );
    return NextResponse.json({ url: stored.url, mimeType: detected.mimeType });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
