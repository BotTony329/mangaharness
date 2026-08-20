import { NextRequest, NextResponse } from "next/server";
import { generateAssetImage, generateRequestSchema } from "@/ai/generate";
import { redactSecrets } from "@/ai/security";
import { ProviderError } from "@/ai/types";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Real image generation. The API key never leaves this server boundary. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const trace = (stage: string, details: Record<string, string | number | boolean | undefined> = {}) => {
    console.info(`[generate] ${stage}`, { requestId, ...details });
  };
  trace("request_received");
  const body = await request.json().catch(() => null);
  trace(body === null ? "request_parse_failed" : "request_parsed");
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    trace("request_validation_failed");
    return NextResponse.json({ error: "Invalid generation request", requestId }, { status: 400 });
  }
  trace("request_validated", { assetType: parsed.data.assetType, referenceCount: parsed.data.referenceUrls?.length ?? 0 });

  try {
    // BYOK session config first; deployment env vars as operator fallback.
    const resolved = resolveProvider(request, "image", trace);
    const result = await generateAssetImage(parsed.data, resolved?.config ?? null, trace);
    trace("request_complete", { provider: result.provider });
    return NextResponse.json({ ...result, requestId });
  } catch (error) {
    if (error instanceof ProviderError) {
      trace("request_failed", {
        errorType: error.name,
        status: error.status,
        message: redactSecrets(error.safeMessage),
      });
      return NextResponse.json(
        { error: error.safeMessage, requestId, details: error.details },
        { status: error.status },
      );
    }
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const stack = error instanceof Error && error.stack ? redactSecrets(error.stack) : undefined;
    console.error("[generate] request_failed", { requestId, errorType: error instanceof Error ? error.name : "Unknown", message, stack });
    return NextResponse.json({ error: "Generation failed", requestId }, { status: 500 });
  }
}
