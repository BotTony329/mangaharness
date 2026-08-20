/**
 * Server-side generation service: validates requests, gathers reference
 * images from our own storage, invokes the configured provider, and persists
 * the result to object storage. This module is the only place where provider
 * output crosses into stored assets.
 */

import { z } from "zod";
import type { ProviderConfig } from "@/server/providerSession";
import { readLocalObject, putObject } from "@/storage/objectStore";
import { createImageProvider } from "./providerRegistry";
import { isAllowedReferenceUrl } from "./security";
import { ProviderError, type GeneratedAssetType } from "./types";

export const generateRequestSchema = z.object({
  assetType: z.enum(["character", "character-pose", "character-expression", "background", "prop"]),
  prompt: z.string().min(3).max(4000),
  negativePrompt: z.string().max(1000).optional(),
  referenceUrls: z.array(z.string().max(2048)).max(3).optional(),
  size: z.enum(["portrait", "landscape", "square"]).optional(),
});

export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;

export interface GenerateResult {
  url: string;
  mimeType: string;
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
): Promise<GenerateResult> {
  if (!config) {
    throw new ProviderError("No image provider connected. Open AI Settings to add one.", 503);
  }
  const provider = createImageProvider(config);

  // References are only sent when the provider actually supports them —
  // the UI must never pretend identity preservation happens when it can't.
  const referenceImages = provider.capabilities.referenceImage
    ? await loadReferences(input.referenceUrls ?? [])
    : [];

  const size = SIZE_MAP[input.size ?? "portrait"];
  const result = await provider.generateImage({
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    assetType: input.assetType as GeneratedAssetType,
    width: size.width,
    height: size.height,
    referenceImages,
  });

  if (result.data.length === 0) throw new ProviderError("Invalid image response");

  const extension = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/webp" ? "webp" : "png";
  const stored = await putObject(`generated/${crypto.randomUUID()}.${extension}`, result.data, result.mimeType);

  return {
    url: stored.url,
    mimeType: result.mimeType,
    provider: provider.id,
    model: provider.model,
    referenceUsed: referenceImages.length > 0,
  };
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
