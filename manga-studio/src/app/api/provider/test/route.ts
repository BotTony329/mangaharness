import { NextRequest, NextResponse } from "next/server";
import { createImageProvider } from "@/ai/providerRegistry";
import { createAgentProvider } from "@/agent/providers/registry";
import { resolveProvider } from "@/server/providerSession";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Test Connection: a real server-side round-trip to the configured provider
 * (cheap status/model endpoints where available; never a full generation).
 * Responses are friendly statuses only — no auth headers, no raw provider
 * bodies beyond redacted excerpts.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as { kind?: string } | null;
  const kind = body?.kind;
  if (kind !== "agent" && kind !== "image") {
    return NextResponse.json({ ok: false, error: "kind must be 'agent' or 'image'" }, { status: 400 });
  }

  const resolved = resolveProvider(request, kind);
  if (!resolved) {
    return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });
  }

  try {
    const status =
      kind === "agent"
        ? await createAgentProvider(resolved.config).testConnection()
        : await createImageProvider(resolved.config).testConnection();
    return NextResponse.json(status.ok ? { ok: true, status: "Connected" } : { ok: false, error: status.message ?? "Connection failed" });
  } catch (error) {
    const message = error instanceof Error && "safeMessage" in error ? (error as { safeMessage: string }).safeMessage : "Endpoint unreachable";
    return NextResponse.json({ ok: false, error: message });
  }
}
