import { NextRequest, NextResponse } from "next/server";
import { generateAssetImage, generateRequestSchema } from "@/ai/generate";
import { redactSecrets } from "@/ai/security";
import { ProviderError } from "@/ai/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Real image generation. The API key never leaves this server boundary. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generation request" }, { status: 400 });
  }

  try {
    const result = await generateAssetImage(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.safeMessage }, { status: error.status });
    }
    console.error("Generation failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
