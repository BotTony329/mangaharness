import { NextRequest, NextResponse } from "next/server";
import { redactSecrets } from "@/ai/security";
import { planAgentRun, agentRequestSchema } from "@/agent/planner";
import { AgentModelError, agentConfigFromEnv } from "@/agent/providers/openaiCompatible";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Manga Agent planning endpoint. Returns a validated tool plan; execution
 * happens client-side through the editor command layer (same commands the
 * manual UI uses), so agent work is undoable and never a privileged path.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent request" }, { status: 400 });
  }

  const config = agentConfigFromEnv();
  if (!config) {
    return NextResponse.json(
      { error: "Agent model not configured. Set AGENT_API_KEY (and optionally AGENT_API_BASE_URL, AGENT_MODEL)." },
      { status: 503 },
    );
  }

  try {
    const result = await planAgentRun(config, parsed.data);
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
