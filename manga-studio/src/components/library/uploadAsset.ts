"use client";

/** Client-side upload flow: measure the image, ship the binary, register the asset. */

import type { NewAssetInput } from "@/domain/libraryOps";
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
  form.append("category", category);
  const response = await fetch("/api/assets/upload", { method: "POST", body: form });
  const body = (await response.json()) as {
    url?: string;
    sourceUrl?: string;
    processedImageUrl?: string;
    mimeType?: string;
    hasAlpha?: boolean;
    backgroundRemoved?: boolean;
    processingStatus?: "ready" | "failed";
    processingReason?: string;
    error?: string;
  };
  if (!response.ok || !body.sourceUrl) throw new Error(body.error ?? "Upload failed");

  const result = useEditorStore.getState().dispatch({
    type: "create-asset",
    input: {
      category,
      name: file.name.replace(/\.[^.]+$/, ""),
      storageUrl: body.sourceUrl!,
      processedImageUrl: body.processedImageUrl,
      width: dims.width,
      height: dims.height,
      mimeType: body.mimeType,
      hasAlpha: body.hasAlpha,
      backgroundRemoved: body.backgroundRemoved,
      processingStatus: body.processingStatus,
      processingReason: body.processingReason,
      ...extra,
    },
  });
  if (!result.createdId) throw new Error("Uploaded asset could not be registered");
  return result.createdId;
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
