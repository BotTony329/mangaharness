"use client";

/** Top toolbar: project identity, undo/redo, layout, add-object tools, export. */

import { useState } from "react";
import { LAYOUT_PRESETS } from "@/domain/layouts";
import type { BubbleType, EffectKind, LayoutPresetId } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { exportCurrentPagePng } from "@/export/exportPage";
import { getActiveStyleProfile } from "@/styles/profiles";

const BUBBLE_TYPES: { type: BubbleType; label: string }[] = [
  { type: "speech", label: "Speech bubble" },
  { type: "thought", label: "Thought bubble" },
  { type: "shout", label: "Shout bubble" },
  { type: "whisper", label: "Whisper bubble" },
  { type: "narration", label: "Narration box" },
];

const EFFECT_KINDS: { kind: EffectKind; label: string }[] = [
  { kind: "speed-lines", label: "Speed lines" },
  { kind: "focus-lines", label: "Focus lines" },
  { kind: "impact-burst", label: "Impact burst" },
  { kind: "screentone", label: "Screentone" },
];

export function TopBar() {
  const doc = useEditorStore((s) => s.doc);
  const dirty = useEditorStore((s) => s.dirty);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const selection = useEditorStore((s) => s.selection);
  const openSettings = useUiStore((s) => s.openSettings);
  const openArtStyle = useUiStore((s) => s.openArtStyle);
  const [exporting, setExporting] = useState(false);

  if (!doc) return null;

  const page = currentPageId ? doc.pages[currentPageId] : null;
  const activeStyle = getActiveStyleProfile(doc);
  // Toolbar tools target the selected panel, falling back to the first panel.
  const targetPanelId = selection.panelId ?? page?.panelIds[0];

  const addBubbleToPanel = (type: BubbleType) => {
    if (!targetPanelId) return;
    const result = useEditorStore.getState().dispatch({ type: "add-bubble", panelId: targetPanelId, bubbleType: type, text: "..." });
    if (result.createdId) useEditorStore.getState().select({ itemId: result.createdId, panelId: targetPanelId });
  };

  const addEffectToPanel = (kind: EffectKind) => {
    if (!targetPanelId) return;
    useEditorStore.getState().dispatch({ type: "add-effect", panelId: targetPanelId, effectKind: kind });
  };

  const onExport = async (scale: 1 | 2) => {
    setExporting(true);
    try {
      await exportCurrentPagePng(scale);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="flex h-12 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 text-sm">
      <span className="font-semibold tracking-wide text-zinc-100">Manga Studio</span>
      <span className="text-zinc-600">/</span>
      <span className="text-zinc-300">{doc.project.name}</span>
      <span className={`ml-1 text-xs ${dirty ? "text-amber-400" : "text-zinc-500"}`}>
        {dirty ? "Saving…" : "Saved"}
      </span>

      <div className="mx-3 h-6 w-px bg-zinc-700" />

      <ToolButton disabled={!canUndo} onClick={() => useEditorStore.getState().undo()} title="Undo (⌘Z)">
        ↩
      </ToolButton>
      <ToolButton disabled={!canRedo} onClick={() => useEditorStore.getState().redo()} title="Redo (⇧⌘Z)">
        ↪
      </ToolButton>

      <div className="mx-3 h-6 w-px bg-zinc-700" />

      <label className="text-zinc-400">Layout</label>
      <select
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1"
        value=""
        onChange={(e) => {
          const layout = e.target.value as LayoutPresetId;
          if (layout && page) {
            useEditorStore.getState().dispatch({ type: "set-page-layout", pageId: page.id, layout });
          }
        }}
      >
        <option value="" disabled>
          Apply preset…
        </option>
        {Object.values(LAYOUT_PRESETS).map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>

      <Dropdown label="+ Bubble" items={BUBBLE_TYPES.map((b) => ({ key: b.type, label: b.label }))} onPick={(k) => addBubbleToPanel(k as BubbleType)} />
      {/* Quick access to the most-used built-ins only. The full catalogue —
          including uploads and generated effects — lives in the Manga FX shelf,
          because a dropdown cannot grow with a project. */}
      <Dropdown label="+ Effect" items={EFFECT_KINDS.map((e) => ({ key: e.kind, label: e.label }))} onPick={(k) => addEffectToPanel(k as EffectKind)} />

      <div className="flex-1" />

      <button
        className="max-w-[220px] truncate rounded border border-violet-700/70 bg-violet-950/40 px-3 py-1 text-violet-200 hover:bg-violet-900/50"
        onClick={openArtStyle}
        title={`Project Art Style: ${activeStyle.name}`}
      >
        Art Style · {activeStyle.name}
      </button>

      <button
        className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 hover:bg-zinc-700"
        onClick={openSettings}
      >
        AI Settings
      </button>
      <Dropdown
        label={exporting ? "Exporting…" : "Export PNG"}
        accent
        items={[
          { key: "1", label: "Export page @1x" },
          { key: "2", label: "Export page @2x" },
        ]}
        onPick={(k) => onExport(Number(k) as 1 | 2)}
      />
    </header>
  );
}

function ToolButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="h-8 w-8 rounded text-base hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Dropdown({
  label,
  items,
  onPick,
  accent,
}: {
  label: string;
  items: { key: string; label: string }[];
  onPick: (key: string) => void;
  accent?: boolean;
}) {
  return (
    <select
      className={`rounded border px-2 py-1 ${
        accent
          ? "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-500"
          : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
      }`}
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
        e.target.value = "";
      }}
    >
      <option value="" disabled hidden>
        {label}
      </option>
      {items.map((item) => (
        <option key={item.key} value={item.key} className="bg-zinc-800 text-zinc-200">
          {item.label}
        </option>
      ))}
    </select>
  );
}
