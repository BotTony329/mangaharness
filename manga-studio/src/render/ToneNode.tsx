"use client";

import { Group, Shape } from "react-konva";
import type Konva from "konva";
import { maskIsEmpty, normalizeToneParams, type ToneMaskShape } from "@/domain/tones";
import type { ToneItem } from "@/domain/types";
import { paintImageTone, paintTone } from "./tonePainter";
import { useImageElement } from "./useImageElement";

interface ToneNodeProps {
  item: ToneItem;
  imageUrl?: string;
  interactive: boolean;
  selected?: boolean;
  onDragMove?: (cx: number, cy: number) => void;
  onDragEnd?: (cx: number, cy: number) => void;
}

/**
 * A tone layer on the canvas.
 *
 * It draws ON TOP of the artwork and never into it. The panel group already
 * clips to the panel polygon, so a tone physically cannot escape its panel —
 * on screen or in the export, which walks this same scene graph.
 */
export function ToneNode({ item, imageUrl, interactive, selected, onDragMove, onDragEnd }: ToneNodeProps) {
  const image = useImageElement(item.tone.source === "asset" ? imageUrl : undefined);

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
      draggable={interactive && !item.locked && Boolean(selected)}
      listening={interactive && !item.locked}
      onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => onDragMove?.(e.target.x(), e.target.y())}
      onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onDragEnd?.(e.target.x(), e.target.y())}
    >
      <Shape
        width={item.width}
        height={item.height}
        sceneFunc={(ctx, shape) => drawTone(ctx, shape, item, image)}
        /**
         * A masked tone is clickable only where it is painted, so a tone on a
         * shirt does not swallow every click in the panel. The hit graph reads
         * the alpha channel, so painting the mask shapes here is what makes the
         * two agree — see `canvas/hitStack`, which applies the same rule.
         */
        hitFunc={(ctx, shape) => {
          ctx.beginPath();
          if (maskIsEmpty(item.mask) || item.invert) {
            ctx.rect(0, 0, item.width, item.height);
          } else {
            traceMask(ctx as unknown as Path2DLike, item.mask!.shapes, item.width, item.height);
          }
          ctx.closePath();
          ctx.fillStrokeShape(shape);
        }}
      />
    </Group>
  );
}

interface Path2DLike {
  moveTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
}

/** Mask shapes are normalized (0..1); the union is drawn in item pixels. */
function traceMask(ctx: Path2DLike, shapes: ToneMaskShape[], w: number, h: number): void {
  for (const shape of shapes) {
    if (shape.kind === "rect") {
      ctx.rect(shape.x * w, shape.y * h, shape.width * w, shape.height * h);
      continue;
    }
    // A stroke is the union of discs along its path. Drawn as discs rather than
    // a stroked polyline so the shape is a fillable region, which is what both
    // clipping and hit-testing need.
    const radius = shape.radius * Math.min(w, h);
    for (let i = 0; i + 1 < shape.points.length; i += 2) {
      const x = shape.points[i] * w;
      const y = shape.points[i + 1] * h;
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
}

function drawTone(ctx: Konva.Context, shape: Konva.Shape, item: ToneItem, image: HTMLImageElement | null): void {
  const { width: w, height: h } = item;
  if (w <= 0 || h <= 0) return;

  const paint = (target: CanvasRenderingContext2D) => {
    if (item.tone.source === "procedural") {
      paintTone(target, w, h, normalizeToneParams(item.tone.params));
      return;
    }
    if (!image) return;
    paintImageTone(target, image, w, h, {
      tileable: item.tone.tileable,
      scale: item.scale ?? 1,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    });
  };

  const native = ctx._context as CanvasRenderingContext2D;

  if (maskIsEmpty(item.mask)) {
    native.save();
    // Even unmasked, the tone stays inside its own box.
    native.beginPath();
    native.rect(0, 0, w, h);
    native.clip();
    paint(native);
    native.restore();
    ctx.fillStrokeShape(shape);
    return;
  }

  /**
   * Masked tones composite through an offscreen buffer.
   *
   * A plain `clip()` handles "inside the mask" but not "everywhere except the
   * mask": inverting a path with the even-odd rule turns overlapping brush
   * strokes into holes, so a scribbled selection would come out full of gaps.
   * Compositing is the one approach that is correct for both, so both use it.
   *
   * The buffer is allocated at DEVICE resolution — stage zoom times export
   * pixel ratio — so a masked tone stays as crisp as an unmasked one at 2x
   * export instead of being upsampled from screen resolution.
   */
  const scale = deviceScale(ctx, shape);
  const buffer = document.createElement("canvas");
  buffer.width = Math.max(1, Math.ceil(w * scale));
  buffer.height = Math.max(1, Math.ceil(h * scale));
  const bufferCtx = buffer.getContext("2d");
  if (!bufferCtx) return;
  bufferCtx.scale(scale, scale);

  paint(bufferCtx);
  bufferCtx.globalCompositeOperation = item.invert ? "destination-out" : "destination-in";
  bufferCtx.fillStyle = "#000000";
  bufferCtx.beginPath();
  traceMask(bufferCtx, item.mask!.shapes, w, h);
  bufferCtx.fill();

  native.save();
  native.drawImage(buffer, 0, 0, w, h);
  native.restore();
  ctx.fillStrokeShape(shape);
}

/**
 * Pixels per item unit at this moment: canvas pixel ratio times the stage's
 * absolute scale. Capped, because a deeply zoomed-in masked tone would
 * otherwise allocate a buffer far larger than anything that can be displayed.
 */
function deviceScale(ctx: Konva.Context, shape: Konva.Shape): number {
  const ratio = ctx.getCanvas?.()?.getPixelRatio?.() ?? 1;
  const absolute = shape.getAbsoluteScale?.().x ?? 1;
  return Math.min(6, Math.max(1, ratio * absolute));
}
