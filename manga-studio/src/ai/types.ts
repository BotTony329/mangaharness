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

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  assetType: GeneratedAssetType;
  width?: number;
  height?: number;
  /** Raw reference images (already fetched & validated by the server layer). */
  referenceImages?: { mimeType: string; data: Buffer }[];
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

  constructor(safeMessage: string, status = 502) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
  }
}
