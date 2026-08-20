/**
 * Upload validation. Filenames and client-reported MIME types are untrusted;
 * the file's magic bytes decide what it is.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface DetectedImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: string;
}

export function detectImageType(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (riff && webp) return { mimeType: "image/webp", extension: "webp" };
  return null;
}
