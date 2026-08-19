import { NextRequest, NextResponse } from "next/server";
import { readLocalObject } from "@/storage/objectStore";
import { detectImageType } from "@/storage/imageValidation";

export const runtime = "nodejs";

/** Dev-only file server for the local (.data) storage fallback. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path: segments } = await context.params;
  const data = await readLocalObject(segments.join("/"));
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const detected = detectImageType(new Uint8Array(data.subarray(0, 16)));
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": detected?.mimeType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
