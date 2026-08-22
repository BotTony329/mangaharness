import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readLocalObject, isBlobConfigured, putObject } from "./objectStore";

const LOCAL_DIR = path.join(process.cwd(), ".data");

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

describe("readLocalObject traversal guard (dev file server)", () => {
  beforeEach(() => {
    delete process.env.VERCEL; // local-dev mode so putObject writes to .data
  });

  afterEach(async () => {
    await fs.rm(path.join(LOCAL_DIR, "traversal-guard"), { recursive: true, force: true });
  });

  it("round-trips a stored object", async () => {
    await putObject("traversal-guard/a.png", Buffer.from("png-bytes"), "image/png");
    await expect(readLocalObject("traversal-guard/a.png")).resolves.toEqual(Buffer.from("png-bytes"));
  });

  it.each([
    "../etc/passwd",
    "../../etc/passwd",
    "traversal-guard/../../secrets.txt",
    // Separator-sensitive case: ".data-notes" is a sibling of ".data", so a
    // bare prefix check would let it through.
    "../.data-notes/secret.png",
  ])("refuses to read outside the storage root: %s", async (key) => {
    await expect(readLocalObject(key)).resolves.toBeNull();
  });
});
