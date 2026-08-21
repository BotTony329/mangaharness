"use client";

/**
 * Direct manipulation for puppet actors (V3.2 §1/§2).
 *
 * Two things live here: draggable joint handles, and the face drop highlight
 * shown while an expression chip is dragged over the actor.
 *
 * Both are editor-only by construction — the overlay layer is hidden on export
 * and creates no document item. The joint drag DOES write to the document, but
 * through `transientDispatch`, so a drag is one undo entry on release rather
 * than one per pointer move, and the panel updates continuously in between.
 *
 * There is no Apply button. A joint rotation inside the puppet's limits is a
 * local, instant, generation-free edit; making the creator confirm it would
 * imply a cost that does not exist.
 */

import { Circle, Group, Line, Rect } from "react-konva";
import type Konva from "konva";
import { panelBoundsPx } from "@/domain/coords";
import { puppetForInstance } from "@/domain/puppetOps";
import type { AssetInstance, Page, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import {
  faceDropTarget,
  fromPuppetUnits,
  jointAngleFromPointer,
  jointHandles,
  toPuppetUnits,
  type JointHandle,
} from "@/puppet/interaction";
import { PanelRollGroup } from "./PanelRollGroup";

interface PuppetOverlayProps {
  doc: ProjectDocument;
  page: Page;
  instance: AssetInstance;
  scale: number;
  /** True while an expression chip is being dragged over this actor. */
  faceHovered: boolean;
  /** Handles only appear for the selected actor. */
  showHandles: boolean;
}

const JOINT_COLOR = "#e879f9";
const APPROXIMATE_COLOR = "#fbbf24";
const FACE_COLOR = "#34d399";

export function PuppetOverlay({ doc, page, instance, scale, faceHovered, showHandles }: PuppetOverlayProps) {
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);
  const showPrompt = useUiStore((state) => state.showPuppetCapabilityPrompt);

  const puppet = puppetForInstance(doc, instance);
  const panel = doc.panels[instance.panelId];
  if (!puppet || !instance.puppet || !panel) return null;

  const bounds = panelBoundsPx(doc, panel);
  const originX = page.workspace.x + bounds.x;
  const originY = page.workspace.y + bounds.y;
  /** Puppet unit space → stage pixels. */
  const toStage = (unit: { x: number; y: number }) => {
    const local = fromPuppetUnits(instance, unit);
    return { x: originX + local.x, y: originY + local.y };
  };

  const pose = instance.puppet.pose;
  const handles = jointHandles(puppet, pose);
  const face = faceDropTarget(puppet, pose);

  return (
    <PanelRollGroup doc={doc} page={page} panel={panel}>
      {faceHovered && face && <FaceHighlight face={face} toStage={toStage} scale={scale} />}

      {showHandles &&
        handles.map((handle) => (
          <JointHandleNode
            key={handle.joint}
            handle={handle}
            toStage={toStage}
            scale={scale}
            onDrag={(stageX, stageY) => {
              const unit = toPuppetUnits(instance, { x: stageX - originX, y: stageY - originY });
              const result = jointAngleFromPointer(puppet, handle.joint, handle, unit);
              // The puppet is never bent past its limit to follow the pointer;
              // it stops at the boundary and says so.
              transientDispatch({
                type: "set-puppet-joint",
                instanceId: instance.id,
                joint: handle.joint,
                degrees: result.applied,
              });
              return result;
            }}
            onRelease={(result) => {
              commitTransient();
              if (result?.clamped || result?.capability.quality === "approximate") {
                showPrompt({
                  instanceId: instance.id,
                  joint: handle.joint,
                  requestedDegrees: result.requested,
                  reason:
                    result.capability.reason ??
                    "Pose exceeds this puppet's local range.",
                  fallbackRecommendation: result.capability.fallbackRecommendation,
                });
              }
            }}
          />
        ))}
    </PanelRollGroup>
  );
}

/** The real face region, so a drop lands where the head actually is. */
function FaceHighlight({
  face,
  toStage,
  scale,
}: {
  face: { x: number; y: number; width: number; height: number };
  toStage: (unit: { x: number; y: number }) => { x: number; y: number };
  scale: number;
}) {
  const topLeft = toStage({ x: face.x, y: face.y });
  const bottomRight = toStage({ x: face.x + face.width, y: face.y + face.height });
  const x = Math.min(topLeft.x, bottomRight.x);
  const y = Math.min(topLeft.y, bottomRight.y);
  return (
    <Rect
      x={x}
      y={y}
      width={Math.abs(bottomRight.x - topLeft.x)}
      height={Math.abs(bottomRight.y - topLeft.y)}
      cornerRadius={6 / scale}
      fill="rgba(52, 211, 153, 0.18)"
      stroke={FACE_COLOR}
      strokeWidth={2.5 / scale}
      dash={[8 / scale, 4 / scale]}
      listening={false}
    />
  );
}

function JointHandleNode({
  handle,
  toStage,
  scale,
  onDrag,
  onRelease,
}: {
  handle: JointHandle;
  toStage: (unit: { x: number; y: number }) => { x: number; y: number };
  scale: number;
  onDrag: (stageX: number, stageY: number) => ReturnType<typeof jointAngleFromPointer>;
  onRelease: (result: ReturnType<typeof jointAngleFromPointer> | null) => void;
}) {
  let lastResult: ReturnType<typeof jointAngleFromPointer> | null = null;
  const pivot = toStage({ x: handle.x, y: handle.y });
  const tip = toStage({ x: handle.tipX, y: handle.tipY });
  const approximate = handle.capability.quality === "approximate";
  const color = approximate ? APPROXIMATE_COLOR : JOINT_COLOR;

  return (
    <Group>
      {/* The bone guide makes it obvious which limb a handle drives. */}
      <Line
        points={[pivot.x, pivot.y, tip.x, tip.y]}
        stroke={color}
        strokeWidth={2 / scale}
        opacity={0.5}
        listening={false}
      />
      <Circle x={pivot.x} y={pivot.y} radius={3 / scale} fill={color} opacity={0.7} listening={false} />
      <Circle
        x={tip.x}
        y={tip.y}
        radius={7 / scale}
        fill="#0f172a"
        stroke={color}
        strokeWidth={2.5 / scale}
        draggable
        onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
          lastResult = onDrag(event.target.x(), event.target.y());
        }}
        onDragEnd={() => {
          onRelease(lastResult);
          lastResult = null;
        }}
      />
    </Group>
  );
}
