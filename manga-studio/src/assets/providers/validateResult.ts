import { validateTransparentImageBytes } from "@/assets/postProcessor";
import type { BackgroundRemovalResult } from "./types";

export async function validatedProviderResult(input: {
  data: Buffer;
  mimeType: string;
  id: string;
  name: string;
  model?: string;
}): Promise<BackgroundRemovalResult> {
  const validation = await validateTransparentImageBytes(input.data, `provider:${input.id}`, input.id);
  return validation.processingStatus === "ready"
    ? {
        success: true,
        processedImage: validation.processedData,
        mimeType: "image/png",
        alphaValidation: { valid: true },
        providerMetadata: { id: input.id, name: input.name, model: input.model },
      }
    : {
        success: false,
        alphaValidation: { valid: false, reason: validation.reason },
        providerMetadata: { id: input.id, name: input.name, model: input.model },
        safeError: validation.reason ?? "Background-removal provider returned an unusable cutout",
      };
}
