import { NextRequest, NextResponse } from "next/server";
import { createImageProvider } from "@/ai/providerRegistry";
import { resolveProvider, summarize } from "@/server/providerSession";
import { isBlobConfigured } from "@/storage/objectStore";

export const runtime = "nodejs";

/**
 * Safe provider status: configuration presence, provider identity, and
 * capabilities. Never key material — the frontend only needs to know
 * configured / not configured.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const image = resolveProvider(request, "image");
  const agent = resolveProvider(request, "agent");

  let capabilities: unknown;
  if (image) {
    try {
      capabilities = createImageProvider(image.config).capabilities;
    } catch {
      capabilities = undefined;
    }
  }

  return NextResponse.json({
    image: { ...summarize(image), capabilities },
    agent: summarize(agent),
    // Legacy top-level fields kept for the generator/agent panels.
    configured: image !== null,
    capabilities,
    storage: {
      configured: isBlobConfigured() || !process.env.VERCEL,
      backend: isBlobConfigured() ? "vercel-blob" : "local-dev-files",
    },
  });
}
