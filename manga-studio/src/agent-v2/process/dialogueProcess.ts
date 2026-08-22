"use client";

import type { BubbleType, ID } from "@/domain/types";
import { panelPxRect } from "@/domain/docHelpers";
import type { RunContext } from "../types";
import { characterInstanceInPanel } from "./cameraProcess";

export function doAddBubble(ctx: RunContext, args: {
  panel: number;
  bubbleType: BubbleType;
  text: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
}): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const rect = panelPxRect(ctx.currentDoc(), panelId);
  const anchors: Record<string, { x: number; y: number }> = {
    "top-left": { x: rect.width * 0.28, y: rect.height * 0.18 },
    "top-right": { x: rect.width * 0.72, y: rect.height * 0.18 },
    "bottom-left": { x: rect.width * 0.28, y: rect.height * 0.8 },
    "bottom-right": { x: rect.width * 0.72, y: rect.height * 0.8 },
    center: { x: rect.width * 0.5, y: rect.height * 0.5 },
  };
  const at = anchors[args.position ?? "top-left"];
  ctx.dispatch({ type: "add-bubble", panelId, bubbleType: args.bubbleType, text: args.text, at });
}

export function doAttachBubble(ctx: RunContext, args: {
  panel: number;
  characterName: string;
  characterId?: ID;
  bubbleType: BubbleType;
  text: string;
}): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const instance = characterInstanceInPanel(ctx, doc, panelId, args);
  const characterId = instance.characterState?.characterId ?? doc.assets[instance.sourceAssetId]?.metadata?.characterId;
  const rect = panelPxRect(doc, panelId);
  // Place the balloon above the speaker, clear of the face.
  const at = {
    x: Math.max(rect.width * 0.2, Math.min(rect.width * 0.8, instance.cx)),
    y: rect.height * 0.18,
  };
  const created = ctx.dispatch({ type: "add-bubble", panelId, bubbleType: args.bubbleType, text: args.text, at });
  if (!created.createdId) throw new Error("Bubble could not be created");
  ctx.dispatch({
    type: "set-bubble-target",
    itemId: created.createdId,
    characterId,
    instanceId: instance.id,
  });
}

/**
 * Semantic pose adjustment (§6).
 *
 * Produces a PoseIntent through the SAME normalizer the joint editor uses, so
 * "raise her right hand" and a dragged arm land on the identical canonical
 * descriptor and therefore the identical cached render. There is no agent-only
 * pose vocabulary and no agent-only pose path.
 */
