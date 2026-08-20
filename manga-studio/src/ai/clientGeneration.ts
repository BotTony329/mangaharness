"use client";

/**
 * Client half of the generation flow, shared by the Generator dialog and the
 * agent executor: call the server API, measure the result, register it as a
 * library asset with provenance. One implementation — no second write path.
 */

import { addAsset, addGenerationRecord } from "@/domain/libraryOps";
import type { AssetCategory, AssetGenerationMetadata, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import type { GeneratedAssetType } from "./types";

export interface GenerateApiResult {
  url: string;
  mimeType: string;
  provider: string;
  model: string;
  referenceUsed: boolean;
  requestId?: string;
}

export interface GenerationErrorDetails {
  provider?: string;
  model?: string;
  endpoint?: string;
  httpStatus?: number;
  stage?: string;
}

export class GenerationApiError extends Error {
  readonly requestId?: string;
  readonly details?: GenerationErrorDetails;

  constructor(message: string, requestId?: string, details?: GenerationErrorDetails) {
    super(message);
    this.requestId = requestId;
    this.details = details;
  }
}

export async function callGenerateApi(request: {
  assetType: GeneratedAssetType;
  prompt: string;
  referenceUrls?: string[];
  size?: "portrait" | "landscape" | "square";
}): Promise<GenerateApiResult> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    requestId?: string;
    details?: GenerationErrorDetails;
  };
  if (!response.ok) throw new GenerationApiError(body.error ?? "Generation failed", body.requestId, body.details);
  return body as GenerateApiResult;
}

export function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not load the generated image"));
    img.src = url;
  });
}

export interface StoreGeneratedAssetInput {
  result: GenerateApiResult;
  assetType: GeneratedAssetType;
  category: AssetCategory;
  name: string;
  prompt: string;
  metadata?: Partial<AssetGenerationMetadata>;
}

/** Register a generated image as a source asset + provenance history entry. */
export async function storeGeneratedAsset(input: StoreGeneratedAssetInput): Promise<ID> {
  const dims = await measureImage(input.result.url);
  let assetId: ID = "";
  useEditorStore.getState().commit((doc) => {
    const added = addAsset(doc, {
      category: input.category,
      name: input.name,
      storageUrl: input.result.url,
      width: dims.width,
      height: dims.height,
      mimeType: input.result.mimeType,
      metadata: {
        provider: input.result.provider,
        model: input.result.model,
        prompt: input.prompt,
        generatedAt: new Date().toISOString(),
        ...input.metadata,
      },
    });
    assetId = added.assetId;
    return addGenerationRecord(added.doc, {
      status: "succeeded",
      assetType: input.assetType,
      prompt: input.prompt,
      provider: input.result.provider,
      model: input.result.model,
      resultAssetId: added.assetId,
    });
  });
  return assetId;
}

export function recordFailedGeneration(assetType: GeneratedAssetType, prompt: string, error: string): void {
  useEditorStore.getState().commit((doc) =>
    addGenerationRecord(doc, { status: "failed", assetType, prompt, error }),
  );
}
