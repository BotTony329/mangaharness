import { afterEach, describe, expect, it, vi } from "vitest";
import { agentErrorFrom, boundedFetch } from "./http";

// These tests exercise abort semantics; the egress boundary's DNS check would
// otherwise hit the real resolver and hang under fake timers.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

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
