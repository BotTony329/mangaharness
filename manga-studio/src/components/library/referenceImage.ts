import { MAX_UPLOAD_BYTES } from "@/storage/imageValidation";

export const REFERENCE_ACCEPT = ["image/png", "image/jpeg", "image/webp"] as const;

export interface ReferenceImageSelection {
  kind: "upload";
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export function validateReferenceFileBasics(file: Pick<File, "size" | "type">): string | null {
  if (!REFERENCE_ACCEPT.includes(file.type as (typeof REFERENCE_ACCEPT)[number])) {
    return "Unsupported image format. Use PNG, JPG, or WEBP.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Image is too large. Maximum size: ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

export async function inspectReferenceImage(file: File): Promise<Omit<ReferenceImageSelection, "previewUrl">> {
  const basicError = validateReferenceFileBasics(file);
  if (basicError) throw new Error(basicError);

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("This file could not be read as an image.");
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (dimensions.width < 4 || dimensions.height < 4 || dimensions.width > 8192 || dimensions.height > 8192) {
    throw new Error("Image dimensions must be between 4 and 8192 pixels.");
  }
  return { kind: "upload", file, ...dimensions };
}
