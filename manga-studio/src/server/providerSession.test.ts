/**
 * BYOK security guards: encryption round-trip and tamper rejection, config
 * validation (SSRF on user endpoints, keep-existing-key flow), and the rule
 * that summaries never carry key material.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./secretBox";
import {
  buildProviderConfig,
  envAgentConfig,
  summarize,
  type ProviderConfig,
} from "./providerSession";

const ENV_KEYS = ["AGENT_API_KEY", "AGENT_API_BASE_URL", "AGENT_MODEL", "APP_ENCRYPTION_KEY"];
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

describe("secretBox (authenticated encryption)", () => {
  it("round-trips plaintext", () => {
    const sealed = sealSecret('{"apiKey":"sk-test-1234"}');
    expect(sealed).not.toContain("sk-test");
    expect(openSecret(sealed)).toBe('{"apiKey":"sk-test-1234"}');
  });

  it("produces distinct ciphertexts per call (random IV)", () => {
    expect(sealSecret("same")).not.toBe(sealSecret("same"));
  });

  it("rejects tampered ciphertext instead of returning garbage", () => {
    const sealed = sealSecret("secret-value");
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(openSecret(tampered)).toBeNull();
    expect(openSecret("not-a-ciphertext")).toBeNull();
  });

  it("cannot decrypt with a different APP_ENCRYPTION_KEY", () => {
    process.env.APP_ENCRYPTION_KEY = "key-one";
    const sealed = sealSecret("secret");
    process.env.APP_ENCRYPTION_KEY = "key-two";
    expect(openSecret(sealed)).toBeNull();
  });
});

describe("buildProviderConfig", () => {
  const payload = {
    kind: "agent" as const,
    providerType: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-user-key-000",
    model: "some-model",
  };

  it("accepts a valid configuration and trims the base URL", () => {
    const config = buildProviderConfig({ ...payload, baseUrl: "https://api.example.com/v1/" }, null);
    expect(config.baseUrl).toBe("https://api.example.com/v1");
    expect(config.apiKey).toBe("sk-user-key-000");
  });

  it("applies known default base URLs (gemini) when omitted", () => {
    const config = buildProviderConfig({ ...payload, providerType: "gemini", baseUrl: undefined }, null);
    expect(config.baseUrl).toContain("generativelanguage.googleapis.com");
  });

  it("SSRF-guards user endpoints", () => {
    delete process.env.ALLOW_PRIVATE_NETWORKS;
    expect(() => buildProviderConfig({ ...payload, baseUrl: "https://169.254.169.254" }, null)).toThrow(
      /private or local/,
    );
  });

  it("rejects provider types that don't belong to the kind", () => {
    expect(() => buildProviderConfig({ ...payload, providerType: "made-up" }, null)).toThrow(/Unsupported/);
  });

  it("keeps the previously stored key when the payload omits it (replace-fields flow)", () => {
    const existing: ProviderConfig = { ...buildProviderConfig(payload, null) };
    const updated = buildProviderConfig({ ...payload, apiKey: undefined, model: "newer-model" }, existing);
    expect(updated.apiKey).toBe("sk-user-key-000");
    expect(updated.model).toBe("newer-model");
  });

  it("requires a key when none exists yet", () => {
    expect(() => buildProviderConfig({ ...payload, apiKey: undefined }, null)).toThrow(/API key/);
  });
});

describe("summaries never leak secrets", () => {
  it("summarize omits apiKey entirely", () => {
    const config = buildProviderConfig(
      {
        kind: "image" as const,
        providerType: "openai-compatible",
        baseUrl: "https://img.example.com/v1",
        apiKey: "sk-super-secret",
        model: "img",
      },
      null,
    );
    const summary = summarize({ config, source: "session" });
    expect(JSON.stringify(summary)).not.toContain("sk-super-secret");
    expect(JSON.stringify(summary)).not.toContain("apiKey");
    expect(summary.configured).toBe(true);
    expect(summary.source).toBe("session");
  });
});

describe("resolution priority", () => {
  it("falls back to deployment env when no session config exists", () => {
    process.env.AGENT_API_KEY = "env-key-000000";
    const env = envAgentConfig();
    expect(env?.providerType).toBe("openai-compatible");
    expect(env?.baseUrl).toBe("https://api.deepseek.com");
  });
});
