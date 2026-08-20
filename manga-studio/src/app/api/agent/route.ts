import { NextRequest, NextResponse } from "next/server";
import { redactSecrets } from "@/ai/security";
import { planAgentRun, agentRequestSchema } from "@/agent/planner";
import { createAgentProvider } from "@/agent/providers/registry";
import { AgentModelError } from "@/agent/providers/types";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";
export const maxDuration = 120;

type RouteStage = "request_received" | "provider_config_loaded" | "response_returned" |
  import("@/agent/planner").AgentTraceStage;

interface TraceEvent {
  stage: RouteStage;
  atMs: number;
  details?: Record<string, string | number | boolean | undefined>;
}

/**
 * Manga Agent planning endpoint. The reasoning model is whatever the user
 * connected in AI Settings (session config first, deployment env fallback);
 * the harness — context, skills, tools, validation — is Manga Studio's.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const events: TraceEvent[] = [];
  let provider: ReturnType<typeof createAgentProvider> | undefined;
  const trace = (stage: RouteStage, details?: TraceEvent["details"]) => {
    const event = { stage, atMs: Math.round(performance.now() - startedAt), details };
    events.push(event);
    console.info("[agent]", JSON.stringify({ requestId, ...event }));
  };
  trace("request_received");
  const body = await request.json().catch(() => null);
  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) {
    trace("response_returned", { status: 400 });
    return NextResponse.json({ error: "Invalid agent request", details: diagnostics(requestId, events) }, { status: 400 });
  }
  trace("context_built", { contextChars: parsed.data.context.length });

  const resolved = resolveProvider(request, "agent");
  if (!resolved) {
    trace("response_returned", { status: 503 });
    return NextResponse.json(
      { error: "No agent model connected. Open AI Settings to add one.", details: diagnostics(requestId, events) },
      { status: 503 },
    );
  }

  try {
    provider = createAgentProvider(resolved.config);
    trace("provider_config_loaded", { provider: provider.label, model: provider.model, source: resolved.source });
    const result = await planAgentRun(provider, parsed.data, { signal: request.signal, trace });
    trace("response_returned", { status: 200 });
    return NextResponse.json({ ...result, diagnostics: diagnostics(requestId, events, provider) });
  } catch (error) {
    if (error instanceof AgentModelError) {
      trace("response_returned", { status: error.status, failureStage: error.stage });
      console.error("[agent]", JSON.stringify({
        requestId,
        stage: error.stage,
        error: error.safeMessage,
        providerStatus: error.providerStatus,
        finishReason: error.finishReason,
      }));
      return NextResponse.json({
        error: error.safeMessage,
        details: {
          ...diagnostics(requestId, events, provider),
          stage: error.stage,
          reason: error.safeMessage,
          providerStatus: error.providerStatus,
          finishReason: error.finishReason,
        },
      }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Agent planning failed";
    trace("response_returned", { status: 500 });
    console.error("[agent]", JSON.stringify({ requestId, stage: "planning", error: redactSecrets(message) }));
    return NextResponse.json({
      error: "Agent planning failed",
      details: { ...diagnostics(requestId, events, provider), stage: "planning", reason: "Unexpected planner failure" },
    }, { status: 500 });
  }
}

function diagnostics(requestId: string, events: TraceEvent[], provider?: { label: string; model: string }) {
  const at = (stage: RouteStage) => events.find((event) => event.stage === stage)?.atMs;
  const duration = (from: RouteStage, to: RouteStage) => {
    const start = at(from);
    const end = at(to);
    return start === undefined || end === undefined ? undefined : Math.max(0, end - start);
  };
  return {
    requestId,
    provider: provider?.label,
    model: provider?.model,
    elapsedMs: events.at(-1)?.atMs ?? 0,
    timings: {
      contextBuildMs: duration("request_received", "context_built"),
      providerRequestMs: duration("outbound_request_start", "provider_response_complete") ??
        duration("outbound_request_start", "response_returned"),
      firstResponseByteMs: duration("outbound_request_start", "first_response_byte"),
      parsingMs: duration("response_parse_start", "response_parse_complete"),
      validationMs: duration("plan_normalized", "tool_validation_complete"),
    },
  };
}
