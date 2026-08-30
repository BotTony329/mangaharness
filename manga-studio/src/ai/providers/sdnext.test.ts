/**
 * Unit and contract tests for the SD.Next image provider adapter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../types";
import {
  buildSdnextAuthHeaders,
  buildSdnextImg2ImgPayload,
  buildSdnextTxt2ImgPayload,
  createSdnextProvider,
  listSdnextModels,
  parseSdnextImageResponse,
} from "./sdnext";

describe("buildSdnextAuthHeaders", () => {
  it("returns empty object when no API key is provided", () => {
    expect(buildSdnextAuthHeaders()).toEqual({});
    expect(buildSdnextAuthHeaders("")).toEqual({});
    expect(buildSdnextAuthHeaders("   ")).toEqual({});
  });

  it("encodes username:password as HTTP Basic Auth", () => {
    const headers = buildSdnextAuthHeaders("admin:secret123");
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("passes through existing Basic or Bearer schemes", () => {
    expect(buildSdnextAuthHeaders("Basic YWRtaW46c2VjcmV0MTIz")).toEqual({
      Authorization: "Basic YWRtaW46c2VjcmV0MTIz",
    });
    expect(buildSdnextAuthHeaders("Bearer token_abc")).toEqual({
      Authorization: "Bearer token_abc",
    });
  });

  it("formats single token strings as Bearer token", () => {
    expect(buildSdnextAuthHeaders("my-token-123")).toEqual({
      Authorization: "Bearer my-token-123",
    });
  });
});

describe("buildSdnextTxt2ImgPayload", () => {
  it("builds a standard txt2img payload with defaults", () => {
    const payload = buildSdnextTxt2ImgPayload({
      prompt: "manga hero, line art",
      negativePrompt: "low quality, blurry",
      width: 832,
      height: 1216,
    });
    expect(payload.prompt).toBe("manga hero, line art");
    expect(payload.negative_prompt).toBe("low quality, blurry");
    expect(payload.width).toBe(832);
    expect(payload.height).toBe(1216);
    expect(payload.steps).toBe(20);
    expect(payload.cfg_scale).toBe(7.0);
    expect(payload.send_images).toBe(true);
    expect(payload.save_images).toBe(false);
    expect(payload.override_settings).toBeUndefined();
  });

  it("includes model checkpoint override when model is specified", () => {
    const payload = buildSdnextTxt2ImgPayload(
      { prompt: "manga panel", width: 512, height: 512 },
      "animagine-xl-3.1.safetensors",
    );
    expect(payload.override_settings).toEqual({
      sd_model_checkpoint: "animagine-xl-3.1.safetensors",
    });
  });
});

describe("buildSdnextImg2ImgPayload", () => {
  it("throws ProviderError when reference images array is empty", () => {
    expect(() =>
      buildSdnextImg2ImgPayload({
        prompt: "same character smiling",
        referenceImages: [],
      }),
    ).toThrowError(/at least one reference image/);
  });

  it("attaches base64 reference image and sets img2img parameters", () => {
    const refData = Buffer.from("fake-reference-image-bytes");
    const payload = buildSdnextImg2ImgPayload(
      {
        prompt: "same character running",
        negativePrompt: "deformed",
        width: 832,
        height: 1216,
        referenceImages: [{ mimeType: "image/png", data: refData }],
      },
      "manga-model-v2.safetensors",
    );

    expect(payload.init_images).toEqual([refData.toString("base64")]);
    expect(payload.denoising_strength).toBe(0.65);
    expect(payload.prompt).toBe("same character running");
    expect(payload.override_settings).toEqual({
      sd_model_checkpoint: "manga-model-v2.safetensors",
    });
  });
});

describe("parseSdnextImageResponse", () => {
  it("extracts base64 image from images array", async () => {
    const pngB64 = Buffer.from("generated-png-data").toString("base64");
    const response = new Response(JSON.stringify({ images: [pngB64] }));
    const result = await parseSdnextImageResponse(response);
    expect(result.mimeType).toBe("image/png");
    expect(result.data.toString()).toBe("generated-png-data");
  });

  it("strips data URI prefix if present", async () => {
    const raw = Buffer.from("data-uri-png").toString("base64");
    const response = new Response(JSON.stringify({ image: `data:image/png;base64,${raw}` }));
    const result = await parseSdnextImageResponse(response);
    expect(result.data.toString()).toBe("data-uri-png");
  });

  it("throws ProviderError on empty result or invalid JSON", async () => {
    await expect(parseSdnextImageResponse(new Response(JSON.stringify({ images: [] })))).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(parseSdnextImageResponse(new Response("invalid json"))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("createSdnextProvider — operations & capabilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    kind: "image" as const,
    providerType: "sdnext",
    baseUrl: "https://sdnext.example.com",
    apiKey: "user:secret",
    model: "test-model.safetensors",
  };

  it("declares expected SD.Next capabilities", () => {
    const provider = createSdnextProvider(config);
    expect(provider.id).toBe("sdnext");
    expect(provider.capabilities.textToImage).toBe(true);
    expect(provider.capabilities.supportsReferenceImage).toBe(true);
    expect(provider.capabilities.supportsImageEditing).toBe(true);
    expect(provider.capabilities.supportsTransparentBackground).toBe(false);
    expect(provider.capabilities.reference.transport).toBe("json-inline-base64");
  });

  it("testConnection returns ok when SD.Next responds with 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ sd_model_checkpoint: "test-model" }), { status: 200 })),
    );

    const provider = createSdnextProvider(config);
    const status = await provider.testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("Connected to SD.Next");
  });

  it("generateImage calls txt2img when without references", async () => {
    const pngB64 = Buffer.from("txt2img-result").toString("base64");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images: [pngB64] }))) as unknown as {
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      mock: { calls: [RequestInfo | URL, RequestInit?][] };
    };
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSdnextProvider(config);
    const result = await provider.generateImage({
      prompt: "manga hero",
      assetType: "character",
      width: 832,
      height: 1216,
    });

    expect(result.data.toString()).toBe("txt2img-result");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sdapi/v1/txt2img");
    expect(init?.headers).toMatchObject({
      Authorization: "Basic dXNlcjpzZWNyZXQ=",
    });
    const parsedBody = JSON.parse(String(init?.body));
    expect(parsedBody.prompt).toBe("manga hero");
    expect(parsedBody.override_settings).toEqual({ sd_model_checkpoint: "test-model.safetensors" });
  });

  it("generateImage calls img2img when references are provided", async () => {
    const pngB64 = Buffer.from("img2img-result").toString("base64");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images: [pngB64] }))) as unknown as {
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      mock: { calls: [RequestInfo | URL, RequestInit?][] };
    };
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSdnextProvider(config);
    const result = await provider.generateImage({
      prompt: "manga hero pose 2",
      assetType: "character-pose",
      referenceImages: [{ mimeType: "image/png", data: Buffer.from("ref-bytes") }],
    });

    expect(result.data.toString()).toBe("img2img-result");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sdapi/v1/img2img");
    const parsedBody = JSON.parse(String(init?.body));
    expect(parsedBody.init_images).toEqual([Buffer.from("ref-bytes").toString("base64")]);
  });

  it("editImage calls img2img with instruction prompt and image", async () => {
    const pngB64 = Buffer.from("edited-result").toString("base64");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images: [pngB64] }))) as unknown as {
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      mock: { calls: [RequestInfo | URL, RequestInit?][] };
    };
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSdnextProvider(config);
    expect(provider.editImage).toBeDefined();
    const result = await provider.editImage!({
      instruction: "change eye color to blue",
      image: { mimeType: "image/png", data: Buffer.from("orig-image") },
    });

    expect(result.data.toString()).toBe("edited-result");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sdapi/v1/img2img");
    const parsedBody = JSON.parse(String(init?.body));
    expect(parsedBody.prompt).toBe("change eye color to blue");
  });

  it("listSdnextModels fetches and formats model names from /sdapi/v1/sd-models", async () => {
    const modelsData = [
      { title: "animagine-xl-3.1.safetensors [abc1234]", model_name: "animagine-xl-3.1" },
      { title: "pony-diffusion-v6.safetensors", model_name: "pony-diffusion-v6" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(modelsData), { status: 200 })),
    );

    const models = await listSdnextModels(config);
    expect(models).toEqual([
      "animagine-xl-3.1.safetensors [abc1234]",
      "pony-diffusion-v6.safetensors",
    ]);
  });
});
