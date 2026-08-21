/**
 * Bubble appearance as data (§7).
 *
 * A bubble's *type* is semantic — speech, thought, horror — and a bubble's
 * *style* is how that type currently looks. Separating them is what lets a
 * creator restyle a horror bubble without it stopping being a horror bubble,
 * and what lets a custom silhouette act as a mask while the text layer stays
 * fully editable (§8).
 *
 * Nothing here is a bitmap. A built-in bubble is never a generated image.
 */

import type { BubbleStyle, BubbleType } from "./types";

const INK = "#111111";
const PAPER = "#ffffff";

const BASE: BubbleStyle = {
  shape: "ellipse",
  borderStyle: "solid",
  borderWeight: 3,
  tailType: "point",
  fill: PAPER,
  stroke: INK,
  textColor: INK,
  textAlign: "center",
  padding: 0.14,
};

/**
 * The look each semantic type starts with. These are defaults, not
 * constraints — every field remains editable once the bubble exists.
 */
export function defaultBubbleStyle(bubbleType: BubbleType): BubbleStyle {
  switch (bubbleType) {
    case "speech":
      return { ...BASE };
    case "thought":
      return { ...BASE, shape: "cloud", tailType: "bubbles" };
    case "shout":
      return { ...BASE, shape: "spiky", borderWeight: 4 };
    case "whisper":
      return { ...BASE, shape: "ellipse", borderStyle: "dashed", borderWeight: 2 };
    case "narration":
      return { ...BASE, shape: "rect", tailType: "none", textAlign: "left", padding: 0.1 };
    case "electronic":
      return { ...BASE, shape: "jagged", borderStyle: "double", tailType: "zigzag" };
    case "tremble":
      return { ...BASE, shape: "wavy", borderStyle: "rough", borderWeight: 2.5 };
    case "horror":
      return {
        ...BASE,
        shape: "wavy",
        borderStyle: "rough",
        borderWeight: 3.5,
        fill: "#0d0d0d",
        stroke: "#f5f5f5",
        textColor: "#f5f5f5",
      };
    case "cute":
      return { ...BASE, shape: "scalloped", borderWeight: 2.5 };
    case "internal":
      return { ...BASE, shape: "rounded-rect", borderStyle: "dashed", tailType: "none", padding: 0.12 };
    case "sfx":
      // SFX is lettering, not a balloon: no shape, no tail, heavy outline.
      return {
        ...BASE,
        shape: "none",
        tailType: "none",
        borderWeight: 0,
        fill: "transparent",
        textColor: INK,
        outlineWidth: 6,
        outlineColor: PAPER,
        warp: 0,
        vertical: false,
      };
  }
}

/** Types that are never drawn with a tail, whatever the style says. */
export function bubbleHasTail(bubbleType: BubbleType, style: BubbleStyle): boolean {
  if (bubbleType === "narration" || bubbleType === "sfx" || bubbleType === "internal") return false;
  return style.tailType !== "none";
}

/**
 * Coerce arbitrary stored style into a valid one.
 *
 * Every field falls back to the type's default, so a document written before
 * styles existed — or by a newer build with fields this one does not know —
 * opens with a usable bubble rather than an exception.
 */
export function normalizeBubbleStyle(bubbleType: BubbleType, style: unknown): BubbleStyle {
  const base = defaultBubbleStyle(bubbleType);
  if (!style || typeof style !== "object") return base;
  const raw = style as Partial<BubbleStyle>;
  const shapes: BubbleStyle["shape"][] = [
    "ellipse",
    "rounded-rect",
    "rect",
    "spiky",
    "cloud",
    "wavy",
    "jagged",
    "scalloped",
    "none",
  ];
  const borders: BubbleStyle["borderStyle"][] = ["solid", "dashed", "double", "rough"];
  const tails: BubbleStyle["tailType"][] = ["none", "point", "bubbles", "zigzag"];
  const aligns: BubbleStyle["textAlign"][] = ["left", "center", "right"];
  return {
    shape: shapes.includes(raw.shape!) ? raw.shape! : base.shape,
    borderStyle: borders.includes(raw.borderStyle!) ? raw.borderStyle! : base.borderStyle,
    borderWeight: clamp(raw.borderWeight, 0, 20, base.borderWeight),
    tailType: tails.includes(raw.tailType!) ? raw.tailType! : base.tailType,
    fill: typeof raw.fill === "string" ? raw.fill : base.fill,
    stroke: typeof raw.stroke === "string" ? raw.stroke : base.stroke,
    textColor: typeof raw.textColor === "string" ? raw.textColor : base.textColor,
    textAlign: aligns.includes(raw.textAlign!) ? raw.textAlign! : base.textAlign,
    padding: clamp(raw.padding, 0, 0.45, base.padding),
    fontFamily: typeof raw.fontFamily === "string" ? raw.fontFamily : base.fontFamily,
    maskAssetId: typeof raw.maskAssetId === "string" ? raw.maskAssetId : base.maskAssetId,
    outlineWidth: clamp(raw.outlineWidth, 0, 40, base.outlineWidth ?? 0),
    outlineColor: typeof raw.outlineColor === "string" ? raw.outlineColor : base.outlineColor,
    vertical: typeof raw.vertical === "boolean" ? raw.vertical : base.vertical,
    warp: clamp(raw.warp, 0, 1, base.warp ?? 0),
  };
}

/** Apply a partial edit, keeping the style valid. */
export function updateBubbleStyle(
  bubbleType: BubbleType,
  current: BubbleStyle | undefined,
  patch: Partial<BubbleStyle>,
): BubbleStyle {
  return normalizeBubbleStyle(bubbleType, { ...(current ?? defaultBubbleStyle(bubbleType)), ...patch });
}

/** The style a bubble is actually drawn with. */
export function resolvedBubbleStyle(item: { bubbleType: BubbleType; style?: BubbleStyle }): BubbleStyle {
  return item.style ? normalizeBubbleStyle(item.bubbleType, item.style) : defaultBubbleStyle(item.bubbleType);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
