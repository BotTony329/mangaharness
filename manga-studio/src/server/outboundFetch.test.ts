import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Security-boundary tests for the egress layer: DNS-resolved SSRF targets are
 * rejected, redirects cannot relay a request into private networks, and
 * response bodies are size-capped. DNS is mocked so the suite stays offline
 * and deterministic.
 */

const lookupMock = vi.fn<(hostname: string) => Promise<{ address: string; family: number }[]>>();

vi.mock("node:dns/promises", () => ({
  lookup: (hostname: string) => lookupMock(hostname),
}));

const { outboundFetch, readBodyBytes, readBodyText, isBlockedAddress, UnsafeOutboundUrlError } = await import("./outboundFetch");

function respondPublic(address = "93.184.216.34") {
  lookupMock.mockResolvedValue([{ address, family: 4 }]);
}

beforeEach(() => {
  lookupMock.mockReset();
  respondPublic();
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "172.31.255.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456:789a::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.5",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("outboundFetch SSRF guard", () => {
  it("rejects a public-looking hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(outboundFetch("https://rebound.example.com/v1", { method: "GET" })).rejects.toThrow(UnsafeOutboundUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects every address when DNS returns a mixed public/private answer", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    vi.stubGlobal("fetch", vi.fn());
    await expect(outboundFetch("https://mixed.example.com", { method: "GET" })).rejects.toThrow(UnsafeOutboundUrlError);
    vi.unstubAllGlobals();
  });

  it("does not follow a redirect into a private network", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(outboundFetch("https://api.example.com/v1", { method: "POST", body: "{}" })).rejects.toThrow(
      UnsafeOutboundUrlError,
    );
    // Only the original hop was dialed — the metadata endpoint never was.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("follows redirects to validated public targets", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example.com/file" } }))
      .mockResolvedValueOnce(new Response("payload", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await outboundFetch("https://api.example.com/v1", { method: "GET" });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.lastCall?.[0])).toBe("https://cdn.example.com/file");
    expect(fetchSpy.mock.lastCall?.[1]).toMatchObject({ redirect: "manual" });
    vi.unstubAllGlobals();
  });

  it("stops after the redirect budget and hands the 3xx back to the caller", async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) =>
      new Response(null, { status: 302, headers: { location: `${url}/loop` } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const response = await outboundFetch("https://api.example.com/a", { method: "GET" }, { maxRedirects: 2 });
    expect(response.status).toBe(302);
    // Initial request + 2 followed hops before giving up.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("aborts with AbortError when the deadline expires mid-flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))),
    );
    await expect(outboundFetch("https://api.example.com/slow", { method: "GET" }, { timeoutMs: 20 })).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("readBodyBytes / readBodyText caps", () => {
  it("refuses immediately on an oversized content-length", async () => {
    const response = new Response("x".repeat(10), { headers: { "content-length": String(1024 * 1024) } });
    await expect(readBodyBytes(response, 1024)).rejects.toThrow("allowed size");
  });

  it("aborts the stream once the cap is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(readBodyBytes(response, 1024)).rejects.toThrow("allowed size");
  });

  it("returns merged content under the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello, "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    await expect(readBodyText(new Response(stream), 1024)).resolves.toBe("hello, world");
  });
});
