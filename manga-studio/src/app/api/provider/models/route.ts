import { NextRequest, NextResponse } from "next/server";
import { listOpenAiCompatibleModels } from "@/agent/providers/openaiCompatible";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";

/**
 * Optional model discovery for OpenAI-compatible providers. Best-effort:
 * many gateways don't expose /models, and manual model input always works.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as { kind?: string } | null;
  const kind = body?.kind;
  if (kind !== "agent" && kind !== "image") {
    return NextResponse.json({ error: "kind must be 'agent' or 'image'" }, { status: 400 });
  }
  const resolved = resolveProvider(request, kind);
  if (!resolved) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  if (resolved.config.providerType !== "openai-compatible") {
    return NextResponse.json({ models: [] });
  }
  try {
    const models = await listOpenAiCompatibleModels(resolved.config);
    return NextResponse.json({ models: models.slice(0, 200) });
  } catch {
    return NextResponse.json({ models: [] });
  }
}
