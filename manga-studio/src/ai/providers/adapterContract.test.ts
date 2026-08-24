/**
 * Provider adapter contract: every image adapter must satisfy the same
 * interface discipline so the service layer never learns provider specifics.
 */

import { describe, expect, it } from "vitest";
import type { CustomApiConfig } from "@/server/customApi/config";
import type { ProviderConfig } from "@/server/providerSession";
import type { ImageGenerationProvider } from "../types";
import { createCustomImageProvider } from "./customImage";
import { createGeminiProvider } from "./gemini";
import { createGenericRestProvider } from "./genericRest";

const CUSTOM_API: CustomApiConfig = {
  method: "POST",
  headers: [],
  auth: { mode: "none" },
  requestTemplate: '{"prompt":"{{prompt}}"}',
  referenceMode: "none",
  execution: "sync",
  response: { path: "data[0].b64_json", type: "base64" },
};

function config(providerType: string, model: string): ProviderConfig {
  return {
    kind: "image",
    providerType,
    baseUrl: "https://api.example.com",
    apiKey: "sk-contract-test",
    model,
    ...(providerType === "custom" ? { custom: CUSTOM_API } : {}),
  };
}

const factories: [string, () => ImageGenerationProvider][] = [
  ["openai-compatible", () => createGenericRestProvider(config("openai-compatible", "gpt-image-1"))],
  ["gemini", () => createGeminiProvider(config("gemini", "gemini-2.5-flash-image"))],
  ["custom", () => createCustomImageProvider(config("custom", "anything"))],
];

describe.each(factories)("%s adapter contract", (_name, make) => {
  it("exposes identity, model and a complete capability declaration", () => {
    const provider = make();
    expect(provider.id).toBeTruthy();
    expect(provider.label).toBeTruthy();
    expect(typeof provider.model).toBe("string");
    for (const flag of [
      "textToImage",
      "supportsReferenceImage",
      "supportsTransparentBackground",
      "supportsImageEditing",
      "referenceImage",
      "imageVariation",
      "transparentOutput",
      "asyncGeneration",
    ] as const) {
      expect(typeof provider.capabilities[flag], flag).toBe("boolean");
    }
  });

  it("editImage exists exactly when image editing is declared", () => {
    const provider = make();
    expect(Boolean(provider.editImage)).toBe(provider.capabilities.supportsImageEditing);
  });

  it("generateImage is a function taking the normalized request", () => {
    expect(typeof make().generateImage).toBe("function");
  });
});
