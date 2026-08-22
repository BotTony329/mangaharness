import { ProviderError } from "@/ai/types";
import { isAllowedReferenceUrl } from "@/ai/security";
import { outboundFetch, readBodyBytes } from "@/server/outboundFetch";
import { readLocalObject } from "@/storage/objectStore";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export async function loadStoredAsset(url: string): Promise<{ data: Buffer; mimeType: string }> {
  if (!isAllowedReferenceUrl(url)) throw new ProviderError("Unsupported asset location", 400);
  if (url.startsWith("/api/files/")) {
    const data = await readLocalObject(url.replace("/api/files/", ""));
    if (!data) throw new ProviderError("Asset source was not found", 404);
    return { data, mimeType: guessMime(url) };
  }
  try {
    const response = await outboundFetch(url, { method: "GET" }, { timeoutMs: 15_000 });
    if (!response.ok) throw new ProviderError("Asset source could not be loaded", 400);
    const data = Buffer.from(await readBodyBytes(response, MAX_ASSET_BYTES));
    return { data, mimeType: response.headers.get("content-type")?.split(";")[0] ?? guessMime(url) };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Asset source could not be loaded", 400);
  }
}

function guessMime(url: string): string {
  if (/\.jpe?g(?:$|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp(?:$|\?)/i.test(url)) return "image/webp";
  return "image/png";
}
