import { NextRequest, NextResponse } from "next/server";
import { createImageProvider } from "@/ai/providerRegistry";
import { createAgentProvider } from "@/agent/providers/registry";
import { buildRequestPreview } from "@/server/customApi/preview";
import { resolveProvider } from "@/server/providerSession";
import { createBackgroundRemovalProvider } from "@/assets/providers/registry";

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
  if (kind !== "agent" && kind !== "image" && kind !== "background") {
    return NextResponse.json({ ok: false, error: "Unknown provider kind" }, { status: 400 });
  }

  const resolved = resolveProvider(request, kind);
  if (!resolved) {
    return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });
  }

  // Custom providers get a redacted request preview either way — most useful
  // exactly when the test fails and the user is debugging a new API.
  const preview = buildRequestPreview(resolved.config);

  try {
    const status =
      kind === "agent"
        ? await createAgentProvider(resolved.config).testConnection()
        : kind === "image"
          ? await createImageProvider(resolved.config).testConnection()
          : (await createBackgroundRemovalProvider(resolved.config).testConnection?.()) ?? { ok: true };
    return NextResponse.json(
      status.ok
        ? { ok: true, status: "Connected", detail: status.message, preview }
        : { ok: false, error: status.message ?? "Connection failed", preview },
    );
  } catch (error) {
    const message = error instanceof Error && "safeMessage" in error ? (error as { safeMessage: string }).safeMessage : "Endpoint unreachable";
    return NextResponse.json({ ok: false, error: message, preview });
  }
}
