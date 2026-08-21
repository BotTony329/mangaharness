"use client";

/**
 * The tone inspector.
 *
 * Every dial here changes the LAYER, never the artwork beneath it. The dials
 * are the ones a creator actually thinks in — how dark, how fine, which way it
 * runs — rather than the internals that implement them.
 *
 * Procedural tones expose their pattern; image tones expose their scale and
 * whether they repeat. Neither is offered controls it cannot honour, because a
 * dial that does nothing is worse than an absent one.
 */

import { useMemo } from "react";
import {
  FREQUENCY_RANGE,
  maskIsEmpty,
  moireRisk,
  normalizeToneParams,
  type ProceduralToneType,
} from "@/domain/tones";
import { describeTone } from "@/domain/toneDescribe";
import type { ProjectDocument, ToneItem } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AlertIcon, ICON_STROKE, MaskIcon } from "../ui/icons";
import { ToneSwatch } from "../library/ToneSwatch";

const PATTERN_TYPES: { id: ProceduralToneType; label: string }[] = [
  { id: "dot", label: "Dots" },
  { id: "line", label: "Lines" },
  { id: "cross-hatch", label: "Cross" },
  { id: "gradient", label: "Gradient" },
  { id: "noise", label: "Noise" },
];

export function ToneControls({ item, doc }: { item: ToneItem; doc: ProjectDocument }) {
  const dispatch = useEditorStore((s) => s.dispatch);
  const openToneMask = useUiStore((s) => s.openToneMask);
  const update = (patch: Parameters<typeof dispatch>[0] extends never ? never : object) =>
    dispatch({ type: "update-tone", itemId: item.id, patch } as never);

  const procedural = item.tone.source === "procedural" ? normalizeToneParams(item.tone.params) : undefined;
  const asset = item.tone.source === "asset" ? doc.assets[item.tone.assetId] : undefined;

  /**
   * Two different dot grids at nearly the same angle beat against each other
   * into a visible interference pattern. Detectable, so it is worth saying —
   * as a note with a one-click fix, not a block: a creator is allowed to want
   * the effect.
   */
  const clash = useMemo(() => {
    if (!procedural) return undefined;
    const others = doc.panels[item.panelId]?.itemIds
      .map((id) => doc.items[id])
      .filter((other): other is ToneItem => Boolean(other) && other.kind === "tone" && other.id !== item.id && other.visible !== false);
    return others?.find((other) => other.tone.source === "procedural" && moireRisk(normalizeToneParams(other.tone.params), procedural));
  }, [doc, item.id, item.panelId, procedural]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {procedural ? (
          <ToneSwatch params={procedural} size={44} />
        ) : (
          <span className="h-11 w-11 shrink-0 rounded border border-[var(--border-subtle)] bg-[repeating-conic-gradient(#e5e5e5_0_25%,#ffffff_0_50%)] bg-[length:10px_10px]" />
        )}
        <div className="min-w-0">
          <p className="truncate text-[11px] text-[var(--text-primary)]">{describeTone(doc, item)}</p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {maskIsEmpty(item.mask) ? "Covering the whole panel" : item.invert ? "Everywhere except your selection" : "Only inside your selection"}
          </p>
        </div>
      </div>

      <button
        className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium"
        style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
        onClick={() => openToneMask(item.id)}
      >
        <MaskIcon size={13} strokeWidth={ICON_STROKE} />
        {maskIsEmpty(item.mask) ? "Apply with Mask" : "Edit mask"}
      </button>

      {!maskIsEmpty(item.mask) && (
        <div className="flex gap-1.5">
          <label className="flex flex-1 items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={Boolean(item.invert)} onChange={(event) => update({ invert: event.target.checked })} />
            Invert
          </label>
          <button
            className="rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:border-zinc-600"
            onClick={() => update({ mask: null, invert: false })}
          >
            Clear mask
          </button>
        </div>
      )}

      <div>
        <Label>Opacity {Math.round(item.opacity * 100)}%</Label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={item.opacity}
          className="w-full"
          aria-label="Tone opacity"
          onChange={(event) => update({ opacity: Number(event.target.value) })}
        />
      </div>

      {procedural && (
        <>
          <div>
            <Label>Pattern</Label>
            <div className="grid grid-cols-5 gap-1">
              {PATTERN_TYPES.map((option) => (
                <button
                  key={option.id}
                  className={`rounded border px-1 py-1 text-[10px] ${
                    procedural.type === option.id
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                      : "border-[var(--border-subtle)] text-zinc-400 hover:border-zinc-600"
                  }`}
                  onClick={() => update({ params: { type: option.id } })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            {/* Density is coverage, which is what "30% tone" has always meant. */}
            <Label>Density {Math.round(procedural.density * 100)}%</Label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={procedural.density}
              className="w-full"
              aria-label="Tone density"
              onChange={(event) => update({ params: { density: Number(event.target.value) } })}
            />
          </div>

          <div>
            <Label>Frequency {Math.round(procedural.frequency)} / 100px</Label>
            <input
              type="range"
              min={FREQUENCY_RANGE.min}
              max={FREQUENCY_RANGE.max}
              step={1}
              value={procedural.frequency}
              className="w-full"
              aria-label="Tone frequency"
              onChange={(event) => update({ params: { frequency: Number(event.target.value) } })}
            />
            <p className="text-[10px] text-[var(--text-muted)]">Higher is finer. This changes the pattern size, not how dark it is.</p>
          </div>

          <div>
            <Label>Angle {Math.round(procedural.angle)}°</Label>
            <input
              type="range"
              min={0}
              max={179}
              step={1}
              value={procedural.angle}
              className="w-full"
              aria-label="Tone angle"
              onChange={(event) => update({ params: { angle: Number(event.target.value) } })}
            />
          </div>

          {clash && (
            <div className="flex items-start gap-1.5 rounded-md bg-[var(--bg-elevated)] p-2 text-[10px] leading-4 text-[var(--text-muted)]">
              <AlertIcon size={12} strokeWidth={ICON_STROKE} className="mt-0.5 shrink-0" />
              <span>
                This sits at almost the same angle as “{describeTone(doc, clash)}” in this panel, which can produce a
                shimmering interference pattern.{" "}
                <button
                  className="underline hover:text-[var(--text-secondary)]"
                  onClick={() => update({ params: { angle: (normalizeToneParams((clash.tone as { params: unknown }).params).angle + 30) % 180 } })}
                >
                  Separate them by 30°
                </button>
              </span>
            </div>
          )}
        </>
      )}

      {asset && (
        <>
          <div>
            <Label>Scale {Math.round((item.scale ?? 1) * 100)}%</Label>
            <input
              type="range"
              min={0.1}
              max={4}
              step={0.05}
              value={item.scale ?? 1}
              className="w-full"
              aria-label="Tone scale"
              onChange={(event) => update({ scale: Number(event.target.value) })}
            />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={item.tone.source === "asset" ? item.tone.tileable : false}
              onChange={(event) => update({ tileable: event.target.checked })}
            />
            Repeat across the panel
          </label>
          <p className="text-[10px] text-[var(--text-muted)]">
            {item.tone.source === "asset" && item.tone.tileable
              ? "Scale changes the pattern size."
              : "Scale is ignored while the tone is fitted to the area."}
          </p>
        </>
      )}

      <div>
        <Label>Rotation {Math.round(item.rotation)}°</Label>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={item.rotation}
          className="w-full"
          aria-label="Tone rotation"
          onChange={(event) => update({ rotation: Number(event.target.value) })}
        />
      </div>

      <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={item.clipToPanel !== false}
          onChange={(event) => update({ clipToPanel: event.target.checked })}
        />
        Clip to panel
      </label>
      <p className="text-[10px] leading-4 text-[var(--text-muted)]">
        On, the tone fills the panel and follows it. Off, you can move and resize it freely — it still cannot spill
        outside the panel border.
      </p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{children}</p>;
}
