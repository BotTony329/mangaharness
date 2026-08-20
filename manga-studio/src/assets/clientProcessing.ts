"use client";

import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

interface BackgroundRemovalResponse {
  processedImageUrl?: string;
  hasAlpha?: boolean;
  backgroundRemoved?: boolean;
  processingStatus?: "ready" | "failed";
  error?: string;
}

/** Request a derivative while keeping the asset's original storageUrl untouched. */
export async function removeAssetBackground(assetId: ID): Promise<void> {
  const asset = useEditorStore.getState().doc?.assets[assetId];
  if (!asset || (asset.category !== "character" && asset.category !== "prop")) {
    throw new Error("Background removal is available for character and prop assets");
  }
  useEditorStore.getState().dispatch({ type: "set-asset-processed", assetId, update: { processingStatus: "processing" } });
  try {
    const response = await fetch("/api/assets/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: asset.storageUrl, category: asset.category }),
    });
    const body = (await response.json().catch(() => ({}))) as BackgroundRemovalResponse;
    if (!response.ok || body.processingStatus === "failed" || !body.processedImageUrl) {
      throw new Error(body.error ?? "Background removal failed");
    }
    useEditorStore.getState().dispatch({
      type: "set-asset-processed",
      assetId,
      update: {
        processedImageUrl: body.processedImageUrl,
        hasAlpha: body.hasAlpha === true,
        backgroundRemoved: body.backgroundRemoved === true,
        processingStatus: "ready",
      },
    });
  } catch (error) {
    useEditorStore.getState().dispatch({ type: "set-asset-processed", assetId, update: { processingStatus: "failed" } });
    throw error;
  }
}
