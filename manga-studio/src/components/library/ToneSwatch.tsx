"use client";

/**
 * A live preview of a procedural tone, drawn by the renderer's own painter.
 *
 * Deliberately not a stored thumbnail image: a picture of "Dot 30%" would drift
 * the moment the painter changed, and a creator picking from pictures that no
 * longer match what lands on the page has no way to tell. The swatch runs the
 * same code the panel does, so the shelf cannot lie about what you will get.
 */

import { useEffect, useRef } from "react";
import type { ProceduralToneParams } from "@/domain/tones";
import { paintTone } from "@/render/tonePainter";

export function ToneSwatch({ params, size = 56 }: { params: ProceduralToneParams; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Drawn at device resolution so the dots stay round on a retina screen.
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    paintTone(ctx, size, size, params);
  }, [params, size]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size }}
      className="rounded border border-[var(--border-subtle)]"
      aria-hidden
    />
  );
}
