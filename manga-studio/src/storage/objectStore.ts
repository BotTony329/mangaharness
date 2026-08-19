/**
 * Server-side object storage for image binaries (uploads + AI generations).
 *
 * Primary backend: Vercel Blob — persistent, CDN-served, CORS-friendly, and
 * zero-config on Vercel (BLOB_READ_WRITE_TOKEN is injected by the platform).
 * Without a token (bare local dev) files fall back to ./.data served by
 * /api/files — dev-only, because serverless filesystems are ephemeral.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface StoredObject {
  url: string;
}

const LOCAL_DIR = path.join(process.cwd(), ".data");

export function isBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function putObject(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
  if (isBlobConfigured()) {
    const { put } = await import("@vercel/blob");
    const blob = await put(key, data, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });
    return { url: blob.url };
  }
  return putLocal(key, data);
}

async function putLocal(key: string, data: Buffer): Promise<StoredObject> {
  if (process.env.VERCEL) {
    // Fail loudly instead of silently writing files that vanish on the next
    // cold start — on Vercel a Blob store must be connected.
    throw new Error("Persistent storage is not configured. Connect a Vercel Blob store to this project.");
  }
  const safeKey = key.replace(/[^a-zA-Z0-9._/-]/g, "_");
  const filePath = path.join(LOCAL_DIR, safeKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return { url: `/api/files/${safeKey}` };
}

export async function readLocalObject(key: string): Promise<Buffer | null> {
  const safePath = path.normalize(path.join(LOCAL_DIR, key));
  // Path traversal guard for the dev file server.
  if (!safePath.startsWith(LOCAL_DIR)) return null;
  try {
    return await fs.readFile(safePath);
  } catch {
    return null;
  }
}
