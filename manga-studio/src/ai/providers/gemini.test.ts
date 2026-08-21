import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "./gemini";

const provider = () =>
  createGeminiProvider({
    apiKey: "user-key-that-must-not-leak",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-image-model",
  });

const request = {
  prompt: "a manga character",
  assetType: "character" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("Gemini image generation adapter", () => {
  it("parses a successful normalized image result and traces the outbound boundary", async () => {
    const stages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] } }],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await provider().generateImage({ ...request, trace: (stage) => stages.push(stage) });
    expect(result.mimeType).toBe("image/png");
    expect(result.data.length).toBeGreaterThan(0);
    expect(stages).toEqual(["outbound_request_start", "outbound_response_received", "provider_response_parsed"]);
  });

  it("serializes a validated reference image as Gemini inline data", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts[0]).toEqual({
        inline_data: { mime_type: "image/png", data: Buffer.from("ref").toString("base64") },
      });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "iVBORw0KGgo=" } }] } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await provider().generateImage({
      ...request,
      referenceImages: [{ mimeType: "image/png", data: Buffer.from("ref") }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("implements second-pass editing with the source image and cutout instruction", async () => {
    const stages: { stage: string; operation?: string }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts[0].inline_data.data).toBe(Buffer.from("opaque source").toString("base64"));
      expect(body.contents[0].parts[1].text).toContain("transparent background");
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await provider().editImage!({
      instruction: "Return the character on a transparent background",
      image: { mimeType: "image/jpeg", data: Buffer.from("opaque source") },
      trace: (stage, details) => stages.push({ stage, operation: String(details?.operation ?? "") }),
    });

    expect(stages[0]).toEqual({ stage: "outbound_request_start", operation: "edit_image" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed and image-less responses safely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(provider().generateImage(request)).rejects.toMatchObject({ safeMessage: "Invalid image response from provider" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })));
    await expect(provider().generateImage(request)).rejects.toMatchObject({
      safeMessage: expect.stringContaining("no image"),
    });
  });

  it.each([
    [400, 400, "HTTP 400"],
    [401, 401, "Authentication failed"],
    [403, 401, "Authentication failed"],
    [404, 404, "Model unavailable"],
    [429, 429, "rate limit"],
    [500, 502, "HTTP 500"],
  ])("normalizes provider HTTP %i", async (providerStatus, expectedStatus, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider rejected request", { status: providerStatus })));
    await expect(provider().generateImage(request)).rejects.toMatchObject({
      status: expectedStatus,
      safeMessage: expect.stringContaining(message),
      details: { httpStatus: providerStatus, provider: "Google Gemini" },
    });
  });

  it("normalizes provider timeouts", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortError)));
    await expect(provider().generateImage(request)).rejects.toMatchObject({ status: 504, safeMessage: "Generation timed out" });
  });

  it("redacts a cookie-backed BYOK key echoed by a provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected user-key-that-must-not-leak", { status: 400 })),
    );
    try {
      await provider().generateImage(request);
      throw new Error("Expected provider error");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("user-key-that-must-not-leak");
      expect(error).toMatchObject({ safeMessage: expect.stringContaining("[redacted]") });
    }
  });
});
