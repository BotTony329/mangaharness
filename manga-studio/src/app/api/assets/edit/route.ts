import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { loadStoredAsset } from "@/assets/loadStoredAsset";
import { ProviderError } from "@/ai/types";
import { putObject } from "@/storage/objectStore";
import { resolveProvider } from "@/server/providerSession";
import { createImageProvider } from "@/ai/providerRegistry";
import {
  DEFAULT_FEATHER,
  compositeLocalEdit,
  maskFromRgba,
  maskIsEmpty,
  restoreAlpha,
} from "@/assets/localEdit";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  /** The asset being edited — this image IS the edit source. */
  sourceUrl: z.string().max(2048),
  /** PNG mask at the asset's own pixel dimensions; white = editable. */
  maskPng: z.string().max(12_000_000),
  instruction: z.string().min(1).max(2000),
  feather: z.number().min(0).max(24).optional(),
  /** Identity/style references, sent alongside the source where supported. */
  referenceUrls: z.array(z.string().max(2048)).max(4).optional(),
  /** Cut-out assets must keep their transparency; scenes must stay rectangular. */
  preserveAlpha: z.boolean().optional(),
});

/**
 * Local generative edit.
 *
 * Reuses the existing `editImage` provider capability rather than adding a
 * second image pipeline. What this route adds is the part a provider cannot be
 * asked to do reliably: **enforcing** that the edit is local.
 *
 * The provider is free to redraw the whole frame — most do. Its output is then
 * composited through the creator's mask, so every pixel outside that mask comes
 * byte-for-byte from the original. The prompt asks; the compositor guarantees.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const trace = (stage: string, details: Record<string, string | number | boolean | undefined> = {}) => {
    console.info("[asset-edit]", JSON.stringify({ requestId, stage, ...details }));
  };

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid edit request", requestId }, { status: 400 });
  }

  try {
    const imageConfig = resolveProvider(request, "image", trace)?.config;
    const provider = imageConfig ? createImageProvider(imageConfig) : undefined;
    if (!provider?.capabilities.supportsImageEditing || !provider.editImage) {
      /**
       * A clear capability error, never a silent fall back to full-image
       * generation: regenerating the whole asset is precisely what local
       * editing exists to avoid.
       */
      return NextResponse.json(
        {
          error:
            "The connected image model cannot edit images, so local edits are unavailable. Connect a model that supports image editing.",
          requestId,
        },
        { status: 422 },
      );
    }

    const source = await loadStoredAsset(parsed.data.sourceUrl);
    const decoded = await sharp(source.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;

    // The mask arrives already in image space; resizing here would silently
    // shift which pixels the creator selected.
    const maskRaw = await sharp(Buffer.from(parsed.data.maskPng.split(",").pop() ?? "", "base64"))
      .ensureAlpha()
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer();
    const mask = maskFromRgba(maskRaw, width, height);
    if (maskIsEmpty(mask)) {
      return NextResponse.json({ error: "Select an area to change first.", requestId }, { status: 400 });
    }

    trace("provider_edit_start", { width, height, provider: provider.id });
    const edited = await provider.editImage({
      instruction: parsed.data.instruction,
      image: { mimeType: source.mimeType, data: source.data, url: parsed.data.sourceUrl },
      trace,
    });

    const generated = await sharp(edited.data)
      .ensureAlpha()
      // Providers routinely return a different size; normalise before compositing
      // rather than rejecting an otherwise good edit.
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer();

    const composited = compositeLocalEdit({
      original: decoded.data,
      generated,
      mask,
      width,
      height,
      feather: parsed.data.feather ?? DEFAULT_FEATHER,
    });

    const generatedHasAlpha = await hasRealAlpha(edited.data);
    const finalRgba = parsed.data.preserveAlpha
      ? restoreAlpha(composited.rgba, decoded.data, mask, generatedHasAlpha)
      : composited.rgba;

    const png = await sharp(finalRgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const stored = await putObject(`edits/local-${crypto.randomUUID()}.png`, png, "image/png");
    trace("edit_stored", { editedPixels: composited.editedPixels, preserved: composited.preservedPixels });

    return NextResponse.json({
      url: stored.url,
      width,
      height,
      editedPixels: composited.editedPixels,
      preservedPixels: composited.preservedPixels,
      provider: provider.id,
      requestId,
    });
  } catch (error) {
    // The original is never modified, so a failure leaves the asset intact.
    const status = error instanceof ProviderError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Local edit failed", requestId },
      { status },
    );
  }
}

/** Does this image carry meaningful transparency, or is it a flattened frame? */
async function hasRealAlpha(data: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(data).stats();
    const alpha = stats.channels[3];
    return Boolean(alpha) && alpha.min < 250;
  } catch {
    return false;
  }
}
