"use client";

/**
 * Inline dialogue editing: a positioned textarea floated over the canvas
 * (canvas text isn't editable). Enter commits, Escape cancels,
 * Shift+Enter inserts a newline.
 */

import { useEffect, useRef, useState } from "react";
import type { Rect, SpeechBubbleItem } from "@/domain/types";

interface BubbleTextEditorProps {
  bubble: SpeechBubbleItem;
  panelRect: Rect;
  scale: number;
  stagePos: { x: number; y: number };
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function BubbleTextEditor({ bubble, panelRect, scale, stagePos, onCommit, onCancel }: BubbleTextEditorProps) {
  const [text, setText] = useState(bubble.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const left = stagePos.x + (panelRect.x + bubble.cx - bubble.width / 2) * scale;
  const top = stagePos.y + (panelRect.y + bubble.cy - bubble.height / 2) * scale;

  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit(text);
        }
        if (e.key === "Escape") onCancel();
      }}
      className="absolute z-20 resize-none rounded-md border-2 border-[var(--accent)] bg-white text-center text-zinc-900 outline-none"
      style={{
        left,
        top,
        width: bubble.width * scale,
        height: bubble.height * scale,
        fontSize: bubble.fontSize * scale,
        padding: 8 * scale,
      }}
    />
  );
}
