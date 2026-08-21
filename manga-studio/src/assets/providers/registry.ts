import type { ProviderConfig } from "@/server/providerSession";
import { createCustomBackgroundRemovalProvider } from "./custom";
import { createRemoveBgProvider } from "./removeBg";
import type { BackgroundRemovalProvider } from "./types";

export function createBackgroundRemovalProvider(config: ProviderConfig): BackgroundRemovalProvider {
  if (config.providerType === "custom") return createCustomBackgroundRemovalProvider(config);
  if (config.providerType === "remove-bg") return createRemoveBgProvider(config);
  throw new Error(`Unsupported background-removal provider type: ${config.providerType}`);
}
