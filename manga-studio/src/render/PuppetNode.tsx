"use client";

/**
 * Renders a MangaPuppet as one logical actor built from many parts (§12).
 *
 * Extends the existing Konva stack rather than adding a renderer dependency:
 * nested `Group`s compose transforms, so a rotated shoulder carries its
 * forearm and hand for free; child order gives per-part z-order; and events
 * bubble to the outer group, so clicking an eye selects the actor rather than
 * the eye (§12 selection requirement).
 *
 * The outer group presents exactly the same interface as `AssetNode` — same id,
 * same drag callbacks, same transform — so every stage, camera, framing and
 * export behaviour built in earlier phases applies to puppets unchanged.
 */

import { Group, Image as KonvaImage, Rect } from "react-konva";
import type Konva from "konva";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { resolvePartTransforms, resolveVisibleParts } from "@/puppet/transforms";
import type { MangaPuppet } from "@/puppet/model";
import { useImageElement } from "./useImageElement";

interface PuppetNodeProps {
  doc: ProjectDocument;
  item: AssetInstance;
  puppet: MangaPuppet;
  interactive: boolean;
  ghost?: boolean;
  onSelect?: () => void;
  onDragMove?: (cx: number, cy: number) => void;
  onDragEnd?: () => void;
}

export function PuppetNode({
  doc,
  item,
  puppet,
  interactive,
  ghost,
  onSelect,
  onDragMove,
  onDragEnd,
}: PuppetNodeProps) {
  const state = item.puppet!;
  const visible = new Set(resolveVisibleParts(puppet, state.expressionId, state.partOverrides));
  const transforms = resolvePartTransforms(puppet, state.pose, state.partOverrides);

  // Puppet space is normalized (1 = puppet height); the instance scales it once.
  const unit = item.height;

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

  return (
    <Group
      {...common}
      id={ghost ? undefined : `item-${item.id}`}
      draggable={interactive && !ghost && !item.locked}
      listening={interactive && !ghost}
      onMouseDown={onSelect}
      onTap={onSelect}
      onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => onDragMove?.(event.target.x(), event.target.y())}
      onDragEnd={onDragEnd}
    >
      {/* Flip mirrors the whole actor, matching AssetNode's convention. */}
      <Group scaleX={item.flipX ? -1 : 1} offsetX={item.flipX ? item.width : 0}>
        {puppet.partOrder
          .filter((partId) => visible.has(partId))
          .map((partId) => {
            const part = puppet.parts[partId];
            const transform = transforms.get(partId);
            if (!part || !transform || !transform.visible) return null;
            return (
              <PuppetPartNode
                key={partId}
                doc={doc}
                textureAssetId={part.textureAssetId}
                x={transform.x * unit}
                y={transform.y * unit}
                width={transform.size.x * unit}
                height={transform.size.y * unit}
                offsetX={transform.pivot.x * transform.size.x * unit}
                offsetY={transform.pivot.y * transform.size.y * unit}
                rotation={transform.rotation}
              />
            );
          })}
        {(state.attachments ?? []).map((attachmentId) => {
          const attachment = puppet.attachments[attachmentId];
          if (!attachment) return null;
          const host = puppet.partOrder.find((id) => puppet.parts[id]?.type === attachment.partType);
          const hostTransform = host ? transforms.get(host) : undefined;
          if (!hostTransform) return null;
          // Props ride their host part, so a phone follows the hand that holds it.
          return (
            <PuppetPartNode
              key={`attachment-${attachmentId}`}
              doc={doc}
              textureAssetId={attachment.textureAssetId}
              x={(hostTransform.x + attachment.offset.x) * unit}
              y={(hostTransform.y + attachment.offset.y) * unit}
              width={attachment.size.x * unit}
              height={attachment.size.y * unit}
              offsetX={(attachment.size.x * unit) / 2}
              offsetY={(attachment.size.y * unit) / 2}
              rotation={hostTransform.rotation + attachment.rotation}
            />
          );
        })}
      </Group>
    </Group>
  );
}

/**
 * One part's texture.
 *
 * `listening={false}` on every part is what makes the actor a single click
 * target: the outer group receives the event instead of whichever eyelid
 * happened to be under the cursor.
 */
function PuppetPartNode({
  doc,
  textureAssetId,
  ...geometry
}: {
  doc: ProjectDocument;
  textureAssetId: ID;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
}) {
  const asset = doc.assets[textureAssetId];
  const image = useImageElement(asset?.processedImageUrl ?? asset?.storageUrl);
  if (!image) {
    // Placeholder keeps the actor's silhouette readable while textures load,
    // and keeps a fixture puppet visible in environments with no images.
    return <Rect {...geometry} fill="#e4e4e7" stroke="#a1a1aa" strokeWidth={1} listening={false} />;
  }
  return <KonvaImage {...geometry} image={image} listening={false} />;
}
