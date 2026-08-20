/**
 * Authenticated encryption for user-provided provider credentials
 * (AES-256-GCM via Node's crypto — no custom cryptography). The plaintext
 * only ever exists server-side; the ciphertext travels in an HttpOnly cookie
 * the browser's JavaScript cannot read.
 *
 * APP_ENCRYPTION_KEY is a deployment secret. It does NOT contain any user
 * API key — it only encrypts/decrypts what users enter in AI Settings.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.APP_ENCRYPTION_KEY) || process.env.NODE_ENV !== "production";
}

/**
 * Derive the 32-byte key. Production requires APP_ENCRYPTION_KEY (serverless
 * instances must share it or cookies become undecryptable between requests).
 * Development falls back to a fixed key so `npm run dev` works with zero
 * setup — acceptable only because dev cookies never leave the machine.
 */
function encryptionKey(): Buffer {
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (secret) return createHash("sha256").update(secret).digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_ENCRYPTION_KEY is not set. Add it to the deployment environment to enable AI provider setup.");
  }
  return createHash("sha256").update("manga-studio-dev-only-not-secret").digest();
}

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

/** Returns null for tampered, truncated, or wrong-key ciphertexts. */
export function openSecret(sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const encrypted = raw.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
