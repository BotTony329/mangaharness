import { NextRequest, NextResponse } from "next/server";
import {
  buildProviderConfig,
  clearSessionConfig,
  configPayloadSchema,
  readSessionConfig,
  summarize,
  writeSessionConfig,
  type ProviderKind,
} from "@/server/providerSession";
import { isEncryptionConfigured } from "@/server/secretBox";

export const runtime = "nodejs";

/**
 * Save a BYOK provider configuration. The API key is encrypted server-side
 * into an HttpOnly cookie — browser JavaScript never reads it back, and this
 * response returns only a safe summary.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "Server is missing APP_ENCRYPTION_KEY — provider setup is disabled until it is configured." },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const parsed = configPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid provider configuration" }, { status: 400 });
  }

  try {
    // Editing without re-typing the key keeps the previously stored secret.
    const existing = readSessionConfig(request, parsed.data.kind);
    const config = buildProviderConfig(parsed.data, existing);
    const response = NextResponse.json(summarize({ config, source: "session" }));
    writeSessionConfig(response, config);
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid provider configuration" },
      { status: 400 },
    );
  }
}

/** Forget Provider: deletes the encrypted credential cookie. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const kind = request.nextUrl.searchParams.get("kind");
  if (kind !== "agent" && kind !== "image") {
    return NextResponse.json({ error: "kind must be 'agent' or 'image'" }, { status: 400 });
  }
  const response = NextResponse.json({ ok: true });
  clearSessionConfig(response, kind as ProviderKind);
  return response;
}
