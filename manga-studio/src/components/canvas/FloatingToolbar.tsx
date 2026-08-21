"use client";

/**
 * Contextual floating controls next to the selected object — frequent
 * actions shouldn't require a trip to the right sidebar. Character instances
 * get semantic Pose/Expression switching (reuse the matching library asset,
 * or offer generation when the slot is missing).
 */

import { panelBoundsPx } from "@/domain/coords";
import { supportsFaceFocus } from "@/domain/geometry";
import type { AssetInstance, CropMode, ID, WorkspaceItem } from "@/domain/types";
import { availableCharacterStateValues, stateFromInstance } from "@/characters/state";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { characterOfAsset } from "@/characters/slotSwitch";
import { useEditorStore } from "@/editor/store";
import { DeleteIcon, FlipIcon, ICON_SIZE, ICON_STROKE } from "../ui/icons";
import { useUiStore } from "@/editor/uiStore";
import type { Viewport } from "./useViewport";
import { useState } from "react";

interface FloatingToolbarProps {
  view: Viewport;
  onEditBubble: (itemId: ID) => void;
}

export function FloatingToolbar({ view, onEditBubble }: FloatingToolbarProps) {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const shapeEdit = useUiStore((s) => s.shapeEditPanelId);
  if (!doc || shapeEdit) return null;

  const item = selection.itemId ? doc.items[selection.itemId] : null;
  const loose = selection.workspaceItemId ? doc.workspaceItems[selection.workspaceItemId] : null;

  if (item?.kind === "asset") {
    const page = doc.pages[doc.panels[item.panelId]?.pageId];
    if (!page) return null;
    const bounds = panelBoundsPx(doc, doc.panels[item.panelId]);
    const anchor = toViewport(
      page.workspace.x + bounds.x + item.cx,
      page.workspace.y + bounds.y + item.cy - item.height / 2,
      view,
    );
    return (
      <Bar anchor={anchor}>
        <InstanceControls item={item} />
      </Bar>
    );
  }

  if (item?.kind === "bubble") {
    const page = doc.pages[doc.panels[item.panelId]?.pageId];
    if (!page) return null;
    const bounds = panelBoundsPx(doc, doc.panels[item.panelId]);
    const anchor = toViewport(
      page.workspace.x + bounds.x + item.cx,
      page.workspace.y + bounds.y + item.cy - item.height / 2,
      view,
    );
    return (
      <Bar anchor={anchor}>
        <ToolButton onClick={() => onEditBubble(item.id)}>Edit text</ToolButton>
        <DeleteButton
          onClick={() => {
            useEditorStore.getState().select({ panelId: item.panelId });
            useEditorStore.getState().dispatch({ type: "delete-instance", instanceId: item.id });
          }}
        />
      </Bar>
    );
  }

  if (loose) {
    const anchor = toViewport(loose.x, loose.y - loose.height / 2, view);
    return (
      <Bar anchor={anchor}>
        <LooseControls item={loose} />
      </Bar>
    );
  }
  return null;
}

// ─── Asset instance controls ────────────────────────────────────────────────

const CROP_MODES: { mode: CropMode; label: string }[] = [
  { mode: "fit", label: "Fit" },
  { mode: "fill", label: "Fill" },
  { mode: "upper-body", label: "Upper" },
  { mode: "face", label: "Face" },
];

function InstanceControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((s) => s.doc)!;
  const asset = doc.assets[item.sourceAssetId];
  const character = asset ? characterOfAsset(doc, asset.id) : null;
  const dispatch = useEditorStore.getState().dispatch;

  return (
    <>
      {character && <SlotSelect item={item} slotKey="pose" />}
      {character && <SlotSelect item={item} slotKey="expression" />}
      {character && <Divider />}
      {CROP_MODES.map(({ mode, label }) => {
        const unavailable = mode === "face" && (!asset || !supportsFaceFocus(asset));
        return (
          <ToolButton
            key={mode}
            active={item.cropMode === mode}
            disabled={unavailable}
            title={unavailable ? "Needs face region metadata" : undefined}
            onClick={() => dispatch({ type: "set-framing", instanceId: item.id, cropMode: mode })}
          >
            {label}
          </ToolButton>
        );
      })}
      <Divider />
      <ToolButton title="Flip horizontally" onClick={() => dispatch({ type: "set-instance-props", instanceId: item.id, patch: { flipX: !item.flipX } })}>
        <FlipIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </ToolButton>
      <DeleteButton
        onClick={() => {
          useEditorStore.getState().select({ panelId: item.panelId });
          dispatch({ type: "delete-instance", instanceId: item.id });
        }}
      />
    </>
  );
}

/**
 * Pose/Expression dropdown: existing slot values reuse the matching asset
 * instantly; "Generate…" opens the generator prefilled and swaps the
 * instance when the result is accepted.
 */
function SlotSelect({ item, slotKey }: { item: AssetInstance; slotKey: "pose" | "expression" }) {
  const doc = useEditorStore((s) => s.doc)!;
  const [busy, setBusy] = useState(false);
  const asset = doc.assets[item.sourceAssetId];
  const character = characterOfAsset(doc, asset.id)!;
  const current = stateFromInstance(doc, item)?.[slotKey] ?? "";
  const options = availableCharacterStateValues(doc, character, slotKey);

  const onPick = async (value: string) => {
    setBusy(true);
    try {
      await applyCharacterStateToInstance({ instanceId: item.id, patch: { [slotKey]: value } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <select
      className="h-7 max-w-[110px] rounded border border-zinc-700 bg-zinc-800 px-1 text-[11px] text-zinc-200"
      value={options.includes(current) ? current : ""}
      disabled={busy}
      onChange={(e) => void onPick(e.target.value)}
      title={slotKey === "pose" ? "Pose" : "Expression"}
    >
      <option value="" disabled hidden>
        {slotKey === "pose" ? "Pose…" : "Expression…"}
      </option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

// ─── Loose workspace item controls ──────────────────────────────────────────

function LooseControls({ item }: { item: WorkspaceItem }) {
  return (
    <>
      <span className="px-1 text-[10px] text-zinc-500">Drag into a panel to use</span>
      <ToolButton title="Flip horizontally" onClick={() => useEditorStore.getState().dispatch({ type: "update-workspace-instance", itemId: item.id, patch: { flipX: !item.flipX } })}>
        <FlipIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </ToolButton>
      <DeleteButton
        onClick={() => {
          useEditorStore.getState().select({});
          useEditorStore.getState().dispatch({ type: "delete-workspace-instance", itemId: item.id });
        }}
      />
    </>
  );
}

// ─── Chrome ─────────────────────────────────────────────────────────────────

function Bar({ anchor, children }: { anchor: { x: number; y: number }; children: React.ReactNode }) {
  return (
    <div
      /* A floating surface is one of the few places a shadow carries real
         information: it says "this hovers above the canvas". Kept, subtle, with
         the border dropped since the elevation already separates it. */
      className="absolute z-30 flex -translate-x-1/2 -translate-y-[calc(100%+10px)] items-center gap-0.5 rounded-lg p-1 shadow-lg shadow-black/40"
      style={{
        left: clamp(anchor.x, 90, 9999),
        top: Math.max(anchor.y, 52),
        background: "var(--bg-elevated)",
      }}
      // Keep canvas selection: toolbar clicks must not bubble to the stage container.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * An icon-only control needs a name a screen reader can read. `title` alone is
 * not reliably exposed, so the tooltip doubles as the accessible name whenever
 * the button has no text of its own.
 */
function ToolButton({
  active,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={`inline-flex h-7 items-center justify-center rounded-md px-2 text-[11px] transition-colors ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      } disabled:opacity-30`}
      aria-label={typeof children === "string" ? undefined : props.title}
    >
      {children}
    </button>
  );
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
      title="Delete"
      aria-label="Delete"
      onClick={onClick}
    >
      <DeleteIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
    </button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-5 w-px" style={{ background: "var(--border-subtle)" }} />;
}

function toViewport(wx: number, wy: number, view: Viewport): { x: number; y: number } {
  return { x: view.x + wx * view.scale, y: view.y + wy * view.scale };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
