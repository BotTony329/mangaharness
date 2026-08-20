import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBlobConfigured, putObject } from "./objectStore";

const saved = {
  VERCEL: process.env.VERCEL,
  BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
};

beforeEach(() => {
  process.env.VERCEL = "1";
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(() => {
  if (saved.VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = saved.VERCEL;
  if (saved.BLOB_READ_WRITE_TOKEN === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = saved.BLOB_READ_WRITE_TOKEN;
});

describe("production object storage guard", () => {
  it("fails loudly instead of writing generated assets to ephemeral Vercel storage", async () => {
    expect(isBlobConfigured()).toBe(false);
    await expect(putObject("generated/test.png", Buffer.from("image"), "image/png")).rejects.toThrow(
      "Persistent storage is not configured",
    );
  });
});
