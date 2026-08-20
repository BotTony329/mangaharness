import { afterEach, describe, expect, it, vi } from "vitest";
import { agentErrorFrom, boundedFetch } from "./http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("agent provider HTTP boundary", () => {
  it("aborts at the explicit planner timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const request = boundedFetch("https://example.com/chat", {}, { timeoutMs: 25 });
    const assertion = expect(request).rejects.toMatchObject({ safeMessage: "Agent model timed out while planning.", status: 504 });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("distinguishes a caller-aborted request from timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const request = boundedFetch("https://example.com/chat", {}, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ safeMessage: "Agent planning was cancelled", status: 499 });
  });

  it.each([429, 500])("preserves safe provider HTTP %s metadata", async (status) => {
    const error = await agentErrorFrom(new Response("provider failure", { status }));
    expect(error.providerStatus).toBe(status);
    expect(error.safeMessage).toContain(`HTTP ${status}`);
    expect(error.status).toBe(status === 429 ? 429 : 502);
  });
});
