"use client";

/**
 * Interactive pose rig and rig calibration (§3/§5).
 *
 * One overlay serves both modes. In pose mode the creator drags joints to
 * author a pose; in calibration mode they drag major anchors to fit the
 * generic skeleton onto THIS render's artwork. The displayed skeleton is
 * always `preset + calibration + pose edits`, so a calibrated character's
 * overlay lands on the drawing rather than floating over it.
 *
 * Editor-only by construction: it lives on the overlay layer, which export
 * hides, and it writes to `uiStore` rather than the document — nothing here can
 * reach a page or create an undo entry.
 */

import { Circle, Group, Line } from "react-konva";
import type Konva from "konva";
import { panelBoundsPx } from "@/domain/coords";
import {
  BONES,
  CALIBRATION_ANCHORS,
  DRAGGABLE_JOINTS,
  applyCalibration,
  basePoseJoints,
  moveJoint,
  resolveJoints,
  type JointId,
  type PoseCalibration,
  type PoseIntent,
} from "@/characters/poseRig";
import type { AssetInstance, Page, ProjectDocument } from "@/domain/types";
import { useUiStore } from "@/editor/uiStore";

interface PoseEditOverlayProps {
  doc: ProjectDocument;
  page: Page;
  instance: AssetInstance;
  /** Pose being authored; null while calibrating. */
  intent: PoseIntent | null;
  calibration?: PoseCalibration;
  /** Dragging anchors instead of posing. */
  calibrating: boolean;
  scale: number;
}

export function PoseEditOverlay({ doc, page, instance, intent, calibration, calibrating, scale }: PoseEditOverlayProps) {
  const setPoseDraft = useUiStore((state) => state.setPoseDraft);
  const setCalibrationDraft = useUiStore((state) => state.setCalibrationDraft);
  const panel = doc.panels[instance.panelId];
  if (!panel) return null;

  const bounds = panelBoundsPx(doc, panel);
  const originX = page.workspace.x + bounds.x + instance.cx - instance.width / 2;
  const originY = page.workspace.y + bounds.y + instance.cy - instance.height / 2;

  const basePose = intent?.basePose ?? "standing";
  const joints = calibrating
    ? applyCalibration(basePoseJoints(basePose), calibration)
    : resolveJoints(intent ?? undefined, calibration);

  // Normalized → workspace pixels. Flip mirrors the rig with the artwork so a
  // raised right arm stays on the drawn right arm.
  const toStage = (joint: JointId) => {
    const position = joints[joint];
    const u = instance.flipX ? 1 - position.x : position.x;
    return { x: originX + u * instance.width, y: originY + position.y * instance.height };
  };

  const fromStage = (x: number, y: number) => {
    const u = (x - originX) / (instance.width || 1);
    return { x: instance.flipX ? 1 - u : u, y: (y - originY) / (instance.height || 1) };
  };

  const handles = calibrating ? CALIBRATION_ANCHORS : DRAGGABLE_JOINTS;
  const accent = calibrating ? "#f59e0b" : "#22d3ee";

  const onDrag = (joint: JointId, x: number, y: number) => {
    const normalized = fromStage(x, y);
    if (calibrating) {
      const current = useUiStore.getState().calibrationDraft ?? { anchors: {}, updatedAt: new Date().toISOString() };
      setCalibrationDraft({
        anchors: { ...current.anchors, [joint]: normalized },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const draft = useUiStore.getState().poseDraft ?? intent;
    if (draft) setPoseDraft(moveJoint(draft, joint, normalized, calibration));
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
            stroke={accent}
            strokeWidth={2 / scale}
            opacity={0.85}
            dash={calibrating ? [6 / scale, 4 / scale] : undefined}
            listening={false}
          />
        );
      })}
      {handles.map((joint) => {
        const point = toStage(joint);
        const isMajor = joint === "head" || joint === "hips";
        return (
          <Circle
            key={joint}
            x={point.x}
            y={point.y}
            radius={(isMajor ? 9 : 6) / scale}
            fill="#0f172a"
            stroke={accent}
            strokeWidth={2 / scale}
            draggable
            onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => onDrag(joint, event.target.x(), event.target.y())}
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
