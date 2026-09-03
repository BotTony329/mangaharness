/**
 * Runtime evidence capture — the live-gate instrumentation must record what
 * the provider boundary actually saw, without altering behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGenerateApi, generationEvidence, recordGenerationEvidence } from "./clientGeneration";

describe("generation evidence capture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records the sanitized request and the response facts for a real call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            url: "https://example.com/out.png",
            sourceUrl: "https://example.com/out.png",
            mimeType: "image/png",
            hasAlpha: true,
            backgroundRemoved: true,
            processingStatus: "ready",
            provider: "test-provider",
            model: "test-image-model-v1",
            referenceUsed: true,
            requestId: "req-1",
          }),
          { status: 200 },
        ),
      ),
    );
    recordGenerationEvidence({ kind: "camera-route", route: "character", generationCalls: 1 });
    const before = generationEvidence().length;

    await callGenerateApi({
      assetType: "character-pose",
      prompt: "FINAL PROMPT SENT TO PROVIDER",
      referenceUrls: ["https://example.com/ref.png"],
      size: "portrait",
    });

    const entries = generationEvidence().slice(before);
    const request = entries.find((e) => e.kind === "request");
    const response = entries.find((e) => e.kind === "response");
    expect(request?.prompt).toBe("FINAL PROMPT SENT TO PROVIDER");
    expect(request?.referenceUrls).toEqual(["https://example.com/ref.png"]);
    expect(response?.model).toBe("test-image-model-v1");
    expect(response?.hasAlpha).toBe(true);
    expect(response?.backgroundRemoved).toBe(true);
    // Sanitized by construction: no credential fields exist client-side.
    expect(JSON.stringify(entries)).not.toContain("apiKey");
  });

  it("records failures with the error and requestId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "boom", requestId: "req-2" }), { status: 422 }),
      ),
    );
    const before = generationEvidence().length;
    await expect(callGenerateApi({ assetType: "background", prompt: "x" })).rejects.toThrow("boom");
    const error = generationEvidence().slice(before).find((e) => e.kind === "error");
    expect(error?.error).toBe("boom");
    expect(error?.requestId).toBe("req-2");
  });
});
