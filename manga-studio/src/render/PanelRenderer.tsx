"use client";

import { Group, Rect } from "react-konva";
import { panelRectToPx } from "@/domain/geometry";
import type { ID, Panel, PanelItem, ProjectDocument } from "@/domain/types";
import { AssetNode } from "./AssetNode";
import { BubbleNode } from "./BubbleNode";
import { EffectNode } from "./EffectNode";

export interface PanelInteraction {
  selectedItemId?: ID;
  onSelectPanel?: (panelId: ID) => void;
  onSelectItem?: (itemId: ID, panelId: ID) => void;
  onItemDragMove?: (itemId: ID, cx: number, cy: number) => void;
  onItemDragEnd?: (itemId: ID, cx?: number, cy?: number) => void;
  onEditBubble?: (itemId: ID) => void;
  onTailMove?: (itemId: ID, x: number, y: number) => void;
}

interface PanelRendererProps {
  doc: ProjectDocument;
  panel: Panel;
  interactive: boolean;
  interaction?: PanelInteraction;
}

/**
 * The panel viewport: a clipped group with Figma-frame semantics. Items may
 * extend beyond the panel; only pixels inside the rect render. The border is
 * drawn unclipped on top so strokes aren't half-cut.
 */
export function PanelRenderer({ doc, panel, interactive, interaction = {} }: PanelRendererProps) {
  const { pageWidth, pageHeight } = doc.project.settings;
  const rect = panelRectToPx(panel.rect, pageWidth, pageHeight);
  const items = panel.itemIds.map((id) => doc.items[id]).filter(Boolean) as PanelItem[];

  return (
    <>
      <Group
        x={rect.x}
        y={rect.y}
        clipX={0}
        clipY={0}
        clipWidth={rect.width}
        clipHeight={rect.height}
      >
        {/* Transparent catcher: clicking empty panel space selects the panel. */}
        <Rect
          width={rect.width}
          height={rect.height}
          fill="#ffffff"
          listening={interactive}
          onMouseDown={() => interaction.onSelectPanel?.(panel.id)}
          onTap={() => interaction.onSelectPanel?.(panel.id)}
        />
        {items.map((item) => renderItem(doc, panel.id, item, interactive, interaction))}
      </Group>
      {panel.border.visible && (
        <Rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          stroke={panel.border.color}
          strokeWidth={panel.border.strokeWidthPx}
          listening={false}
        />
      )}
    </>
  );
}

function renderItem(
  doc: ProjectDocument,
  panelId: ID,
  item: PanelItem,
  interactive: boolean,
  interaction: PanelInteraction,
) {
  switch (item.kind) {
    case "asset":
      return (
        <AssetNode
          key={item.id}
          item={item}
          storageUrl={doc.assets[item.sourceAssetId]?.storageUrl}
          interactive={interactive}
          onSelect={() => interaction.onSelectItem?.(item.id, panelId)}
          onDragMove={(cx, cy) => interaction.onItemDragMove?.(item.id, cx, cy)}
          onDragEnd={() => interaction.onItemDragEnd?.(item.id)}
        />
      );
    case "bubble":
      return (
        <BubbleNode
          key={item.id}
          item={item}
          interactive={interactive}
          selected={interaction.selectedItemId === item.id}
          onSelect={() => interaction.onSelectItem?.(item.id, panelId)}
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
          onSelect={() => interaction.onSelectItem?.(item.id, panelId)}
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
  const { pageWidth, pageHeight } = doc.project.settings;
  const rect = panelRectToPx(panel.rect, pageWidth, pageHeight);
  return (
    <Group x={rect.x} y={rect.y} listening={false}>
      <AssetNode item={item} storageUrl={doc.assets[item.sourceAssetId]?.storageUrl} interactive={false} ghost />
    </Group>
  );
}
