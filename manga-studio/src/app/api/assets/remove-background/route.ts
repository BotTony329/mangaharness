import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadStoredAsset } from "@/assets/loadStoredAsset";
import { ProviderError } from "@/ai/types";
import { putObject } from "@/storage/objectStore";
import { resolveProvider } from "@/server/providerSession";
import { createImageProvider } from "@/ai/providerRegistry";
import { createBackgroundRemovalProvider } from "@/assets/providers/registry";
import { createAssetProcessingPipeline } from "@/assets/processingPipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  sourceUrl: z.string().max(2048),
  category: z.enum(["character", "prop"]),
  assetId: z.string().max(160).optional(),
  strategy: z.enum(["auto", "image-edit", "provider", "local"]).default("auto"),
});

/** Create a non-destructive transparent derivative for an existing source asset. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const trace = (stage: string, details: Record<string, string | number | boolean | undefined> = {}) => {
    console.info("[bg-remove]", JSON.stringify({ requestId, stage, atMs: Math.round(performance.now() - startedAt), ...details }));
  };
  trace("request_received");
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid background-removal request", requestId }, { status: 400 });
  try {
    const source = await loadStoredAsset(parsed.data.sourceUrl);
    trace("asset_loaded", { bytes: source.data.length, mimeType: source.mimeType, category: parsed.data.category });
    const imageConfig = resolveProvider(request, "image", trace)?.config;
    const backgroundConfig = resolveProvider(request, "background", trace)?.config;
    const imageProvider = imageConfig ? createImageProvider(imageConfig) : undefined;
    const backgroundProvider = backgroundConfig ? createBackgroundRemovalProvider(backgroundConfig) : undefined;
    trace("processor_started", { imageEdit: Boolean(imageProvider?.capabilities.supportsImageEditing), backgroundProvider: backgroundProvider?.id });
    const processor = createAssetProcessingPipeline({ imageProvider, backgroundProvider, trace });
    const result = await processor.process(source.data, parsed.data.category, {
      forceBackgroundRemoval: true,
      sourceUrl: parsed.data.sourceUrl,
      sourceMimeType: source.mimeType,
      strategy: parsed.data.strategy,
    });
    trace("processor_completed", { status: result.processingStatus, method: result.processingMethod });
    if (result.processingStatus === "failed") {
      trace("response_returned", { status: 422, failureStage: "foreground_extraction" });
      return NextResponse.json({
        hasAlpha: false,
        backgroundRemoved: false,
        processingStatus: "failed",
        processingReason: result.reason,
        error: result.reason ?? "Background removal failed",
        requestId,
      }, { status: 422 });
    }
    trace("alpha_validated", { hasAlpha: result.hasAlpha, backgroundRemoved: result.backgroundRemoved });
    const processedImageUrl = result.processedData
      ? (await putObject(`processed/manual-${crypto.randomUUID()}.png`, result.processedData, "image/png")).url
      : parsed.data.sourceUrl;
    trace("asset_saved", { derivativeCreated: Boolean(result.processedData) });
    trace("response_returned", { status: 200 });
    return NextResponse.json({
      processedImageUrl,
      hasAlpha: true,
      backgroundRemoved: result.backgroundRemoved,
      processingStatus: "ready",
      backgroundRemovalMethod: result.processingMethod,
      backgroundRemovalProvider: result.processingProvider,
      requestId,
    });
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 500;
    const message = error instanceof ProviderError ? error.safeMessage : "Background removal failed";
    trace("response_returned", { status, failureStage: "route" });
    return NextResponse.json({ error: message, processingStatus: "failed", requestId }, { status });
  }
}
