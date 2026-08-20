/**
 * Image-generation provider abstraction. The editor never talks to a
 * provider directly — the browser calls our server API, which resolves a
 * provider adapter from environment configuration. Adapters translate the
 * internal request model into provider-specific calls.
 */

export type GeneratedAssetType =
  | "character"
  | "character-pose"
  | "character-expression"
  | "background"
  | "prop";

export type GenerationTraceDetails = Record<string, string | number | boolean | undefined>;
export type GenerationTrace = (stage: string, details?: GenerationTraceDetails) => void;

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  assetType: GeneratedAssetType;
  width?: number;
  height?: number;
  /** Ask capable providers for real alpha output; post-processing still verifies it. */
  transparentBackground?: boolean;
  /** Raw reference images (already fetched & validated by the server layer). */
  referenceImages?: { mimeType: string; data: Buffer }[];
  /** The validated storage URLs of those references (custom APIs in URL mode). */
  referenceUrls?: string[];
  /** Server-only observability hook. It is never serialized or exposed to providers. */
  trace?: GenerationTrace;
}

export interface ImageGenerationResult {
  mimeType: string;
  data: Buffer;
}

export interface ProviderCapabilities {
  textToImage: boolean;
  referenceImage: boolean;
  imageVariation: boolean;
  transparentOutput: boolean;
  asyncGeneration: boolean;
}

export interface ProviderStatus {
  ok: boolean;
  message?: string;
}

export interface ImageGenerationProvider {
  id: string;
  label: string;
  model: string;
  capabilities: ProviderCapabilities;
  testConnection(): Promise<ProviderStatus>;
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

/** Thrown by adapters; `safeMessage` is what may reach the browser. */
export class ProviderError extends Error {
  readonly safeMessage: string;
  readonly status: number;
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    safeMessage: string,
    status = 502,
    details?: Record<string, string | number | boolean>,
  ) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
    this.details = details;
  }
}
