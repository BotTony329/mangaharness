/**
 * Reference-image contract tests — the guarantee this bug class was missing:
 *
 *   If an adapter declares reference.supported = true, then a generation call
 *   carrying referenceImages MUST produce a provider request that physically
 *   contains the image data. Otherwise the test fails.
 *
 * Covers the three transports: JSON inline (Gemini), multipart file
 * (gpt-image edits), template vars (custom) — plus the conservative
 * unsupported path (unknown compatible model).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomApiConfig } from "@/server/customApi/config";
import type { ProviderConfig } from "@/server/providerSession";
import { ProviderError, type ImageGenerationRequest } from "../types";
import { createCustomImageProvider } from "./customImage";
import { createGeminiProvider } from "./gemini";
import { createGenericRestProvider } from "./genericRest";

const LUCY = Buffer.from("canonical-lucy-png-bytes");
const LUCY_B64 = LUCY.toString("base64");
const REF_REQUEST: ImageGenerationRequest = {
  prompt: "Redraw the exact same manga character, waving",
  assetType: "character-pose",
  width: 832,
  height: 1216,
  referenceImages: [{ mimeType: "image/png", data: LUCY }],
};

const OK_RESPONSE = () =>
  new Response(
    JSON.stringify({ data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64") }] }),
  );

const GEMINI_OK = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("out").toString("base64") } }] } }],
    }),
  );

function baseConfig(providerType: string, model: string, custom?: CustomApiConfig): ProviderConfig {
  return { kind: "image", providerType, baseUrl: "https://api.example.com", apiKey: "sk-contract", model, custom };
}

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return calls;
}

describe("Contract A/B/C: declared reference support ⇒ image physically in the request", () => {
  it("Gemini: reference travels as inline_data base64, separate from the prompt text", async () => {
    const calls = stubFetch(GEMINI_OK);
    await createGeminiProvider(baseConfig("gemini", "gemini-2.5-flash-image")).generateImage(REF_REQUEST);
    const body = JSON.parse(String(calls[0].init.body));
    const parts = body.contents[0].parts;
    const imagePart = parts.find((p: { inline_data?: { data?: string } }) => p.inline_data?.data);
    expect(imagePart.inline_data.data).toBe(LUCY_B64);
    expect(imagePart.inline_data.mime_type).toBe("image/png");
    expect(parts.some((p: { text?: string }) => p.text === REF_REQUEST.prompt)).toBe(true);
  });

  it("gpt-image-1: reference travels as multipart image[] file on /images/edits", async () => {
    const calls = stubFetch(OK_RESPONSE);
    await createGenericRestProvider(baseConfig("openai-compatible", "gpt-image-1")).generateImage(REF_REQUEST);
    expect(calls[0].url).toContain("/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const images = form.getAll("image[]");
    expect(images).toHaveLength(1);
    const bytes = Buffer.from(await (images[0] as Blob).arrayBuffer());
    expect(bytes.equals(LUCY)).toBe(true);
    expect(form.get("prompt")).toBe(REF_REQUEST.prompt);
    // The identity image is a file part, not a sentence in the prompt.
    expect(String(form.get("prompt"))).not.toContain(LUCY_B64);
  });

  it("custom (base64 mode): reference reaches the rendered request template", async () => {
    const custom: CustomApiConfig = {
      method: "POST",
      headers: [],
      auth: { mode: "none" },
      requestTemplate: '{"prompt":"{{prompt}}","ref":"{{referenceImage}}"}',
      referenceMode: "base64",
      execution: "sync",
      response: { path: "data[0].b64_json", type: "base64" },
    };
    const calls = stubFetch(OK_RESPONSE);
    await createCustomImageProvider(baseConfig("custom", "anything", custom)).generateImage(REF_REQUEST);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.ref).toBe(LUCY_B64);
  });
});

describe("Contract D: no reference ⇒ normal text-to-image path", () => {
  it("gpt-image-1 without references uses /images/generations JSON, no response_format", async () => {
    const calls = stubFetch(OK_RESPONSE);
    await createGenericRestProvider(baseConfig("openai-compatible", "gpt-image-1")).generateImage({
      prompt: "a cat",
      assetType: "prop",
    });
    expect(calls[0].url).toContain("/images/generations");
    const body = JSON.parse(String(calls[0].init.body));
    expect("response_format" in body).toBe(false);
  });

  it("Gemini without references sends text-only parts on the same endpoint", async () => {
    const calls = stubFetch(GEMINI_OK);
    await createGeminiProvider(baseConfig("gemini", "gemini-2.5-flash-image")).generateImage({
      prompt: "a cat",
      assetType: "prop",
    });
    expect(calls[0].url).toContain(":generateContent");
    const parts = JSON.parse(String(calls[0].init.body)).contents[0].parts;
    expect(parts.every((p: { text?: string }) => p.text)).toBe(true);
  });
});

describe("Contract E: unsupported reference ⇒ explicit failure, never silent fallback", () => {
  it("unknown compatible model rejects references BEFORE any HTTP call", async () => {
    const calls = stubFetch(OK_RESPONSE);
    await expect(
      createGenericRestProvider(baseConfig("openai-compatible", "some-gateway-model")).generateImage(REF_REQUEST),
    ).rejects.toThrowError(/does not support reference images/);
    expect(calls).toHaveLength(0);
  });

  it("dall-e-3 rejects references as well", async () => {
    const calls = stubFetch(OK_RESPONSE);
    await expect(
      createGenericRestProvider(baseConfig("openai-compatible", "dall-e-3")).generateImage(REF_REQUEST),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe("capability ⇄ implementation binding", () => {
  it("every adapter's supportsReferenceImage flag mirrors its reference contract", () => {
    const custom: CustomApiConfig = {
      method: "POST",
      headers: [],
      auth: { mode: "none" },
      requestTemplate: "{}",
      referenceMode: "url",
      execution: "sync",
      response: { path: "x", type: "url" },
    };
    const providers = [
      createGeminiProvider(baseConfig("gemini", "gemini-2.5-flash-image")),
      createGenericRestProvider(baseConfig("openai-compatible", "gpt-image-1")),
      createGenericRestProvider(baseConfig("openai-compatible", "dall-e-2")),
      createCustomImageProvider(baseConfig("custom", "x", custom)),
    ];
    for (const provider of providers) {
      expect(provider.capabilities.supportsReferenceImage, provider.id).toBe(provider.capabilities.reference.supported);
      if (provider.capabilities.reference.supported) {
        expect(provider.capabilities.reference.transport, provider.id).not.toBe("none");
      }
    }
  });
});
