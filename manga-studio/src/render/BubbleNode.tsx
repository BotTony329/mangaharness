"use client";

import { Circle, Ellipse, Group, Image as KonvaImage, Line, Rect, Text } from "react-konva";
import type Konva from "konva";
import { bubbleHasTail, resolvedBubbleStyle } from "@/domain/bubbleStyles";
import type { BubbleStyle, SpeechBubbleItem } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { assetRenderUrl } from "@/assets/renderSource";
import { useImageElement } from "./useImageElement";

interface BubbleNodeProps {
  item: SpeechBubbleItem;
  interactive: boolean;
  onDragMove?: (cx: number, cy: number) => void;
  onDragEnd?: (cx: number, cy: number) => void;
  /** True while the creator is typing in this bubble; dragging is suspended. */
  editing?: boolean;
  onDoubleClick?: () => void;
  onTailDragEnd?: (x: number, y: number) => void;
  selected?: boolean;
}

/**
 * Manga dialogue and lettering.
 *
 * Everything visual comes from `BubbleStyle`, so a bubble is a parameterized
 * object for the life of the document — never a generated bitmap. A custom
 * silhouette from the Manga Language Library is drawn as a *backdrop* with the
 * text layer on top, which is why an uploaded bubble shape stays editable
 * instead of baking words into an image (§8).
 */
export function BubbleNode({ item, interactive, onDragMove, onDragEnd, onDoubleClick, onTailDragEnd, selected, editing }: BubbleNodeProps) {
  const halfW = item.width / 2;
  const halfH = item.height / 2;
  const style = resolvedBubbleStyle(item);
  const hasTail = Boolean(item.tail) && bubbleHasTail(item.bubbleType, style);
  /**
   * Locked layers do not move, and text editing owns the pointer while it is
   * open — otherwise selecting a word would drag the balloon out from under it.
   */
  const draggable = Boolean(interactive && !item.locked && selected && !editing);

  return (
    <>
      {hasTail && <TailShape item={item} style={style} />}
      <Group
        id={`item-${item.id}`}
        x={item.cx}
        y={item.cy}
        offsetX={halfW}
        offsetY={halfH}
        width={item.width}
        height={item.height}
        rotation={item.rotation}
        opacity={item.opacity}
        visible={item.visible !== false}
        draggable={draggable}
        listening={interactive && !item.locked}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => onDragMove?.(e.target.x(), e.target.y())}
        onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onDragEnd?.(e.target.x(), e.target.y())}
      >
        {/*
          The drag surface.
          
          A Konva Group has no shape of its own, so it is hit only through its
          children — and every child here paints with `listening: false` to keep
          the app's own alpha-aware hit testing authoritative. The result was a
          bubble that could be selected (selection is resolved by geometry, not
          by Konva) and then could not be grabbed, because nothing under the
          pointer belonged to it.
          
          This transparent rect gives the whole bubble — body, interior and text
          — one uniform drag target. It listens only while the bubble is
          draggable, so it never competes with hit testing for anything else,
          and never while the creator is typing.
        */}
        {draggable && (
          <Rect
            width={item.width}
            height={item.height}
            /**
             * Invisible, but a real hit target. Konva builds its hit graph from
             * an offscreen alpha channel, so a nearly-transparent fill is
             * rounded away and registers as a miss — the shape must declare its
             * hit area explicitly, exactly as EffectNode does.
             */
            hitFunc={(ctx, shape) => {
              ctx.beginPath();
              ctx.rect(0, 0, item.width, item.height);
              ctx.closePath();
              ctx.fillStrokeShape(shape);
            }}
          />
        )}
        {style.maskAssetId ? <CustomShape item={item} style={style} /> : <BubbleShape item={item} style={style} />}
        <BubbleText item={item} style={style} />
      </Group>
      {selected && interactive && hasTail && (
        <Circle
          x={item.tail!.x}
          y={item.tail!.y}
          radius={7}
          fill="#6366f1"
          stroke="#ffffff"
          strokeWidth={2}
          draggable
          onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onTailDragEnd?.(e.target.x(), e.target.y())}
        />
      )}
    </>
  );
}

function BubbleText({ item, style }: { item: SpeechBubbleItem; style: BubbleStyle }) {
  const pad = style.padding;
  const shared = {
    x: item.width * pad,
    y: item.height * pad,
    width: item.width * (1 - pad * 2),
    height: item.height * (1 - pad * 2),
    text: item.text,
    fontSize: item.fontSize,
    fontFamily: style.fontFamily ?? "'Comic Sans MS', 'Segoe UI', sans-serif",
    align: style.textAlign,
    verticalAlign: "middle" as const,
    wrap: "word" as const,
    listening: false,
  };

  // SFX lettering reads as impact: heavy stroke behind a solid fill. Konva
  // strokes on top of fill, so the outline is a second Text node underneath.
  if (style.outlineWidth && style.outlineWidth > 0) {
    return (
      <>
        <Text
          {...shared}
          fill={style.outlineColor ?? "#ffffff"}
          stroke={style.outlineColor ?? "#ffffff"}
          strokeWidth={style.outlineWidth}
          lineJoin="round"
          fontStyle="bold"
        />
        <Text {...shared} fill={style.textColor} fontStyle="bold" />
      </>
    );
  }
  return <Text {...shared} fill={style.textColor} />;
}

/** A custom silhouette behind editable text (§8). */
function CustomShape({ item, style }: { item: SpeechBubbleItem; style: BubbleStyle }) {
  const asset = useEditorStore((s) => (style.maskAssetId ? s.doc?.assets[style.maskAssetId] : undefined));
  const image = useImageElement(asset ? assetRenderUrl(asset) : undefined);
  // Until the silhouette loads, fall back to the type's own shape rather than
  // rendering nothing — a bubble with text and no balloon is unreadable.
  if (!image) return <BubbleShape item={item} style={{ ...style, maskAssetId: undefined }} />;
  return <KonvaImage image={image} width={item.width} height={item.height} listening={false} />;
}

function BubbleShape({ item, style }: { item: SpeechBubbleItem; style: BubbleStyle }) {
  const halfW = item.width / 2;
  const halfH = item.height / 2;
  const paint = {
    fill: style.fill === "transparent" ? undefined : style.fill,
    stroke: style.stroke,
    strokeWidth: style.borderWeight,
    dash: dashFor(style),
    listening: false,
  };

  switch (style.shape) {
    case "none":
      return null;
    case "rect":
      return <Rect width={item.width} height={item.height} {...paint} />;
    case "rounded-rect":
      return <Rect width={item.width} height={item.height} cornerRadius={Math.min(halfW, halfH) * 0.35} {...paint} />;
    case "spiky":
      return <Line points={starburstPoints(halfW, halfH, 14, 0.75)} closed x={halfW} y={halfH} {...paint} />;
    case "jagged":
      return <Line points={starburstPoints(halfW, halfH, 22, 0.88)} closed x={halfW} y={halfH} {...paint} />;
    case "wavy":
      return <Line points={wavyPoints(halfW, halfH, 11, 0.07)} closed tension={0.4} x={halfW} y={halfH} {...paint} />;
    case "scalloped":
      return <Line points={wavyPoints(halfW, halfH, 9, 0.11)} closed tension={0.9} x={halfW} y={halfH} {...paint} />;
    case "cloud":
      return <Line points={wavyPoints(halfW, halfH, 8, 0.14)} closed tension={1} x={halfW} y={halfH} {...paint} />;
    case "ellipse":
    default:
      return <Ellipse x={halfW} y={halfH} radiusX={halfW} radiusY={halfH} {...paint} />;
  }
}

function dashFor(style: BubbleStyle): number[] | undefined {
  switch (style.borderStyle) {
    case "dashed":
      return [10, 6];
    case "rough":
      return [14, 3, 5, 3];
    default:
      // "double" is approximated by weight; Konva has no double-stroke.
      return undefined;
  }
}

/** Speech: triangle toward target. Thought: shrinking dots. Electronic: zigzag. */
function TailShape({ item, style }: { item: SpeechBubbleItem; style: BubbleStyle }) {
  const tail = item.tail!;
  const dx = tail.x - item.cx;
  const dy = tail.y - item.cy;
  const distance = Math.hypot(dx, dy) || 1;
  const paint = {
    fill: style.fill === "transparent" ? "#ffffff" : style.fill,
    stroke: style.stroke,
    strokeWidth: Math.max(1, style.borderWeight),
    listening: false,
  };

  if (style.tailType === "bubbles") {
    return (
      <>
        {[0.55, 0.75, 0.9].map((f, i) => (
          <Circle key={i} x={item.cx + dx * f} y={item.cy + dy * f} radius={8 - i * 2} {...paint} />
        ))}
      </>
    );
  }

  const nx = -dy / distance;
  const ny = dx / distance;
  const edgeX = item.cx + (dx / distance) * (item.width / 2) * 0.75;
  const edgeY = item.cy + (dy / distance) * (item.height / 2) * 0.75;

  if (style.tailType === "zigzag") {
    // An open polyline, so a radio tail reads as a signal rather than a spike.
    const steps = 5;
    const points: number[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const sway = (i % 2 === 0 ? 1 : -1) * Math.min(14, item.width * 0.06) * (1 - t);
      points.push(edgeX + (tail.x - edgeX) * t + nx * sway, edgeY + (tail.y - edgeY) * t + ny * sway);
    }
    return <Line points={points} stroke={style.stroke} strokeWidth={Math.max(2, style.borderWeight)} listening={false} />;
  }

  const baseWidth = Math.min(24, item.width * 0.15);
  return (
    <Line
      points={[
        edgeX + nx * baseWidth,
        edgeY + ny * baseWidth,
        edgeX - nx * baseWidth,
        edgeY - ny * baseWidth,
        tail.x,
        tail.y,
      ]}
      closed
      {...paint}
    />
  );
}

function starburstPoints(radiusX: number, radiusY: number, spikes: number, inner: number): number[] {
  const points: number[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (Math.PI * i) / spikes;
    const factor = i % 2 === 0 ? 1 : inner;
    points.push(Math.cos(angle) * radiusX * factor, Math.sin(angle) * radiusY * factor);
  }
  return points;
}

/** A closed ring whose radius oscillates — the basis for wavy/cloud/scalloped. */
function wavyPoints(radiusX: number, radiusY: number, lobes: number, amplitude: number): number[] {
  const points: number[] = [];
  const steps = lobes * 2;
  for (let i = 0; i < steps; i++) {
    const angle = (Math.PI * 2 * i) / steps;
    const factor = 1 + (i % 2 === 0 ? amplitude : -amplitude);
    points.push(Math.cos(angle) * radiusX * factor, Math.sin(angle) * radiusY * factor);
  }
  return points;
}
