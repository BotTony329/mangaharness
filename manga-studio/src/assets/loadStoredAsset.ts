import { ProviderError } from "@/ai/types";
import { isAllowedReferenceUrl } from "@/ai/security";
import { readLocalObject } from "@/storage/objectStore";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export async function loadStoredAsset(url: string): Promise<{ data: Buffer; mimeType: string }> {
  if (!isAllowedReferenceUrl(url)) throw new ProviderError("Unsupported asset location", 400);
  if (url.startsWith("/api/files/")) {
    const data = await readLocalObject(url.replace("/api/files/", ""));
    if (!data) throw new ProviderError("Asset source was not found", 404);
    return { data, mimeType: guessMime(url) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new ProviderError("Asset source could not be loaded", 400);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_ASSET_BYTES) throw new ProviderError("Asset source is too large", 413);
    return { data, mimeType: response.headers.get("content-type")?.split(";")[0] ?? guessMime(url) };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Asset source could not be loaded", 400);
  } finally {
    clearTimeout(timer);
  }
}

function guessMime(url: string): string {
  if (/\.jpe?g(?:$|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp(?:$|\?)/i.test(url)) return "image/webp";
  return "image/png";
}
