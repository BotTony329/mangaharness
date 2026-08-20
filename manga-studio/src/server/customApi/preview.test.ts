/** Regression: the test-console request preview must never leak the key. */

import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../providerSession";
import { buildRequestPreview } from "./preview";

const API_KEY = "sk-super-secret-key-123456";

function customImageConfig(overrides: Partial<NonNullable<ProviderConfig["custom"]>> = {}): ProviderConfig {
  return {
    kind: "image",
    providerType: "custom",
    name: "Weird",
    baseUrl: "https://api.example.com/generate",
    apiKey: API_KEY,
    model: "img-1",
    custom: {
      method: "POST",
      auth: { mode: "header", header: "X-Weird-Key" },
      headers: [{ name: "X-Trace", value: "on" }],
      requestTemplate: '{"engine":"{{model}}","description":"{{prompt}}"}',
      response: { type: "url", path: "result.files[0].link" },
      referenceMode: "none",
      execution: "sync",
      ...overrides,
    },
  };
}

describe("buildRequestPreview", () => {
  it("renders the request with sample values and redacts auth headers", () => {
    const preview = buildRequestPreview(customImageConfig())!;
    expect(preview.method).toBe("POST");
    expect(preview.url).toContain("api.example.com");
    expect(preview.headers["X-Weird-Key"]).toBe("[REDACTED]");
    expect(preview.headers["X-Trace"]).toBe("on"); // non-secret headers stay visible
    expect((preview.body as Record<string, unknown>).engine).toBe("img-1");
    expect(JSON.stringify(preview)).not.toContain(API_KEY);
  });

  it("redacts bearer auth and any key echoed into the body", () => {
    const config = customImageConfig({
      auth: { mode: "bearer" },
      // Pathological template that would put the key in the body via a
      // header value — the scrubber must still catch the literal key.
      headers: [{ name: "X-Echo", value: API_KEY }],
    });
    const preview = buildRequestPreview(config)!;
    expect(preview.headers.Authorization).toBe("[REDACTED]");
    expect(JSON.stringify(preview)).not.toContain(API_KEY);
  });

  it("returns null for non-custom providers and broken templates", () => {
    const preset: ProviderConfig = {
      kind: "agent",
      providerType: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: API_KEY,
      model: "deepseek-chat",
    };
    expect(buildRequestPreview(preset)).toBeNull();
    expect(buildRequestPreview(customImageConfig({ requestTemplate: "not json" }))).toBeNull();
  });
});
