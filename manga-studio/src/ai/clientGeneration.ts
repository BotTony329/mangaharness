"use client";

/**
 * Client half of the generation flow, shared by the Generator dialog and the
 * agent executor: call the server API, measure the result, register it as a
 * library asset with provenance. One implementation — no second write path.
 */

import type { AssetCategory, AssetGenerationMetadata, ID } from "@/domain/types";
import {
  BACKGROUND_REMOVAL_FAILED_MESSAGE,
  validateCharacterTransparency,
} from "@/assets/characterAssetContract";
import { useEditorStore } from "@/editor/store";
import type { GeneratedAssetType } from "./types";

export interface GenerateApiResult {
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
  requestId?: string;
}

export interface GenerationErrorDetails {
  provider?: string;
  model?: string;
  endpoint?: string;
  httpStatus?: number;
  stage?: string;
}

/**
 * Runtime evidence ring buffer (v0.3 Patch B live-gate debugging).
 *
 * Contract tests prove WHAT the code would send; they cannot prove what a
 * specific production click sent. Every provider-boundary call and every asset
 * registration is recorded here — sanitized by construction (the client never
 * holds credentials), capped, and exposed read-only at
 * `window.__kumangaGenerationLog` so a live session can be dumped verbatim:
 *
 *   copy(JSON.stringify(window.__kumangaGenerationLog, null, 2))
 *
 * Observability only: records, never alters, the request/response flow.
 */
export interface GenerationEvidence {
  kind: "request" | "response" | "error" | "registration" | "camera-route";
  /** Stamped by recordGenerationEvidence; callers omit it. */
  at?: string;
  [key: string]: unknown;
}

const EVIDENCE_LIMIT = 20;
const generationEvidenceLog: GenerationEvidence[] = [];

export function recordGenerationEvidence(entry: GenerationEvidence): void {
  generationEvidenceLog.push({ ...entry, at: new Date().toISOString() });
  if (generationEvidenceLog.length > EVIDENCE_LIMIT) generationEvidenceLog.shift();
  if (typeof window !== "undefined") {
    (window as unknown as { __kumangaGenerationLog: readonly GenerationEvidence[] }).__kumangaGenerationLog =
      generationEvidenceLog;
  }
}

/** Test/debug access without going through window. */
export function generationEvidence(): readonly GenerationEvidence[] {
  return generationEvidenceLog;
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
  negativePrompt?: string;
  referenceUrls?: string[];
  size?: "portrait" | "landscape" | "square";
  /** Project style is monochrome: the server refuses colour-contaminated results. */
  expectMonochrome?: boolean;
}): Promise<GenerateApiResult> {
  recordGenerationEvidence({
    kind: "request",
    assetType: request.assetType,
    size: request.size,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    referenceUrls: request.referenceUrls ?? [],
    expectMonochrome: request.expectMonochrome,
  });
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
  if (!response.ok) {
    recordGenerationEvidence({
      kind: "error",
      assetType: request.assetType,
      error: body.error ?? "Generation failed",
      requestId: body.requestId,
      details: body.details,
    });
    throw new GenerationApiError(body.error ?? "Generation failed", body.requestId, body.details);
  }
  const result = body as GenerateApiResult;
  recordGenerationEvidence({
    kind: "response",
    assetType: request.assetType,
    provider: result.provider,
    model: result.model,
    hasAlpha: result.hasAlpha,
    backgroundRemoved: result.backgroundRemoved,
    processingStatus: result.processingStatus,
    processingReason: result.processingReason,
    backgroundRemovalMethod: result.backgroundRemovalMethod,
    referenceUsed: result.referenceUsed,
    requestId: result.requestId,
  });
  return result;
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

/** Raised when a generated image cannot become a compositable layer. */
export class CharacterTransparencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterTransparencyError";
  }
}

/** Register a generated image as a source asset + provenance history entry. */
export async function storeGeneratedAsset(input: StoreGeneratedAssetInput): Promise<ID> {
  // Gate BEFORE the asset exists. Creating it first and throwing afterwards
  // left the failed image in the library, where the canvas then rendered its
  // opaque source — the defect this contract exists to prevent.
  const verdict = validateCharacterTransparency({
    category: input.category,
    processingStatus: input.result.processingStatus,
    hasAlpha: input.result.hasAlpha,
    processedImageUrl: input.result.processedImageUrl,
  });
  if (!verdict.valid) {
    recordFailedGeneration(input.assetType, input.prompt, verdict.reason ?? BACKGROUND_REMOVAL_FAILED_MESSAGE);
    throw new CharacterTransparencyError(verdict.reason ?? BACKGROUND_REMOVAL_FAILED_MESSAGE);
  }

  const dims = await measureImage(input.result.url);
  const created = useEditorStore.getState().dispatch({
    type: "create-asset",
    input: {
      category: input.category,
      name: input.name,
      storageUrl: input.result.sourceUrl ?? input.result.url,
      processedImageUrl: input.result.processedImageUrl,
      width: dims.width,
      height: dims.height,
      mimeType: input.result.mimeType,
      hasAlpha: input.result.hasAlpha,
      backgroundRemoved: input.result.backgroundRemoved,
      processingStatus: input.result.processingStatus,
      backgroundRemovalStatus: input.result.processingStatus,
      processingReason: input.result.processingReason,
      backgroundRemovalMethod: input.result.backgroundRemovalMethod,
      backgroundRemovalProvider: input.result.backgroundRemovalProvider,
      metadata: {
        provider: input.result.provider,
        model: input.result.model,
        prompt: input.prompt,
        generatedAt: new Date().toISOString(),
        ...input.metadata,
      },
    },
    generation: {
      status: "succeeded",
      assetType: input.assetType,
      prompt: input.prompt,
      provider: input.result.provider,
      model: input.result.model,
    },
  });
  if (!created.createdId) throw new Error("Generated asset could not be registered");
  recordGenerationEvidence({
    kind: "registration",
    assetId: created.createdId,
    category: input.category,
    assetType: input.assetType,
    name: input.name,
    cameraShot: input.metadata?.cameraShot,
    cameraAngle: input.metadata?.cameraAngle,
    referenceAssetIds: input.metadata?.referenceAssetIds,
  });
  return created.createdId;
}

export function recordFailedGeneration(assetType: GeneratedAssetType, prompt: string, error: string): void {
  useEditorStore.getState().dispatch({
    type: "record-failed-generation",
    record: { status: "failed", assetType, prompt, error },
  });
}
