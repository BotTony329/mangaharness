/**
 * Server-side generation service: validates requests, gathers reference
 * images from our own storage, invokes the configured provider, and persists
 * the result to object storage. This module is the only place where provider
 * output crosses into stored assets.
 */

import { z } from "zod";
import type { ProviderConfig } from "@/server/providerSession";
import { readLocalObject } from "@/storage/objectStore";
import { createImageProvider } from "./providerRegistry";
import { isAllowedReferenceUrl } from "./security";
import { ProviderError, type GeneratedAssetType, type GenerationTrace } from "./types";
import { processAndStoreAsset } from "@/assets/processAndStore";
import type { AssetCategory } from "@/domain/types";
import { createAssetProcessingPipeline } from "@/assets/processingPipeline";
import { createBackgroundRemovalProvider } from "@/assets/providers/registry";

export const generateRequestSchema = z.object({
  assetType: z.enum(["character", "character-pose", "character-expression", "background", "prop", "manga-effect", "tone"]),
  prompt: z.string().min(3).max(4000),
  negativePrompt: z.string().max(1000).optional(),
  referenceUrls: z.array(z.string().max(2048)).max(3).optional(),
  size: z.enum(["portrait", "landscape", "square"]).optional(),
  /** Monochrome project style: refuse colour-contaminated character results. */
  expectMonochrome: z.boolean().optional(),
  /** Screentone semantics, when assetType is "tone". */
  toneType: z.enum(["texture", "atmosphere", "decorative", "pattern"]).optional(),
  tileable: z.boolean().optional(),
});

export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;

export interface GenerateResult {
  url: string;
  sourceUrl: string;
  processedImageUrl?: string;
  mimeType: string;
  hasAlpha: boolean;
  backgroundRemoved: boolean;
  processingStatus: "ready" | "failed";
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
  provider: string;
  model: string;
  referenceUsed: boolean;
}

const SIZE_MAP: Record<string, { width: number; height: number }> = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
};

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export async function generateAssetImage(
  input: GenerateRequestInput,
  config: ProviderConfig | null,
  trace?: GenerationTrace,
  backgroundConfig?: ProviderConfig | null,
): Promise<GenerateResult> {
  if (!config) {
    throw new ProviderError("No image provider connected. Open AI Settings to add one.", 503);
  }
  trace?.("adapter_construction_start", { providerType: config.providerType });
  const provider = createImageProvider(config);
  const backgroundProvider = backgroundConfig ? createBackgroundRemovalProvider(backgroundConfig) : undefined;
  trace?.("adapter_created", { provider: provider.id, referenceImage: provider.capabilities.supportsReferenceImage });

  // References are only sent when the provider actually supports them —
  // the UI must never pretend identity preservation happens when it can't.
  const wantsReferences = provider.capabilities.supportsReferenceImage;
  const validatedUrls = wantsReferences ? (input.referenceUrls ?? []).filter(isAllowedReferenceUrl) : [];
  trace?.("reference_processing_start", { requested: input.referenceUrls?.length ?? 0, supported: wantsReferences });
  const referenceImages = wantsReferences ? await loadReferences(input.referenceUrls ?? []) : [];
  trace?.("reference_processing_complete", { loaded: referenceImages.length });

  const size = SIZE_MAP[input.size ?? "portrait"];
  const category = categoryFor(input.assetType);
  /**
   * Transparency contract: characters/props get full cutout extraction. Tones
   * are overlays, not cutouts — texture/pattern tones keep their field (the
   * renderer tiles them); atmosphere/decorative tones ask the provider for
   * NATIVE transparency so a glow never ships as a white rectangle. A tone is
   * never routed through the prop pipeline to borrow its alpha handling.
   */
  const transparentBackground =
    provider.capabilities.supportsTransparentBackground &&
    (category === "character" ||
      category === "prop" ||
      (category === "tone" && (input.toneType === "atmosphere" || input.toneType === "decorative")));
  trace?.("normalized_request_constructed", {
    assetType: input.assetType,
    references: referenceImages.length,
    width: size.width,
    height: size.height,
    transparentBackground,
  });
  const result = await provider.generateImage({
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    assetType: input.assetType as GeneratedAssetType,
    width: size.width,
    height: size.height,
    transparentBackground,
    referenceImages,
    referenceUrls: validatedUrls,
    trace,
  });

  if (result.data.length === 0) throw new ProviderError("Invalid image response");
  trace?.("provider_result_normalized", { mimeType: result.mimeType, bytes: result.data.length });

  const extension = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/webp" ? "webp" : "png";
  trace?.("asset_post_processing_start", { assetType: input.assetType });
  let stored;
  try {
    stored = await processAndStoreAsset({
      data: result.data,
      mimeType: result.mimeType,
      extension,
      category,
      keyPrefix: "generated",
      expectMonochrome: input.expectMonochrome,
      // Generation is the one path that promised a white backdrop, so it is the
      // one path that enforces it.
      requireWhiteBackground: category === "character" || category === "prop",
      processor: createAssetProcessingPipeline({ imageProvider: provider, backgroundProvider, trace }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Persistent storage is not configured")) {
      throw new ProviderError(
        "The image provider returned an image, but persistent asset storage is not configured.",
        503,
        { stage: "asset_persistence", provider: provider.id, model: provider.model },
      );
    }
    throw error;
  }
  trace?.("asset_post_processing_complete", {
    status: stored.processingStatus,
    hasAlpha: stored.hasAlpha,
    backgroundRemoved: stored.backgroundRemoved,
  });
  trace?.("asset_persisted", { backend: process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local" });

  return {
    url: stored.processedImageUrl ?? stored.sourceUrl,
    sourceUrl: stored.sourceUrl,
    processedImageUrl: stored.processedImageUrl,
    mimeType: result.mimeType,
    hasAlpha: stored.hasAlpha,
    backgroundRemoved: stored.backgroundRemoved,
    processingStatus: stored.processingStatus,
    processingReason: stored.processingReason,
    backgroundRemovalMethod: stored.backgroundRemovalMethod,
    backgroundRemovalProvider: stored.backgroundRemovalProvider,
    provider: provider.id,
    model: provider.model,
    referenceUsed: referenceImages.length > 0,
  };
}

function categoryFor(assetType: GeneratedAssetType): AssetCategory {
  if (assetType === "background") return "background";
  if (assetType === "prop") return "prop";
  // A manga-language visual is an isolated cutout on a flat field, exactly the
  // shape a prop is — so it takes the prop post-processing path and gets real
  // transparency instead of a pasted white rectangle.
  if (assetType === "manga-effect") return "prop";
  // Tone is Tone: first-class category, overlay semantics (see the
  // transparency contract above).
  if (assetType === "tone") return "tone";
  return "character";
}

async function loadReferences(urls: string[]): Promise<{ mimeType: string; data: Buffer }[]> {
  const references: { mimeType: string; data: Buffer }[] = [];
  for (const url of urls) {
    if (!isAllowedReferenceUrl(url)) {
      throw new ProviderError("Unsupported reference image location", 400);
    }
    const reference = url.startsWith("/api/files/") ? await loadLocalReference(url) : await fetchRemoteReference(url);
    if (reference) references.push(reference);
  }
  return references;
}

async function loadLocalReference(url: string): Promise<{ mimeType: string; data: Buffer } | null> {
  const data = await readLocalObject(url.replace("/api/files/", ""));
  if (!data) return null;
  return { mimeType: guessMime(url), data };
}

async function fetchRemoteReference(url: string): Promise<{ mimeType: string; data: Buffer } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new ProviderError("Unsupported reference image", 400);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_REFERENCE_BYTES) throw new ProviderError("Reference image too large", 400);
    return { mimeType: response.headers.get("content-type")?.split(";")[0] ?? guessMime(url), data: bytes };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Could not load the reference image", 400);
  } finally {
    clearTimeout(timer);
  }
}

function guessMime(url: string): string {
  if (url.endsWith(".jpg") || url.endsWith(".jpeg")) return "image/jpeg";
  if (url.endsWith(".webp")) return "image/webp";
  return "image/png";
}
