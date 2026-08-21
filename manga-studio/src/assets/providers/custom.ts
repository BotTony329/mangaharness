import { createCustomImageProvider } from "@/ai/providers/customImage";
import type { ProviderConfig } from "@/server/providerSession";
import type { BackgroundRemovalProvider } from "./types";
import { validatedProviderResult } from "./validateResult";

const CUTOUT_INSTRUCTION = "Extract only the foreground subject. Remove the entire background and return a transparent PNG. Preserve all line art, facial details, clothing, hair, hands and feet. Do not redraw or restyle the subject.";

export function createCustomBackgroundRemovalProvider(config: ProviderConfig): BackgroundRemovalProvider {
  const adapter = createCustomImageProvider(config);
  const id = "custom-background";
  const name = config.name || "Custom Background Removal API";
  return {
    id,
    name,
    model: config.model,
    async removeBackground(input) {
      if (!input.imageBytes) {
        return {
          success: false,
          alphaValidation: { valid: false, reason: "Image bytes are required" },
          providerMetadata: { id, name, model: config.model },
          safeError: "Background-removal input was unavailable",
        };
      }
      const result = await adapter.generateImage({
        prompt: CUTOUT_INSTRUCTION,
        assetType: "character",
        referenceImages: [{ mimeType: input.mimeType ?? "image/png", data: Buffer.from(input.imageBytes) }],
        referenceUrls: input.imageUrl ? [input.imageUrl] : undefined,
        trace: input.trace,
      });
      return validatedProviderResult({ data: result.data, mimeType: result.mimeType, id, name, model: config.model });
    },
    testConnection: () => adapter.testConnection(),
  };
}
