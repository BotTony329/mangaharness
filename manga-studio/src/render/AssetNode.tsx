"use client";

import { Group, Image as KonvaImage, Rect } from "react-konva";
import type Konva from "konva";
import type { AssetInstance } from "@/domain/types";
import { useImageElement } from "./useImageElement";

interface AssetNodeProps {
  item: AssetInstance;
  storageUrl: string | undefined;
  interactive: boolean;
  /** Ghosted duplicates (overflow preview) render without ids or events. */
  ghost?: boolean;
  /** Only the selected item is draggable, so a drag can never move a layer
   *  other than the one the HitStack resolved. */
  selected?: boolean;
  onDragMove?: (cx: number, cy: number) => void;
  onDragEnd?: () => void;
}

/**
 * One panel instance of a source asset. Position is the item's center;
 * flip is a horizontal mirror around that center. While the image loads,
 * a placeholder rect keeps the layout visible.
 */
export function AssetNode({ item, storageUrl, interactive, ghost, selected, onDragMove, onDragEnd }: AssetNodeProps) {
  const image = useImageElement(storageUrl);
  const common = {
    x: item.cx,
    y: item.cy,
    offsetX: item.width / 2,
    offsetY: item.height / 2,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    opacity: ghost ? 0.3 : item.opacity,
    visible: item.visible !== false,
  };

  if (!image) {
    return <Rect {...common} fill="#27272a" stroke="#3f3f46" dash={[6, 6]} listening={false} />;
  }

  return (
    <Group
      {...common}
      id={ghost ? undefined : `item-${item.id}`}
      draggable={interactive && !ghost && !item.locked && Boolean(selected)}
      // Locked items stop listening entirely, so a locked background lets the
      // pointer reach whatever is above it instead of swallowing every click.
      listening={interactive && !ghost && !item.locked}
      onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => onDragMove?.(e.target.x(), e.target.y())}
      onDragEnd={onDragEnd}
    >
      {/* Flip happens inside the group so drag/transform math stays unflipped. */}
      <KonvaImage
        image={image}
        width={item.width}
        height={item.height}
        scaleX={item.flipX ? -1 : 1}
        offsetX={item.flipX ? item.width : 0}
        listening={true}
      />
    </Group>
  );
}
