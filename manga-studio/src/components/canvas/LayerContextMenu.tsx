"use client";

/**
 * Right-click → Select Layer.
 *
 * Lists every eligible layer under the pointer, topmost first, using the same
 * HitStack a plain click consumes — so the menu can never offer something the
 * click would not have found, or omit something it would.
 *
 * Locked layers ARE listed, greyed. The canvas deliberately refuses to select
 * them, so this menu and the Layers panel are the two ways back to one.
 */

import { useEffect, useRef } from "react";
import type { ID } from "@/domain/types";
import type { HitStackEntry } from "@/canvas/hitStack";
import { ICON_STROKE, LockedIcon } from "../ui/icons";

interface LayerContextMenuProps {
  x: number;
  y: number;
  entries: HitStackEntry[];
  selectedItemId?: ID;
  onPick(itemId: ID): void;
  onClose(): void;
}

export function LayerContextMenu({ x, y, entries, selectedItemId, onPick, onClose }: LayerContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    // Capture phase: the canvas swallows pointer events on its own surface.
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
      // Clamped so a right-click near the viewport edge stays on screen.
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 40 - entries.length * 30) }}
      role="menu"
      aria-label="Select layer"
    >
      <p className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-zinc-500">Select Layer</p>
      {entries.length === 0 && <p className="px-2.5 py-1.5 text-zinc-600">Nothing under the pointer</p>}
      {entries.map((entry) => (
        <button
          key={entry.itemId}
          role="menuitem"
          disabled={entry.locked}
          title={entry.locked ? "Locked — unlock it in the Layers panel" : undefined}
          className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left ${
            entry.locked
              ? "cursor-not-allowed text-zinc-600"
              : entry.itemId === selectedItemId
                ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "text-zinc-200 hover:bg-zinc-800"
          }`}
          onClick={() => !entry.locked && onPick(entry.itemId)}
        >
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          <span className="shrink-0 text-[10px] text-zinc-500">{entry.kind}</span>
          {entry.locked && (
            <LockedIcon size={12} strokeWidth={ICON_STROKE} className="shrink-0 text-[var(--text-muted)]" />
          )}
        </button>
      ))}
    </div>
  );
}
