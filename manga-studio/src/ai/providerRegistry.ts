/**
 * Resolves the configured image provider from environment variables at call
 * time (not module load — serverless env can differ per invocation and tests
 * mutate process.env).
 */

import { createGeminiProvider, geminiConfigFromEnv } from "./providers/gemini";
import { createGenericRestProvider, genericRestConfigFromEnv } from "./providers/genericRest";
import type { ImageGenerationProvider } from "./types";

export function getImageProvider(): ImageGenerationProvider | null {
  const selected = process.env.IMAGE_PROVIDER || "gemini";
  switch (selected) {
    case "gemini": {
      const config = geminiConfigFromEnv();
      return config ? createGeminiProvider(config) : null;
    }
    case "generic-rest": {
      const config = genericRestConfigFromEnv();
      return config ? createGenericRestProvider(config) : null;
    }
    default:
      return null;
  }
}
