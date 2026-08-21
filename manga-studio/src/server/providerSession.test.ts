/**
 * BYOK security guards: encryption round-trip and tamper rejection, config
 * validation (SSRF on user endpoints, keep-existing-key flow), and the rule
 * that summaries never carry key material.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { openSecret, sealSecret } from "./secretBox";
import {
  buildProviderConfig,
  BACKGROUND_COOKIE,
  IMAGE_COOKIE,
  envAgentConfig,
  resolveProvider,
  summarize,
  type ProviderConfig,
} from "./providerSession";

const ENV_KEYS = ["AGENT_API_KEY", "AGENT_API_BASE_URL", "AGENT_MODEL", "APP_ENCRYPTION_KEY", "NODE_ENV"];
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

  it("builds an independent background-removal BYOK configuration", () => {
    const config = buildProviderConfig({
      kind: "background",
      providerType: "remove-bg",
      apiKey: "remove-bg-user-key",
      model: "",
    }, null);
    expect(config).toMatchObject({
      kind: "background",
      providerType: "remove-bg",
      baseUrl: "https://api.remove.bg/v1.0/removebg",
      model: "background-removal",
    });
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

  it("traces successful BYOK retrieval and decryption without exposing the key", () => {
    process.env.APP_ENCRYPTION_KEY = "operator-secret-for-test";
    const config: ProviderConfig = {
      kind: "image",
      providerType: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "user-provider-secret-for-test",
      model: "gemini-image-model",
    };
    const sealed = sealSecret(JSON.stringify(config));
    const request = new NextRequest("https://manga.example/api/generate", {
      headers: { cookie: `${IMAGE_COOKIE}=${sealed}` },
    });
    const events: { stage: string; details?: object }[] = [];
    const resolved = resolveProvider(request, "image", (stage, details) => events.push({ stage, details }));
    const serialized = JSON.stringify(events);

    expect(resolved?.source).toBe("session");
    expect(events.map((event) => event.stage)).toEqual([
      "provider_resolution_start",
      "credential_lookup",
      "encryption_key_checked",
      "credential_decrypted",
      "credential_deserialized",
      "provider_config_loaded",
    ]);
    expect(serialized).not.toContain(config.apiKey);
    expect(serialized).not.toContain(process.env.APP_ENCRYPTION_KEY);
  });

  it("reports a missing production encryption key as a decryption failure, not a leaked exception", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const sealed = sealSecret(JSON.stringify({
      kind: "image",
      providerType: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "user-provider-secret-for-test",
      model: "gemini-image-model",
    }));
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.APP_ENCRYPTION_KEY;
    const request = new NextRequest("https://manga.example/api/generate", {
      headers: { cookie: `${IMAGE_COOKIE}=${sealed}` },
    });
    const stages: { stage: string; details?: object }[] = [];

    expect(resolveProvider(request, "image", (stage, details) => stages.push({ stage, details }))).toBeNull();
    expect(stages).toContainEqual({ stage: "encryption_key_checked", details: { configured: false } });
    expect(stages.map((event) => event.stage)).toContain("credential_decryption_failed");
  });

  it("retrieves a background provider from its own encrypted cookie", () => {
    process.env.APP_ENCRYPTION_KEY = "operator-secret-for-test";
    const config: ProviderConfig = {
      kind: "background",
      providerType: "remove-bg",
      baseUrl: "https://api.remove.bg/v1.0/removebg",
      apiKey: "background-user-key",
      model: "background-removal",
    };
    const request = new NextRequest("https://manga.example/api/assets/remove-background", {
      headers: { cookie: `${BACKGROUND_COOKIE}=${sealSecret(JSON.stringify(config))}` },
    });
    expect(resolveProvider(request, "background")?.config).toEqual(config);
  });
});
