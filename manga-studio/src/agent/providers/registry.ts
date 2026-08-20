/** Agent provider registry: config in, model-agnostic provider out. */

import type { ProviderConfig } from "@/server/providerSession";
import { createAnthropicCompatibleAgent } from "./anthropicCompatible";
import { createCustomAgentProvider } from "./customAgent";
import { createGeminiAgent } from "./gemini";
import { createOpenAiCompatibleAgent } from "./openaiCompatible";
import type { AgentModelProvider } from "./types";

export function createAgentProvider(config: ProviderConfig): AgentModelProvider {
  switch (config.providerType) {
    case "custom":
      // The universal type: a declarative API description, not a vendor.
      return createCustomAgentProvider(config);
    case "openai-compatible":
      return createOpenAiCompatibleAgent(config);
    case "gemini":
      return createGeminiAgent(config);
    case "anthropic-compatible":
      return createAnthropicCompatibleAgent(config);
    default:
      throw new Error(`Unsupported agent provider type: ${config.providerType}`);
  }
}
