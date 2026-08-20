import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeProviderUrl, isAllowedReferenceUrl, redactSecrets } from "./security";

const ENV_KEYS = ["GEMINI_API_KEY", "IMAGE_API_KEY", "AGENT_API_KEY", "APP_ENCRYPTION_KEY", "ALLOW_PRIVATE_NETWORKS"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("redactSecrets", () => {
  it("removes configured secret values from text", () => {
    process.env.GEMINI_API_KEY = "AIzaSySECRETSECRETSECRET";
    const message = `401 for key AIzaSySECRETSECRETSECRET at endpoint`;
    expect(redactSecrets(message)).not.toContain("AIzaSySECRETSECRETSECRET");
    expect(redactSecrets(message)).toContain("[redacted]");
  });

  it("redacts bearer tokens and key query params defensively", () => {
    const message = "Authorization: Bearer sk-abcdef1234567890 x-api-key: abcdefghijklmnop url?key=abcdefghijklmnopqrstuv";
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain("sk-abcdef1234567890");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });

  it("redacts the application encryption key from any server diagnostic", () => {
    process.env.APP_ENCRYPTION_KEY = "operator-infrastructure-secret";
    expect(redactSecrets(`failed with operator-infrastructure-secret`)).toBe("failed with [redacted]");
  });
});

describe("assertSafeProviderUrl (SSRF guard)", () => {
  it("accepts public https URLs", () => {
    expect(assertSafeProviderUrl("https://api.deepseek.com").hostname).toBe("api.deepseek.com");
  });

  it.each([
    "https://localhost:8080",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://192.168.1.1",
    "https://172.16.0.1",
    "https://169.254.169.254", // cloud metadata
    "https://metadata.google.internal",
    "https://[::1]:443",
    "https://internal.local",
  ])("rejects private/loopback address %s", (url) => {
    delete process.env.ALLOW_PRIVATE_NETWORKS;
    expect(() => assertSafeProviderUrl(url)).toThrow(/private or local/);
  });

  it("rejects plain http and non-http schemes", () => {
    delete process.env.ALLOW_PRIVATE_NETWORKS;
    expect(() => assertSafeProviderUrl("http://api.example.com")).toThrow(/https/);
    expect(() => assertSafeProviderUrl("file:///etc/passwd")).toThrow();
    expect(() => assertSafeProviderUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("isAllowedReferenceUrl", () => {
  it("allows our own storage locations only", () => {
    expect(isAllowedReferenceUrl("/api/files/uploads/x.png")).toBe(true);
    expect(isAllowedReferenceUrl("https://abc123.public.blob.vercel-storage.com/generated/y.png")).toBe(true);
  });

  it("rejects arbitrary external URLs (no server-side fetch of user URLs)", () => {
    expect(isAllowedReferenceUrl("https://evil.example.com/img.png")).toBe(false);
    expect(isAllowedReferenceUrl("http://abc.public.blob.vercel-storage.com/x.png")).toBe(false);
    expect(isAllowedReferenceUrl("https://fake.public.blob.vercel-storage.com.evil.com/x.png")).toBe(false);
    expect(isAllowedReferenceUrl("file:///etc/passwd")).toBe(false);
  });
});
