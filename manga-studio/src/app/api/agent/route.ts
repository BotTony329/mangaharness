import { NextRequest, NextResponse } from "next/server";
import { redactSecrets } from "@/ai/security";
import { planAgentRun, agentRequestSchema } from "@/agent/planner";
import { createAgentProvider } from "@/agent/providers/registry";
import { AgentModelError } from "@/agent/providers/types";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Manga Agent planning endpoint. The reasoning model is whatever the user
 * connected in AI Settings (session config first, deployment env fallback);
 * the harness — context, skills, tools, validation — is Manga Studio's.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent request" }, { status: 400 });
  }

  const resolved = resolveProvider(request, "agent");
  if (!resolved) {
    return NextResponse.json(
      { error: "No agent model connected. Open AI Settings to add one." },
      { status: 503 },
    );
  }

  try {
    const provider = createAgentProvider(resolved.config);
    const result = await planAgentRun(provider, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AgentModelError) {
      return NextResponse.json({ error: error.safeMessage }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Agent planning failed";
    console.error("Agent planning failed:", redactSecrets(message));
    return NextResponse.json({ error: "Agent planning failed" }, { status: 500 });
  }
}
