"use client";

import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

interface BackgroundRemovalResponse {
  processedImageUrl?: string;
  hasAlpha?: boolean;
  backgroundRemoved?: boolean;
  processingStatus?: "ready" | "failed";
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
  requestId?: string;
  error?: string;
}

/** Request a derivative while keeping the asset's original storageUrl untouched. */
export async function removeAssetBackground(
  assetId: ID,
  strategy: "auto" | "image-edit" | "provider" | "local" = "auto",
): Promise<void> {
  const asset = useEditorStore.getState().doc?.assets[assetId];
  if (!asset || (asset.category !== "character" && asset.category !== "prop")) {
    throw new Error("Background removal is available for character and prop assets");
  }
  useEditorStore.getState().dispatch({
    type: "set-asset-processed",
    assetId,
    update: { processingStatus: "processing", backgroundRemovalStatus: "processing", processingReason: undefined },
  });
  try {
    const response = await fetch("/api/assets/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: asset.sourceUrl || asset.storageUrl, category: asset.category, assetId, strategy }),
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
        backgroundRemovalStatus: "ready",
        processingReason: undefined,
        backgroundRemovalMethod: body.backgroundRemovalMethod,
        backgroundRemovalProvider: body.backgroundRemovalProvider,
      },
    });
    console.info("[bg-remove]", JSON.stringify({ requestId: body.requestId, stage: "asset_updated", assetId }));
  } catch (error) {
    useEditorStore.getState().dispatch({
      type: "set-asset-processed",
      assetId,
      update: {
        processingStatus: "failed",
        backgroundRemovalStatus: "failed",
        processingReason: error instanceof Error ? error.message : "Background removal failed",
      },
    });
    throw error;
  }
}
