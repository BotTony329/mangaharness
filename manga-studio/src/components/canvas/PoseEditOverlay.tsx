"use client";

/**
 * Interactive pose rig (§1/§2).
 *
 * An editor-only skeleton drawn over the selected character. It lives on the
 * overlay layer, which export hides, so a rig can never reach a page — and it
 * draws nothing into the document while dragging: the draft rig is UI state
 * until Apply (§5).
 *
 * Joints are stored normalized to the instance box, so the overlay follows the
 * character through moves, resizes, reframing, and depth changes without any
 * recomputation of its own.
 */

import { Circle, Group, Line } from "react-konva";
import type Konva from "konva";
import { panelBoundsPx } from "@/domain/coords";
import {
  BONES,
  DRAGGABLE_JOINTS,
  moveJoint,
  resolveJoints,
  type JointId,
  type PoseRigState,
} from "@/characters/poseRig";
import type { AssetInstance, Page, ProjectDocument } from "@/domain/types";
import { useUiStore } from "@/editor/uiStore";

interface PoseEditOverlayProps {
  doc: ProjectDocument;
  page: Page;
  instance: AssetInstance;
  rig: PoseRigState;
  scale: number;
}

export function PoseEditOverlay({ doc, page, instance, rig, scale }: PoseEditOverlayProps) {
  const setPoseDraft = useUiStore((state) => state.setPoseDraft);
  const panel = doc.panels[instance.panelId];
  if (!panel) return null;

  const bounds = panelBoundsPx(doc, panel);
  const originX = page.workspace.x + bounds.x + instance.cx - instance.width / 2;
  const originY = page.workspace.y + bounds.y + instance.cy - instance.height / 2;
  const joints = resolveJoints(rig);

  // Normalized → workspace pixels. Flip mirrors the rig with the artwork so a
  // raised right arm stays on the drawn right arm.
  const toStage = (joint: JointId) => {
    const position = joints[joint];
    const u = instance.flipX ? 1 - position.x : position.x;
    return { x: originX + u * instance.width, y: originY + position.y * instance.height };
  };

  const fromStage = (x: number, y: number) => {
    const u = (x - originX) / (instance.width || 1);
    return {
      x: instance.flipX ? 1 - u : u,
      y: (y - originY) / (instance.height || 1),
    };
  };

  return (
    <Group>
      {BONES.map(([from, to]) => {
        const a = toStage(from);
        const b = toStage(to);
        return (
          <Line
            key={`${from}-${to}`}
            points={[a.x, a.y, b.x, b.y]}
            stroke="#22d3ee"
            strokeWidth={2 / scale}
            opacity={0.85}
            listening={false}
          />
        );
      })}
      {DRAGGABLE_JOINTS.map((joint) => {
        const point = toStage(joint);
        const isHead = joint === "head";
        return (
          <Circle
            key={joint}
            x={point.x}
            y={point.y}
            radius={(isHead ? 9 : 6) / scale}
            fill="#0f172a"
            stroke="#22d3ee"
            strokeWidth={2 / scale}
            draggable
            onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
              const normalized = fromStage(event.target.x(), event.target.y());
              // Constraints run inside moveJoint, so a corrected joint can snap
              // back under the cursor — that feedback is the point.
              setPoseDraft(moveJoint(useUiStore.getState().poseDraft ?? rig, joint, normalized));
            }}
            onMouseEnter={(event: Konva.KonvaEventObject<MouseEvent>) => {
              const stage = event.target.getStage();
              if (stage) stage.container().style.cursor = "grab";
            }}
            onMouseLeave={(event: Konva.KonvaEventObject<MouseEvent>) => {
              const stage = event.target.getStage();
              if (stage) stage.container().style.cursor = "";
            }}
          />
        );
      })}
    </Group>
  );
}
