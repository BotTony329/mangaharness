import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createRemoveBgProvider } from "./removeBg";

afterEach(() => vi.unstubAllGlobals());

describe("remove.bg background-removal adapter", () => {
  it("sends a secret-safe multipart request and validates returned transparency", async () => {
    const output = await transparentSubject();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ "X-Api-Key": "private-user-key" });
      const form = init?.body as FormData;
      expect(form.get("image_file")).toBeInstanceOf(Blob);
      expect(form.get("size")).toBe("auto");
      return new Response(new Uint8Array(output), { status: 200, headers: { "content-type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().removeBackground({ imageBytes: Buffer.from("source"), mimeType: "image/jpeg" });
    expect(result).toMatchObject({
      success: true,
      mimeType: "image/png",
      alphaValidation: { valid: true },
      providerMetadata: { id: "remove-bg" },
    });
    expect(JSON.stringify(result)).not.toContain("private-user-key");
  });

  it("rejects an opaque provider response", async () => {
    const opaque = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(opaque), { status: 200, headers: { "content-type": "image/png" } })));
    const result = await provider().removeBackground({ imageBytes: Buffer.from("source") });
    expect(result).toMatchObject({ success: false, alphaValidation: { valid: false } });
  });

  it("maps provider authentication failures without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-user-key invalid", { status: 403 })));
    await expect(provider().removeBackground({ imageBytes: Buffer.from("source") })).rejects.toMatchObject({
      status: 401,
      safeMessage: "Background-removal authentication failed — check the API key",
    });
  });
});

function provider() {
  return createRemoveBgProvider({
    kind: "background",
    providerType: "remove-bg",
    name: "remove.bg",
    baseUrl: "https://api.remove.bg/v1.0/removebg",
    apiKey: "private-user-key",
    model: "background-removal",
  });
}

async function transparentSubject(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 12, height: 20, channels: 4, background: "black" } }).png().toBuffer(), left: 10, top: 6 }])
    .png()
    .toBuffer();
}
