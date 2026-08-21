import type { GenerationTrace, ProviderStatus } from "@/ai/types";

export interface BackgroundRemovalInput {
  imageUrl?: string;
  imageBytes?: Uint8Array;
  mimeType?: string;
  trace?: GenerationTrace;
}

export interface AlphaValidationResult {
  valid: boolean;
  reason?: string;
}

export interface BackgroundRemovalResult {
  success: boolean;
  processedImage?: Buffer;
  mimeType?: string;
  alphaValidation: AlphaValidationResult;
  providerMetadata: { id: string; name: string; model?: string };
  safeError?: string;
}

/** Independent from image generation: this capability returns a cutout, not new artwork. */
export interface BackgroundRemovalProvider {
  readonly id: string;
  readonly name: string;
  readonly model?: string;
  removeBackground(input: BackgroundRemovalInput): Promise<BackgroundRemovalResult>;
  testConnection?(): Promise<ProviderStatus>;
}
