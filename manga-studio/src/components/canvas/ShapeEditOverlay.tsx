"use client";

/**
 * Panel shape-edit mode (double-click a panel): draggable vertex anchors on
 * the panel polygon. Dragging a node reshapes the panel — border, clipping,
 * and export all follow, because they all read the same polygon.
 */

import { Circle, Group, Line } from "react-konva";
import type Konva from "konva";
import { panelPolygonPx } from "@/domain/coords";
import type { Page, Panel, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

interface ShapeEditOverlayProps {
  doc: ProjectDocument;
  page: Page;
  panel: Panel;
  scale: number;
}

export function ShapeEditOverlay({ doc, page, panel, scale }: ShapeEditOverlayProps) {
  const transientDispatch = useEditorStore((s) => s.transientDispatch);
  const commitTransient = useEditorStore((s) => s.commitTransient);
  const { pageWidth, pageHeight } = doc.project.settings;
  const polygon = panelPolygonPx(doc, panel);

  const moveVertex = (index: number, pagePxX: number, pagePxY: number) => {
    const current = useEditorStore.getState().doc?.panels[panel.id]?.points ?? panel.points;
    const points = current.map((point, pointIndex) => pointIndex === index
      ? { x: pagePxX / pageWidth, y: pagePxY / pageHeight }
      : point);
    transientDispatch({ type: "reshape-panel", panelId: panel.id, points });
  };

  return (
    <Group x={page.workspace.x} y={page.workspace.y}>
      <Line
        points={polygon.flatMap((p) => [p.x, p.y])}
        closed
        stroke="#f59e0b"
        strokeWidth={2.5 / scale}
        listening={false}
      />
      {polygon.map((point, index) => (
        <Circle
          key={index}
          x={point.x}
          y={point.y}
          radius={7 / scale}
          fill="#ffffff"
          stroke="#f59e0b"
          strokeWidth={2 / scale}
          draggable
          onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => moveVertex(index, e.target.x(), e.target.y())}
          onDragEnd={() => commitTransient()}
        />
      ))}
    </Group>
  );
}
