/**
 * Image provider registry: resolved BYOK/deployment config in, adapter out.
 * The editor never learns which vendor produced an image — capabilities and
 * results flow through the common ImageGenerationProvider interface.
 */

import type { ProviderConfig } from "@/server/providerSession";
import { createCustomImageProvider } from "./providers/customImage";
import { createGeminiProvider } from "./providers/gemini";
import { createGenericRestProvider } from "./providers/genericRest";
import { createSdnextProvider } from "./providers/sdnext";
import type { ImageGenerationProvider } from "./types";

export function createImageProvider(config: ProviderConfig): ImageGenerationProvider {
  switch (config.providerType) {
    case "custom":
      // The universal type: a declarative API description, not a vendor.
      return createCustomImageProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    case "sdnext":
      return createSdnextProvider(config);
    case "openai-compatible":
    case "generic-rest":
      return createGenericRestProvider(config);
    default:
      throw new Error(`Unsupported image provider type: ${config.providerType}`);
  }
}
