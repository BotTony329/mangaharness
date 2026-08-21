"use client";

import { Group, Line } from "react-konva";
import { panelBoundsPx, panelPolygonPx } from "@/domain/coords";
import type { ID, Panel, PanelItem, Point, ProjectDocument } from "@/domain/types";
import { assetRenderUrl } from "@/assets/renderSource";
import { AssetNode } from "./AssetNode";
import { PuppetNode } from "./PuppetNode";
import { BubbleNode } from "./BubbleNode";
import { EffectNode } from "./EffectNode";

export interface PanelInteraction {
  selectedItemId?: ID;
  /** Selection is resolved at the stage via the HitStack, not per node. */
  onItemDragMove?: (itemId: ID, cx: number, cy: number) => void;
  onItemDragEnd?: (itemId: ID, cx?: number, cy?: number) => void;
  onEditBubble?: (itemId: ID) => void;
  onTailMove?: (itemId: ID, x: number, y: number) => void;
  onPanelDoubleClick?: (panelId: ID) => void;
}

interface PanelRendererProps {
  doc: ProjectDocument;
  panel: Panel;
  interactive: boolean;
  interaction?: PanelInteraction;
}

/**
 * The panel viewport, in page coordinates. The panel's polygon drives
 * everything: the clip path, the white fill, the border, and hit testing —
 * a diagonal panel clips diagonally, not to its bounding box. Item
 * coordinates are panel-local, anchored at the polygon's bbox origin.
 */
export function PanelRenderer({ doc, panel, interactive, interaction = {} }: PanelRendererProps) {
  const polygon = panelPolygonPx(doc, panel);
  const bounds = panelBoundsPx(doc, panel);
  const localPoints = polygon.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y }));
  const flat = localPoints.flatMap((p) => [p.x, p.y]);
  /**
   * A hidden layer must actually disappear — from the canvas AND the export,
   * which walk this same list. The Layers panel already offered the eye toggle
   * and a composite interaction retires the sprites it replaces by hiding them;
   * both were silently ignored here, so "hidden" only ever meant "unselectable".
   */
  const items = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is PanelItem => Boolean(item) && item.visible !== false);

  return (
    <>
      <Group x={bounds.x} y={bounds.y} clipFunc={(ctx) => tracePolygon(ctx, localPoints)}>
        {/* White panel sheet doubles as the click target for panel selection. */}
        <Line
          points={flat}
          closed
          fill="#ffffff"
          listening={interactive}
          onDblClick={() => interaction.onPanelDoubleClick?.(panel.id)}
          onDblTap={() => interaction.onPanelDoubleClick?.(panel.id)}
        />
        {/* Camera roll (§2). Scene content rotates about the panel centre while
            the clip stays on the outer group, so a Dutch angle tilts the shot
            and the frame stays square. Export walks this same scene graph, so
            the exported page matches the editor exactly. */}
        <Group
          rotation={panel.camera?.roll ?? 0}
          x={bounds.width / 2}
          y={bounds.height / 2}
          offsetX={bounds.width / 2}
          offsetY={bounds.height / 2}
        >
          {items.map((item) => renderItem(doc, panel.id, item, interactive, interaction))}
        </Group>
      </Group>
      {panel.border.visible && (
        <Line
          x={bounds.x}
          y={bounds.y}
          points={flat}
          closed
          stroke={panel.border.color}
          strokeWidth={panel.border.strokeWidthPx}
          listening={false}
        />
      )}
    </>
  );
}

function tracePolygon(ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void }, points: Point[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
}

function renderItem(
  doc: ProjectDocument,
  panelId: ID,
  item: PanelItem,
  interactive: boolean,
  interaction: PanelInteraction,
) {
  switch (item.kind) {
    case "asset": {
      // An articulated actor when the instance carries a puppet; otherwise the
      // legacy flattened render, unchanged (§21).
      const puppet = item.puppet ? doc.puppets[item.puppet.puppetId] : undefined;
      if (puppet) {
        return (
          <PuppetNode
            key={item.id}
            doc={doc}
            item={item}
            puppet={puppet}
            interactive={interactive}
            selected={interaction.selectedItemId === item.id}
            onDragMove={(cx, cy) => interaction.onItemDragMove?.(item.id, cx, cy)}
            onDragEnd={() => interaction.onItemDragEnd?.(item.id)}
          />
        );
      }
      return (
        <AssetNode
          key={item.id}
          item={item}
          storageUrl={assetRenderUrl(doc.assets[item.sourceAssetId])}
          interactive={interactive}
          selected={interaction.selectedItemId === item.id}
          onDragMove={(cx, cy) => interaction.onItemDragMove?.(item.id, cx, cy)}
          onDragEnd={() => interaction.onItemDragEnd?.(item.id)}
        />
      );
    }
    case "bubble":
      return (
        <BubbleNode
          key={item.id}
          item={item}
          interactive={interactive}
          selected={interaction.selectedItemId === item.id}
          onDragEnd={(cx, cy) => interaction.onItemDragEnd?.(item.id, cx, cy)}
          onDoubleClick={() => interaction.onEditBubble?.(item.id)}
          onTailDragEnd={(x, y) => interaction.onTailMove?.(item.id, x, y)}
        />
      );
    case "effect":
      return (
        <EffectNode
          key={item.id}
          item={item}
          interactive={interactive}
          selected={interaction.selectedItemId === item.id}
          onDragEnd={(cx, cy) => interaction.onItemDragEnd?.(item.id, cx, cy)}
        />
      );
  }
}

/**
 * Ghosted overflow preview: while an asset instance is selected, a
 * semi-transparent unclipped copy shows what exists outside the viewport.
 */
export function PanelGhost({ doc, panel, itemId }: { doc: ProjectDocument; panel: Panel; itemId: ID }) {
  const item = doc.items[itemId];
  if (!item || item.kind !== "asset" || item.panelId !== panel.id) return null;
  const bounds = panelBoundsPx(doc, panel);
  return (
    <Group x={bounds.x} y={bounds.y} listening={false}>
      <AssetNode item={item} storageUrl={assetRenderUrl(doc.assets[item.sourceAssetId])} interactive={false} ghost />
    </Group>
  );
}
