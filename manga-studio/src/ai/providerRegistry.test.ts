import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/server/providerSession";
import { envImageConfig } from "@/server/providerSession";
import { createImageProvider } from "./providerRegistry";
import { generateAssetImage, generateRequestSchema } from "./generate";
import { ProviderError } from "./types";

const ENV_KEYS = ["IMAGE_PROVIDER", "GEMINI_API_KEY", "IMAGE_API_KEY", "IMAGE_API_BASE_URL", "IMAGE_MODEL"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function config(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    kind: "image",
    providerType: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "test-key-not-real-0000",
    model: "gemini-2.5-flash-image",
    ...overrides,
  };
}

describe("image provider registry (BYOK config-driven)", () => {
  it("builds a Gemini adapter with reference-image capability", () => {
    const provider = createImageProvider(config({}));
    expect(provider.id).toBe("gemini");
    expect(provider.capabilities.referenceImage).toBe(true);
  });

  it("builds the OpenAI-compatible REST adapter (honest: no reference images)", () => {
    const provider = createImageProvider(
      config({ providerType: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "img-model" }),
    );
    expect(provider.id).toBe("generic-rest");
    expect(provider.capabilities.referenceImage).toBe(false);
  });

  it("rejects unknown provider types", () => {
    expect(() => createImageProvider(config({ providerType: "midjourney" }))).toThrow(/Unsupported/);
  });

  it("REST adapter refuses private base URLs (SSRF)", () => {
    delete process.env.ALLOW_PRIVATE_NETWORKS;
    expect(() =>
      createImageProvider(config({ providerType: "openai-compatible", baseUrl: "https://169.254.169.254/latest" })),
    ).toThrow(/private or local/);
  });
});

describe("deployment env fallback", () => {
  it("returns null with no env configuration", () => {
    expect(envImageConfig()).toBeNull();
  });

  it("maps Gemini env vars to a config", () => {
    process.env.GEMINI_API_KEY = "test-key-not-real-0000";
    process.env.IMAGE_MODEL = "gemini-3-pro-image-preview";
    const cfg = envImageConfig();
    expect(cfg?.providerType).toBe("gemini");
    expect(cfg?.model).toBe("gemini-3-pro-image-preview");
  });
});

describe("generation service", () => {
  it("fails safely when no provider is connected", async () => {
    await expect(generateAssetImage({ assetType: "background", prompt: "a classroom" }, null)).rejects.toMatchObject({
      safeMessage: expect.stringContaining("AI Settings"),
    });
  });

  it("rejects reference URLs outside our storage", async () => {
    await expect(
      generateAssetImage(
        {
          assetType: "character-pose",
          prompt: "Akari running",
          referenceUrls: ["https://evil.example.com/steal.png"],
        },
        config({}),
      ),
    ).rejects.toMatchObject({ safeMessage: expect.stringContaining("reference") });
  });

  it("request schema rejects malformed payloads", () => {
    expect(generateRequestSchema.safeParse({ assetType: "spaceship", prompt: "x" }).success).toBe(false);
    expect(generateRequestSchema.safeParse({ assetType: "prop" }).success).toBe(false);
    expect(
      generateRequestSchema.safeParse({ assetType: "prop", prompt: "a school bag", size: "portrait" }).success,
    ).toBe(true);
    expect(generateRequestSchema.safeParse({ assetType: "prop", prompt: "x".repeat(5000) }).success).toBe(false);
  });

  it("ProviderError carries a safe message and status", () => {
    const error = new ProviderError("Authentication failed", 401);
    expect(error.safeMessage).toBe("Authentication failed");
    expect(error.status).toBe(401);
  });
});
