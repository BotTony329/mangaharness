/**
 * Unit and contract tests for the SD.Next background-removal (rembg) provider adapter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createSdnextBackgroundRemovalProvider } from "./sdnext";

afterEach(() => vi.unstubAllGlobals());

describe("SD.Next rembg background-removal adapter", () => {
  it("sends JSON request to /sdapi/v1/extra-single-image and validates transparency", async () => {
    const output = await transparentSubject();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/sdapi/v1/extra-single-image");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Basic dXNlcjpzZWNyZXQ=",
      });
      const parsedBody = JSON.parse(String(init?.body));
      expect(parsedBody.rembg_model).toBe("u2net");
      expect(parsedBody.image).toBe(Buffer.from("source-bytes").toString("base64"));
      return new Response(
        JSON.stringify({ image: output.toString("base64") }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().removeBackground({
      imageBytes: Buffer.from("source-bytes"),
      mimeType: "image/png",
    });

    expect(result).toMatchObject({
      success: true,
      mimeType: "image/png",
      alphaValidation: { valid: true },
      providerMetadata: { id: "sdnext", name: "SD.Next (rembg)", model: "u2net" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects an opaque provider response", async () => {
    const opaque = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ image: opaque.toString("base64") }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await provider().removeBackground({ imageBytes: Buffer.from("source-bytes") });
    expect(result).toMatchObject({ success: false, alphaValidation: { valid: false } });
  });

  it("maps authentication failures properly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    await expect(provider().removeBackground({ imageBytes: Buffer.from("source") })).rejects.toMatchObject({
      status: 401,
      safeMessage: "Authentication failed — check SD.Next credentials",
    });
  });

  it("testConnection returns ok when options endpoint answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const status = await provider().testConnection?.();
    expect(status?.ok).toBe(true);
    expect(status?.message).toContain("Connected to SD.Next");
  });
});

function provider() {
  return createSdnextBackgroundRemovalProvider({
    kind: "background",
    providerType: "sdnext",
    name: "SD.Next (rembg)",
    baseUrl: "https://sdnext.example.com",
    apiKey: "user:secret",
    model: "u2net",
  });
}

async function transparentSubject(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      {
        input: await sharp({ create: { width: 12, height: 20, channels: 4, background: "black" } })
          .png()
          .toBuffer(),
        left: 10,
        top: 6,
      },
    ])
    .png()
    .toBuffer();
}
