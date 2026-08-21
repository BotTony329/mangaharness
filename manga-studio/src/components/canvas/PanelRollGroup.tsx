"use client";

/**
 * Rotates overlay content with the panel's camera roll (§2).
 *
 * Editor guides must tilt with the shot, or a Dutch angle would leave handles
 * sitting somewhere the artwork no longer is. Konva reports a dragged child's
 * position in its parent group's coordinate space, so the un-rotated maths the
 * overlays already use stays correct inside this wrapper.
 */

import { Group } from "react-konva";
import { panelBoundsPx } from "@/domain/coords";
import type { Page, Panel, ProjectDocument } from "@/domain/types";

export function PanelRollGroup({
  doc,
  page,
  panel,
  children,
}: {
  doc: ProjectDocument;
  page: Page;
  panel: Panel;
  children: React.ReactNode;
}) {
  const roll = panel.camera?.roll ?? 0;
  if (!roll) return <>{children}</>;
  const bounds = panelBoundsPx(doc, panel);
  const cx = page.workspace.x + bounds.x + bounds.width / 2;
  const cy = page.workspace.y + bounds.y + bounds.height / 2;
  return (
    <Group rotation={roll} x={cx} y={cy} offsetX={cx} offsetY={cy}>
      {children}
    </Group>
  );
}
