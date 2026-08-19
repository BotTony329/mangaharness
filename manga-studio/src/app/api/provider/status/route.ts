import { NextResponse } from "next/server";
import { getImageProvider } from "@/ai/providerRegistry";
import { agentConfigFromEnv } from "@/agent/providers/openaiCompatible";
import { isBlobConfigured } from "@/storage/objectStore";

export const runtime = "nodejs";

/**
 * Safe provider status for the settings UI. Returns configuration presence
 * and capabilities only — never key material.
 */
export async function GET(): Promise<NextResponse> {
  const provider = getImageProvider();
  const agent = agentConfigFromEnv();
  return NextResponse.json({
    configured: provider !== null,
    ...(provider
      ? { provider: provider.id, model: provider.model, capabilities: provider.capabilities }
      : {}),
    agent: {
      configured: agent !== null,
      ...(agent ? { provider: agent.providerLabel, model: agent.model } : {}),
    },
    storage: {
      configured: true,
      backend: isBlobConfigured() ? "vercel-blob" : "local-dev-files",
    },
  });
}

/** Test Connection button — performs a real round-trip to the provider. */
export async function POST(): Promise<NextResponse> {
  const provider = getImageProvider();
  if (!provider) {
    return NextResponse.json({ ok: false, error: "Provider not configured" }, { status: 503 });
  }
  try {
    const status = await provider.testConnection();
    return NextResponse.json(status.ok ? { ok: true } : { ok: false, error: status.message ?? "Connection failed" });
  } catch {
    return NextResponse.json({ ok: false, error: "Provider temporarily unavailable" }, { status: 502 });
  }
}
