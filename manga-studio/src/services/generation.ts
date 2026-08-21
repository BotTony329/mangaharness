"use client";

/**
 * GenerationService — the single application-facing entry for AI generation.
 *
 * UI and the Manga Agent both call THIS module. They never import provider
 * adapters, never hand-roll `/api/generate` or `/api/provider/status` calls,
 * and never see protocol/credential details — those stay server-side in
 * `ai/providerRegistry` + `app/api/*`.
 *
 * Implementation lives in `ai/clientGeneration` (one write path, unchanged);
 * this facade names the boundary so both callers depend on a service, not on
 * an `ai/` internal.
 */

import {
  callGenerateApi,
  storeGeneratedAsset,
  type StoreGeneratedAssetInput,
} from "@/ai/clientGeneration";
import type { GeneratedAssetType } from "@/ai/types";
import type { ProviderSummary } from "@/server/providerSession";

export {
  GenerationApiError,
  CharacterTransparencyError,
  measureImage,
  recordFailedGeneration,
} from "@/ai/clientGeneration";
export type {
  GenerateApiResult,
  GenerationErrorDetails,
  StoreGeneratedAssetInput,
} from "@/ai/clientGeneration";

export interface GenerateImageRequest {
  assetType: GeneratedAssetType;
  prompt: string;
  negativePrompt?: string;
  referenceUrls?: string[];
  size?: "portrait" | "landscape" | "square";
  expectMonochrome?: boolean;
}

/** Call the server generation route. Provider identity stays server-side. */
export function generateImage(request: GenerateImageRequest) {
  return callGenerateApi(request);
}

/** Register a generated image as a library asset with provenance. */
export function registerGeneratedAsset(input: StoreGeneratedAssetInput) {
  return storeGeneratedAsset(input);
}

export interface ProviderCapabilities {
  referenceImage?: boolean;
  supportsTransparentBackground?: boolean;
  supportsReferenceImage?: boolean;
}

export interface ProviderStatusSnapshot {
  image?: ProviderSummary & { capabilities?: ProviderCapabilities };
  agent?: ProviderSummary;
  background?: ProviderSummary;
  /** Legacy top-level mirror of image.configured. */
  configured: boolean;
  capabilities?: ProviderCapabilities;
  storage?: { configured?: boolean; backend?: string };
}

/** Safe provider status: configured flags + capabilities, never key material. */
export async function fetchProviderStatus(): Promise<ProviderStatusSnapshot> {
  const response = await fetch("/api/provider/status");
  if (!response.ok) throw new Error("Provider status unavailable");
  return (await response.json()) as ProviderStatusSnapshot;
}

/** Capabilities of the connected image provider; all-false when unreachable. */
export async function imageProviderCapabilities(): Promise<{
  referenceImage: boolean;
  nativeTransparency: boolean;
}> {
  try {
    const status = await fetchProviderStatus();
    return {
      referenceImage: Boolean(status.capabilities?.referenceImage),
      nativeTransparency: Boolean(status.capabilities?.supportsTransparentBackground),
    };
  } catch {
    return { referenceImage: false, nativeTransparency: false };
  }
}
