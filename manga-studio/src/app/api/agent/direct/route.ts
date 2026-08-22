import { NextRequest, NextResponse } from "next/server";
import { planCreativeDirection, directorRequestSchema } from "@/agent-v3/director/creativeDirector";
import { createAgentProvider } from "@/agent/providers/registry";
import { AgentModelError } from "@/agent/providers/types";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Main Creative Director endpoint — the Agent V3 planning path. Same provider
 * session seam as the legacy planner; different contract (Creative Task Map
 * instead of raw tool steps).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = directorRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid director request" }, { status: 400 });

  const resolved = resolveProvider(request, "agent");
  if (!resolved) {
    return NextResponse.json({ error: "No agent model connected. Open AI Settings to add one." }, { status: 503 });
  }
  try {
    const provider = createAgentProvider(resolved.config);
    const result = await planCreativeDirection(provider, parsed.data, { signal: request.signal });
    return NextResponse.json({ ...result, diagnostics: { provider: provider.label, model: provider.model } });
  } catch (error) {
    if (error instanceof AgentModelError) {
      return NextResponse.json({ error: error.safeMessage || error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Creative direction failed" }, { status: 500 });
  }
}
