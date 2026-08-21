"use client";

/**
 * The floor, made visible — and grabbable (§P1.4).
 *
 * Depth already worked: dragging a staged character vertically walks them up
 * and down the floor, and the Inspector has a Depth slider. What was missing was
 * anything on screen that SAID so. A character that shrinks when dragged upward
 * looks like a bug until you can see the ground line they are standing on and
 * the handle that puts them there.
 *
 * Editor-only by construction: this draws on the overlay layer, which export
 * hides, and creates no document item — the ground plane can never reach a page,
 * an export, or a generated image.
 */

import { Circle, Ellipse, Group, Line, Text } from "react-konva";
import { panelBoundsPx } from "@/domain/coords";
import { groundLineFor, groundPointForDepth, projectedDepthScale } from "@/domain/staging";
import type { AssetInstance, Page, Panel, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { PanelRollGroup } from "./PanelRollGroup";

const FLOOR = "#f59e0b";

interface StageOverlayProps {
  doc: ProjectDocument;
  page: Page;
  panel: Panel;
  instance: AssetInstance;
  scale: number;
}

export function StageOverlay({ doc, page, panel, instance, scale }: StageOverlayProps) {
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);

  const bounds = panelBoundsPx(doc, panel);
  const originX = page.workspace.x + bounds.x;
  const originY = page.workspace.y + bounds.y;
  const camera = panel.camera;
  const horizonY = panel.perspective?.horizonY;

  const groundY = originY + groundLineFor(camera) * bounds.height;
  const horizonAbsY = originY + (horizonY ?? camera?.horizonY ?? 0.5) * bounds.height;
  const depth = instance.stage?.depth ?? 0;
  const feetY = originY + groundPointForDepth({ depth, panel: bounds, camera, horizonY });

  /**
   * The receding floor, drawn as a few converging rails between the horizon and
   * the front of the stage. Four rails read as a floor; more would compete with
   * the artwork for attention.
   */
  const rails = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const x = originX + t * bounds.width;
    // Rails converge toward the centre of the horizon, which is what makes the
    // plane read as receding rather than as a grid pasted on the panel.
    const vanishX = originX + bounds.width / 2;
    return [x, groundY, vanishX * 0.35 + x * 0.65, horizonAbsY];
  });

  const footprint = Math.max(12, (instance.width / 2) * projectedDepthScale(depth, camera));

  return (
    <PanelRollGroup doc={doc} page={page} panel={panel}>
      <Group listening={false} opacity={0.5}>
        {rails.map((points, index) => (
          <Line key={`rail-${index}`} points={points} stroke={FLOOR} strokeWidth={1 / scale} dash={[4 / scale, 6 / scale]} />
        ))}
        <Line
          points={[originX, groundY, originX + bounds.width, groundY]}
          stroke={FLOOR}
          strokeWidth={1.5 / scale}
        />
      </Group>

      {/* Where this character's feet actually meet the floor. */}
      <Ellipse
        listening={false}
        x={instance.cx + originX}
        y={feetY}
        radiusX={footprint}
        radiusY={Math.max(4, footprint * 0.22)}
        fill={FLOOR}
        opacity={0.18}
      />

      {/*
        The depth handle. Dragging it is the same operation as dragging the
        character — it dispatches `place-on-stage` — so there is one definition
        of depth rather than a gizmo with its own arithmetic.
      */}
      <Circle
        x={instance.cx + originX}
        y={feetY}
        radius={7 / scale}
        fill="#18181b"
        stroke={FLOOR}
        strokeWidth={2 / scale}
        draggable
        onDragMove={(event) => {
          // Depth is vertical only: the handle stays under the character, and
          // sideways movement is left to dragging the character itself.
          event.target.x(instance.cx + originX);
          const localFeetY = event.target.y() - originY;
          transientDispatch({
            type: "place-on-stage",
            instanceId: instance.id,
            at: { x: instance.cx, y: localFeetY - instance.height / 2 },
          });
        }}
        onDragEnd={commitTransient}
        onMouseEnter={(event) => {
          const stage = event.target.getStage();
          if (stage) stage.container().style.cursor = "ns-resize";
        }}
        onMouseLeave={(event) => {
          const stage = event.target.getStage();
          if (stage) stage.container().style.cursor = "default";
        }}
      />
      <Text
        listening={false}
        x={instance.cx + originX + 12 / scale}
        y={feetY - 7 / scale}
        text={`${Math.round(depth * 100)}% back`}
        fontSize={11 / scale}
        fill={FLOOR}
      />
    </PanelRollGroup>
  );
}
