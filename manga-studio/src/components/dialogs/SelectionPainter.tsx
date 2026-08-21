"use client";

/**
 * The one selection surface.
 *
 * Brushing and rectangle-dragging a region is the same gesture whether the
 * creator is marking a hand for the model to redraw or marking a shirt to
 * receive a screentone. Two implementations would mean two brush behaviours,
 * two sets of keyboard rules and two things to fix — so both flows use this,
 * and it reports SHAPES rather than pixels.
 *
 * ## Coordinate rule, inherited from `assets/localEdit`
 *
 * Selections live in CONTENT space, not screen space. Zoom, pan and display
 * scale change what the creator is looking at; they must not change which
 * region was selected. Here that goes one step further — shapes are reported
 * NORMALIZED (0..1), so a tone mask also survives its panel being resized and
 * the page being exported at 2x.
 */

import { useCallback, useRef, useState } from "react";

export type SelectionTool = "brush" | "rectangle";

/** Normalized (0..1) within the content box. */
export type SelectionShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "stroke"; radius: number; points: number[] };

interface SelectionPainterProps {
  /** Content size in its own units — image pixels, or panel pixels. */
  contentWidth: number;
  contentHeight: number;
  tool: SelectionTool;
  /** Brush diameter in content units. */
  brushSize: number;
  /** Called with each completed shape, in normalized coordinates. */
  onShape: (shape: SelectionShape) => void;
  /** The artwork being selected over. */
  children: React.ReactNode;
  /** Live overlay drawn on top — the shapes selected so far. */
  overlay?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function SelectionPainter({
  contentWidth,
  contentHeight,
  tool,
  brushSize,
  onShape,
  children,
  overlay,
  className,
  style,
}: SelectionPainterProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const stroke = useRef<number[]>([]);
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<SelectionShape | null>(null);

  /** Screen pointer → normalized content space. The one conversion here. */
  const toContent = useCallback((event: React.PointerEvent): { x: number; y: number } | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }, []);

  const radius = brushSize / 2 / Math.max(1, Math.min(contentWidth, contentHeight));

  return (
    <div
      ref={surfaceRef}
      className={className}
      style={{ ...style, touchAction: "none", cursor: "crosshair" }}
      data-selection-surface
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const point = toContent(event);
        if (!point) return;
        drawing.current = true;
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        if (tool === "brush") {
          stroke.current = [point.x, point.y];
          setPreview({ kind: "stroke", radius, points: [...stroke.current] });
        } else {
          rectStart.current = point;
        }
      }}
      onPointerMove={(event) => {
        if (!drawing.current) return;
        const point = toContent(event);
        if (!point) return;
        if (tool === "brush") {
          // Sample density is capped so a fast drag still produces a continuous
          // line and a slow one does not store thousands of near-identical points.
          const last = stroke.current.length;
          const dx = point.x - stroke.current[last - 2];
          const dy = point.y - stroke.current[last - 1];
          if (Math.hypot(dx, dy) < radius * 0.4) return;
          stroke.current.push(point.x, point.y);
          setPreview({ kind: "stroke", radius, points: [...stroke.current] });
        } else if (rectStart.current) {
          const start = rectStart.current;
          setPreview({
            kind: "rect",
            x: Math.min(start.x, point.x),
            y: Math.min(start.y, point.y),
            width: Math.abs(point.x - start.x),
            height: Math.abs(point.y - start.y),
          });
        }
      }}
      onPointerUp={(event) => {
        if (!drawing.current) return;
        drawing.current = false;
        const point = toContent(event);
        if (tool === "brush") {
          if (point) stroke.current.push(point.x, point.y);
          if (stroke.current.length >= 2) onShape({ kind: "stroke", radius, points: [...stroke.current] });
          stroke.current = [];
        } else if (rectStart.current && point) {
          const start = rectStart.current;
          const shape: SelectionShape = {
            kind: "rect",
            x: Math.min(start.x, point.x),
            y: Math.min(start.y, point.y),
            width: Math.abs(point.x - start.x),
            height: Math.abs(point.y - start.y),
          };
          // A click with no drag is not a selection; it would create an
          // invisible zero-area shape the creator cannot see or remove.
          if (shape.width > 0.002 && shape.height > 0.002) onShape(shape);
          rectStart.current = null;
        }
        setPreview(null);
      }}
    >
      {children}
      {overlay}
      {preview && <ShapePreview shape={preview} />}
    </div>
  );
}

/** The shape under the cursor right now, before it is committed. */
function ShapePreview({ shape }: { shape: SelectionShape }) {
  if (shape.kind === "rect") {
    return (
      <div
        className="pointer-events-none absolute border border-dashed border-white/80 bg-white/25"
        style={{
          left: `${shape.x * 100}%`,
          top: `${shape.y * 100}%`,
          width: `${shape.width * 100}%`,
          height: `${shape.height * 100}%`,
        }}
      />
    );
  }
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
      <polyline
        points={pointPairs(shape.points)}
        fill="none"
        stroke="rgba(255,255,255,0.55)"
        strokeWidth={shape.radius * 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: shape.radius * 2 }}
      />
    </svg>
  );
}

function pointPairs(points: number[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pairs.push(`${points[i]},${points[i + 1]}`);
  return pairs.join(" ");
}
