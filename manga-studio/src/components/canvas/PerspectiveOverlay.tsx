"use client";

/**
 * Perspective construction guides (§2/§3).
 *
 * Editor-only by construction: this renders on the overlay layer, which export
 * hides, and it creates no document item — so guides cannot reach a page, an
 * export, or a generated image.
 *
 * Dragging uses `transientDispatch` so a drag produces ONE undo entry on
 * release rather than one per pointer move.
 */

import { Circle, Group, Line, Rect } from "react-konva";
import type Konva from "konva";
import { panelBoundsPx } from "@/domain/coords";
import { vanishingPointCount } from "@/domain/perspective";
import type { Page, Panel, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

interface PerspectiveOverlayProps {
  doc: ProjectDocument;
  page: Page;
  panel: Panel;
  scale: number;
  /** Handles only appear in Edit Guides mode; the lines always show. */
  editable: boolean;
}

const ACCENT = "#a78bfa";
const HORIZON = "#38bdf8";

export function PerspectiveOverlay({ doc, page, panel, scale, editable }: PerspectiveOverlayProps) {
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);
  const perspective = panel.perspective;
  if (!perspective || perspective.type === "none" || !perspective.visible) return null;

  const bounds = panelBoundsPx(doc, panel);
  const originX = page.workspace.x + bounds.x;
  const originY = page.workspace.y + bounds.y;
  const toStage = (u: number, v: number) => ({ x: originX + u * bounds.width, y: originY + v * bounds.height });
  const fromStage = (x: number, y: number) => ({
    x: (x - originX) / (bounds.width || 1),
    y: (y - originY) / (bounds.height || 1),
  });

  const count = vanishingPointCount(perspective.type);
  const points = perspective.vanishingPoints.slice(0, count);
  const horizon = toStage(0, perspective.horizonY);

  /**
   * Rays from each vanishing point across the panel.
   *
   * Drawn as segments that cross the frame rather than radiating in all
   * directions: a vanishing point usually sits outside the panel, so only the
   * rays that actually enter the frame are useful construction lines.
   */
  const rays = points.flatMap((vp, index) => {
    const origin = toStage(vp.x, vp.y);
    const targets: { x: number; y: number }[] = [];
    for (let step = 0; step <= 8; step += 1) {
      const t = step / 8;
      targets.push(toStage(t, 0));
      targets.push(toStage(t, 1));
    }
    return targets.map((target, rayIndex) => ({
      key: `vp${index}-ray${rayIndex}`,
      points: [origin.x, origin.y, target.x, target.y],
    }));
  });

  return (
    <Group>
      {/* Guides are clipped to the panel so they read as construction lines
          inside the frame rather than scribbles across the page. */}
      <Group
        clipFunc={(ctx) => {
          ctx.rect(originX, originY, bounds.width, bounds.height);
        }}
      >
        {rays.map((ray) => (
          <Line key={ray.key} points={ray.points} stroke={ACCENT} strokeWidth={1 / scale} opacity={0.28} listening={false} />
        ))}
        {perspective.type === "three-point" && (
          <Rect
            x={originX}
            y={originY}
            width={bounds.width}
            height={bounds.height}
            listening={false}
          />
        )}
      </Group>

      {/* Horizon / eye level */}
      <Line
        points={[horizon.x, horizon.y, horizon.x + bounds.width, horizon.y]}
        stroke={HORIZON}
        strokeWidth={2 / scale}
        dash={[10 / scale, 6 / scale]}
        listening={false}
      />

      {editable && (
        <Circle
          x={horizon.x + bounds.width / 2}
          y={horizon.y}
          radius={7 / scale}
          fill="#0f172a"
          stroke={HORIZON}
          strokeWidth={2 / scale}
          draggable
          dragBoundFunc={(pos) => ({ x: horizon.x + bounds.width / 2, y: pos.y })}
          onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
            const { y } = fromStage(0, event.target.y());
            transientDispatch({ type: "set-panel-perspective", panelId: panel.id, patch: { horizonY: y } });
          }}
          onDragEnd={() => commitTransient()}
        />
      )}

      {editable &&
        points.map((vp, index) => {
          const point = toStage(vp.x, vp.y);
          return (
            <Group key={`vp-handle-${index}`}>
              <Circle
                x={point.x}
                y={point.y}
                radius={9 / scale}
                fill="#0f172a"
                stroke={ACCENT}
                strokeWidth={2.5 / scale}
                draggable
                onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
                  const normalized = fromStage(event.target.x(), event.target.y());
                  transientDispatch({
                    type: "move-vanishing-point",
                    panelId: panel.id,
                    index,
                    point: normalized,
                  });
                }}
                onDragEnd={() => commitTransient()}
              />
              <Line
                points={[point.x - 5 / scale, point.y, point.x + 5 / scale, point.y]}
                stroke={ACCENT}
                strokeWidth={1.5 / scale}
                listening={false}
              />
              <Line
                points={[point.x, point.y - 5 / scale, point.x, point.y + 5 / scale]}
                stroke={ACCENT}
                strokeWidth={1.5 / scale}
                listening={false}
              />
            </Group>
          );
        })}
    </Group>
  );
}
