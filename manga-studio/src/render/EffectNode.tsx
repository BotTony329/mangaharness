"use client";

import { Group, Shape } from "react-konva";
import type Konva from "konva";
import type { EffectItem } from "@/domain/types";

interface EffectNodeProps {
  item: EffectItem;
  interactive: boolean;
  onSelect?: () => void;
  onDragEnd?: (cx: number, cy: number) => void;
}

/**
 * Parameterized vector effects drawn procedurally (resolution-independent —
 * they stay crisp at 2x export scale, unlike stretched bitmaps).
 */
export function EffectNode({ item, interactive, onSelect, onDragEnd }: EffectNodeProps) {
  return (
    <Group
      id={`item-${item.id}`}
      x={item.cx}
      y={item.cy}
      offsetX={item.width / 2}
      offsetY={item.height / 2}
      width={item.width}
      height={item.height}
      rotation={item.rotation}
      opacity={item.opacity}
      visible={item.visible !== false}
      draggable={interactive && !item.locked}
      listening={interactive}
      onMouseDown={onSelect}
      onTap={onSelect}
      onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onDragEnd?.(e.target.x(), e.target.y())}
    >
      <Shape
        width={item.width}
        height={item.height}
        sceneFunc={(ctx, shape) => drawEffect(ctx, shape, item)}
        // Hit area is the full rect so the (mostly empty) effect stays selectable.
        hitFunc={(ctx, shape) => {
          ctx.beginPath();
          ctx.rect(0, 0, item.width, item.height);
          ctx.closePath();
          ctx.fillStrokeShape(shape);
        }}
      />
    </Group>
  );
}

function drawEffect(ctx: Konva.Context, shape: Konva.Shape, item: EffectItem): void {
  const { width: w, height: h, effectKind, params } = item;
  ctx.save();
  switch (effectKind) {
    case "speed-lines":
      drawSpeedLines(ctx, w, h, params);
      break;
    case "focus-lines":
      drawRadialLines(ctx, w, h, Number(params.density ?? 60), 0.35, 2.2);
      break;
    case "impact-burst":
      drawRadialLines(ctx, w, h, Number(params.density ?? 110), 0.18, 4);
      break;
    case "screentone":
      drawScreentone(ctx, w, h, params);
      break;
  }
  ctx.restore();
  ctx.fillStrokeShape(shape);
}

function drawSpeedLines(ctx: Konva.Context, w: number, h: number, params: EffectItem["params"]): void {
  const vertical = params.direction === "vertical";
  const count = Number(params.density ?? 40);
  ctx.strokeStyle = "#111111";
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random thickness/offset so re-renders are stable.
    const t = (i + 0.5) / count;
    const jitter = pseudoRandom(i);
    ctx.lineWidth = 0.5 + jitter * 2.5;
    ctx.beginPath();
    if (vertical) {
      const x = t * w + (jitter - 0.5) * (w / count);
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (jitter - 0.5) * 8, h);
    } else {
      const y = t * h + (jitter - 0.5) * (h / count);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + (jitter - 0.5) * 8);
    }
    ctx.stroke();
  }
}

/** Lines from the rect edge toward the center, leaving a clear core. */
function drawRadialLines(ctx: Konva.Context, w: number, h: number, count: number, coreRatio: number, maxWidth: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.hypot(w, h) / 2;
  const inner = outer * coreRatio;
  ctx.strokeStyle = "#111111";
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + pseudoRandom(i) * 0.05;
    const lineInner = inner * (0.85 + pseudoRandom(i * 7) * 0.3);
    ctx.lineWidth = 0.4 + pseudoRandom(i * 3) * maxWidth;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.lineTo(cx + Math.cos(angle) * lineInner, cy + Math.sin(angle) * lineInner);
    ctx.stroke();
  }
}

function drawScreentone(ctx: Konva.Context, w: number, h: number, params: EffectItem["params"]): void {
  const spacing = Number(params.spacing ?? 10);
  const radius = Number(params.dotRadius ?? 1.6);
  ctx.fillStyle = "#111111";
  for (let y = spacing / 2; y < h; y += spacing) {
    for (let x = spacing / 2; x < w; x += spacing) {
      // Offset every other row for the classic halftone look.
      const offset = (Math.floor(y / spacing) % 2) * (spacing / 2);
      ctx.beginPath();
      ctx.arc(x + offset, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Stable hash-based noise — Math.random would repaint differently every frame. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
