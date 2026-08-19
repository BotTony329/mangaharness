"use client";

/** Client-side upload flow: measure the image, ship the binary, register the asset. */

import { addAsset, type NewAssetInput } from "@/domain/libraryOps";
import type { AssetCategory } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

export async function uploadImageFile(
  file: File,
  category: AssetCategory,
  extra?: Partial<NewAssetInput>,
): Promise<string> {
  const dims = await readImageDimensions(file);

  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/assets/upload", { method: "POST", body: form });
  const body = (await response.json()) as { url?: string; mimeType?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error ?? "Upload failed");

  let createdAssetId = "";
  useEditorStore.getState().commit((doc) => {
    const { doc: next, assetId } = addAsset(doc, {
      category,
      name: file.name.replace(/\.[^.]+$/, ""),
      storageUrl: body.url!,
      width: dims.width,
      height: dims.height,
      mimeType: body.mimeType,
      hasAlpha: body.mimeType === "image/png" || body.mimeType === "image/webp",
      ...extra,
    });
    createdAssetId = assetId;
    return next;
  });
  return createdAssetId;
}

async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("File is not a readable image");
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (dims.width < 4 || dims.height < 4 || dims.width > 8192 || dims.height > 8192) {
    throw new Error("Image dimensions must be between 4 and 8192 pixels");
  }
  return dims;
}
