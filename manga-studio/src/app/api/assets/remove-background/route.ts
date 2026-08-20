import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadStoredAsset } from "@/assets/loadStoredAsset";
import { defaultAssetPostProcessor } from "@/assets/postProcessor";
import { ProviderError } from "@/ai/types";
import { putObject } from "@/storage/objectStore";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  sourceUrl: z.string().max(2048),
  category: z.enum(["character", "prop"]),
});

/** Create a non-destructive transparent derivative for an existing source asset. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid background-removal request" }, { status: 400 });
  try {
    const source = await loadStoredAsset(parsed.data.sourceUrl);
    const result = await defaultAssetPostProcessor.process(source.data, parsed.data.category, { forceBackgroundRemoval: true });
    if (result.processingStatus === "failed") {
      return NextResponse.json({
        hasAlpha: false,
        backgroundRemoved: false,
        processingStatus: "failed",
        error: result.reason ?? "Background removal failed",
      });
    }
    const processedImageUrl = result.processedData
      ? (await putObject(`processed/manual-${crypto.randomUUID()}.png`, result.processedData, "image/png")).url
      : parsed.data.sourceUrl;
    return NextResponse.json({
      processedImageUrl,
      hasAlpha: true,
      backgroundRemoved: result.backgroundRemoved,
      processingStatus: "ready",
    });
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 500;
    const message = error instanceof ProviderError ? error.safeMessage : "Background removal failed";
    return NextResponse.json({ error: message, processingStatus: "failed" }, { status });
  }
}
