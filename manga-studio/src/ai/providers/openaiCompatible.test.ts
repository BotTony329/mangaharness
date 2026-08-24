/**
 * OpenAI-compatible adapter contract tests: capability-gated payload
 * construction, pre-call validation, response normalization and error
 * mapping — all with a stubbed fetch, no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilitiesForModel } from "../imageModels";
import { ProviderError, type ImageGenerationRequest } from "../types";
import { buildImagePayload, createGenericRestProvider, parseImageResponse } from "./genericRest";

const BASE_REQUEST: Pick<ImageGenerationRequest, "prompt" | "width" | "height"> = {
  prompt: "Running toward camera while carrying a school bag",
  width: 832,
  height: 1216,
};

describe("buildImagePayload — capability gating", () => {
  it("gpt-image-1: payload MUST NOT contain response_format (the reported 400)", () => {
    const payload = buildImagePayload(BASE_REQUEST, "gpt-image-1", capabilitiesForModel("gpt-image-1"));
    expect(payload).not.toHaveProperty("response_format");
    expect(payload.model).toBe("gpt-image-1");
    expect(payload.size).toBe("1024x1536"); // snapped, portrait preserved
  });

  it("gpt-image-1: transparent background is sent natively", () => {
    const payload = buildImagePayload(
      { ...BASE_REQUEST, transparentBackground: true },
      "gpt-image-1",
      capabilitiesForModel("gpt-image-1"),
    );
    expect(payload.background).toBe("transparent");
    expect(payload.output_format).toBe("png");
    expect(payload).not.toHaveProperty("response_format");
  });

  it("dall-e-3: response_format IS sent (the model supports it)", () => {
    const payload = buildImagePayload(BASE_REQUEST, "dall-e-3", capabilitiesForModel("dall-e-3"));
    expect(payload.response_format).toBe("b64_json");
  });

  it("unknown gateway model: legacy response_format shape preserved", () => {
    const payload = buildImagePayload(BASE_REQUEST, "flux-schnell", capabilitiesForModel("flux-schnell"));
    expect(payload.response_format).toBe("b64_json");
    expect(payload.size).toBe("832x1216"); // unrestricted
  });

  it("capability filtering: unsupported keys are ABSENT, never undefined-valued", () => {
    const payload = buildImagePayload(BASE_REQUEST, "gpt-image-1", capabilitiesForModel("gpt-image-1"));
    expect("response_format" in payload).toBe(false);
    expect("seed" in payload).toBe(false);
    expect("quality" in payload).toBe(false); // not requested → not sent
  });

  it("unsupported feature fails BEFORE any API call: transparent background", () => {
    expect(() =>
      buildImagePayload(
        { ...BASE_REQUEST, transparentBackground: true },
        "dall-e-3",
        capabilitiesForModel("dall-e-3"),
      ),
    ).toThrowError(/does not support transparent background/);
  });

  it("unsupported feature fails BEFORE any API call: reference images", () => {
    expect(() =>
      buildImagePayload(
        { ...BASE_REQUEST, referenceImages: [{ mimeType: "image/png", data: Buffer.from("x") }] },
        "dall-e-3",
        capabilitiesForModel("dall-e-3"),
      ),
    ).toThrowError(/does not support reference images/);
  });
});

describe("parseImageResponse — normalization", () => {
  const png = Buffer.from("fake-png").toString("base64");

  it("b64_json response → bytes", async () => {
    const result = await parseImageResponse(
      new Response(JSON.stringify({ data: [{ b64_json: png }] })),
      vi.fn(),
    );
    expect(result.data.toString()).toBe("fake-png");
    expect(result.mimeType).toBe("image/png");
  });

  it("url response → downloaded bytes", async () => {
    const downloader = vi.fn(async () => Buffer.from("downloaded"));
    const result = await parseImageResponse(
      new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/x.png" }] })),
      downloader,
    );
    expect(downloader).toHaveBeenCalledWith("https://cdn.example.com/x.png");
    expect(result.data.toString()).toBe("downloaded");
  });

  it("invalid JSON → ProviderError", async () => {
    await expect(parseImageResponse(new Response("not json"), vi.fn())).rejects.toBeInstanceOf(ProviderError);
  });

  it("empty image result → ProviderError", async () => {
    await expect(parseImageResponse(new Response(JSON.stringify({ data: [] })), vi.fn())).rejects.toThrowError(
      /no image/i,
    );
  });
});

describe("adapter — end-to-end with stubbed fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  function provider(model: string) {
    return createGenericRestProvider({ apiKey: "sk-test-key-1234", baseUrl: "https://api.openai.com", model });
  }

  it("gpt-image-1 request body contains no response_format", async () => {
    const png = Buffer.from("img").toString("base64");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png }] }))) as unknown as {
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      mock: { calls: [RequestInfo | URL, RequestInit?][] };
    };
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider("gpt-image-1").generateImage({ prompt: "a cat", assetType: "prop" });
    expect(result.data.toString()).toBe("img");
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect("response_format" in sentBody).toBe(false);
  });

  it.each([
    [400, 400],
    [401, 401],
    [429, 429],
    [500, 502],
  ])("HTTP %i maps to status %i and never leaks the API key", async (httpStatus, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`bad key sk-test-key-1234`, { status: httpStatus })),
    );
    const error = await provider("gpt-image-1")
      .generateImage({ prompt: "a cat", assetType: "prop" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.status).toBe(expected);
    expect(providerError.safeMessage).not.toContain("sk-test-key-1234");
  });

  it("network failure → 502 ProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hangup"))));
    const error = await provider("gpt-image-1")
      .generateImage({ prompt: "a cat", assetType: "prop" })
      .catch((e: unknown) => e);
    expect((error as ProviderError).status).toBe(502);
  });

  it("declared capabilities come from the registry, not regexes in the adapter", () => {
    expect(provider("gpt-image-1").capabilities.supportsTransparentBackground).toBe(true);
    expect(provider("dall-e-3").capabilities.supportsTransparentBackground).toBe(false);
    expect(provider("anything").capabilities.supportsReferenceImage).toBe(false);
  });
});
