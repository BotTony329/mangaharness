import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getImageProvider } from "./providerRegistry";
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

describe("provider registry", () => {
  it("returns null when nothing is configured", () => {
    expect(getImageProvider()).toBeNull();
  });

  it("resolves Gemini (default provider) when its key exists", () => {
    process.env.GEMINI_API_KEY = "test-key-not-real-0000";
    const provider = getImageProvider();
    expect(provider?.id).toBe("gemini");
    expect(provider?.model).toBe("gemini-2.5-flash-image");
    expect(provider?.capabilities.referenceImage).toBe(true);
  });

  it("respects IMAGE_MODEL override", () => {
    process.env.GEMINI_API_KEY = "test-key-not-real-0000";
    process.env.IMAGE_MODEL = "gemini-3-pro-image-preview";
    expect(getImageProvider()?.model).toBe("gemini-3-pro-image-preview");
  });

  it("resolves the generic REST provider with base URL + key", () => {
    process.env.IMAGE_PROVIDER = "generic-rest";
    process.env.IMAGE_API_KEY = "test-key-not-real-0000";
    process.env.IMAGE_API_BASE_URL = "https://api.example.com/v1";
    const provider = getImageProvider();
    expect(provider?.id).toBe("generic-rest");
    // Honest capabilities: no reference images through the generic adapter.
    expect(provider?.capabilities.referenceImage).toBe(false);
  });

  it("generic REST refuses private base URLs (SSRF)", () => {
    process.env.IMAGE_PROVIDER = "generic-rest";
    process.env.IMAGE_API_KEY = "test-key-not-real-0000";
    process.env.IMAGE_API_BASE_URL = "https://169.254.169.254/latest";
    expect(() => getImageProvider()).toThrow(/private or local/);
  });
});

describe("generation service", () => {
  it("fails safely when no provider is configured", async () => {
    await expect(
      generateAssetImage({ assetType: "background", prompt: "a classroom" }),
    ).rejects.toMatchObject({ safeMessage: expect.stringContaining("not configured") });
  });

  it("rejects reference URLs outside our storage", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real-0000";
    await expect(
      generateAssetImage({
        assetType: "character-pose",
        prompt: "Akari running",
        referenceUrls: ["https://evil.example.com/steal.png"],
      }),
    ).rejects.toMatchObject({ safeMessage: expect.stringContaining("reference") });
  });

  it("request schema rejects malformed payloads", () => {
    expect(generateRequestSchema.safeParse({ assetType: "spaceship", prompt: "x" }).success).toBe(false);
    expect(generateRequestSchema.safeParse({ assetType: "prop" }).success).toBe(false);
    expect(generateRequestSchema.safeParse({ assetType: "prop", prompt: "ab" }).success).toBe(false);
    expect(
      generateRequestSchema.safeParse({ assetType: "prop", prompt: "a school bag", size: "portrait" }).success,
    ).toBe(true);
    // Prompt length limit.
    expect(generateRequestSchema.safeParse({ assetType: "prop", prompt: "x".repeat(5000) }).success).toBe(false);
  });

  it("ProviderError carries a safe message and status", () => {
    const error = new ProviderError("Authentication failed", 401);
    expect(error.safeMessage).toBe("Authentication failed");
    expect(error.status).toBe(401);
  });
});
