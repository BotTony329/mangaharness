"use client";

/**
 * A loose asset on the workspace — working material beside the pages.
 * Rendered unclipped in workspace coordinates; never part of page export.
 */

import { Group, Image as KonvaImage, Rect } from "react-konva";
import type Konva from "konva";
import type { WorkspaceItem } from "@/domain/types";
import { useImageElement } from "./useImageElement";

interface LooseAssetNodeProps {
  item: WorkspaceItem;
  storageUrl: string | undefined;
  label?: string;
  onSelect?: () => void;
  onDragMove?: (x: number, y: number) => void;
  onDragEnd?: (x: number, y: number) => void;
}

export function LooseAssetNode({ item, storageUrl, onSelect, onDragMove, onDragEnd }: LooseAssetNodeProps) {
  const image = useImageElement(storageUrl);
  const common = {
    id: `loose-${item.id}`,
    x: item.x,
    y: item.y,
    offsetX: item.width / 2,
    offsetY: item.height / 2,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    opacity: item.opacity,
    draggable: true,
    onMouseDown: onSelect,
    onTap: onSelect,
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onDragMove?.(e.target.x(), e.target.y()),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onDragEnd?.(e.target.x(), e.target.y()),
  };

  if (!image) {
    return <Rect {...common} fill="#27272a" stroke="#3f3f46" dash={[6, 6]} />;
  }
  return (
    <Group {...common}>
      <KonvaImage
        image={image}
        width={item.width}
        height={item.height}
        scaleX={item.flipX ? -1 : 1}
        offsetX={item.flipX ? item.width : 0}
      />
    </Group>
  );
}
