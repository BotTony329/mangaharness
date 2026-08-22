"use client";

/**
 * Asset Detail Editor — select a region, say what should change, generate.
 *
 * Answers four questions and nothing else: what am I editing, where should it
 * change, what should it become, which result do I want. Masks, segmentation
 * and provider APIs are implementation words that never appear on screen.
 *
 * ## Coordinate rule
 *
 * The mask canvas is kept at the ASSET's own pixel dimensions and is never
 * resized by zoom or pan. Pointer positions are converted to image space once,
 * on the way in. That is what stops a selection drifting when the creator zooms
 * in to work on a hand.
 *
 * ## Safety
 *
 * Accepting a result NEVER overwrites the source by default. "Save as
 * Variation" is the primary action; replacing the original is deliberately
 * secondary and confirmed, because existing panels use that asset.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { assetPreviewUrl, assetRenderUrl } from "@/assets/renderSource";
import { characterReferenceId, stateFromInstance } from "@/characters/state";
import { getActiveStyleProfile } from "@/styles/profiles";
import { DEFAULT_FEATHER, MAX_FEATHER } from "@/assets/localEdit";
import { buildEditInstruction } from "@/assets/editRequest";
import { editAssetRegion, saveEditedVariation } from "@/services/localEdit";
import type { AssetInstance, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { GenerateIcon, ICON_STROKE, SpinnerIcon } from "../ui/icons";

type Tool = "brush" | "rectangle";

interface EditResult {
  url: string;
  editedPixels: number;
  preservedPixels: number;
}

export function AssetDetailEditor() {
  const request = useUiStore((s) => s.assetEditor);
  const close = useUiStore((s) => s.closeAssetEditor);
  if (!request) return null;
  return <Editor key={request.assetId} assetId={request.assetId} instanceId={request.instanceId} onClose={close} />;
}

function Editor({ assetId, instanceId, onClose }: { assetId: ID; instanceId?: ID; onClose: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const dispatch = useEditorStore((s) => s.dispatch);
  const advanced = useUiStore((s) => s.advancedMode);

  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [feather, setFeather] = useState(DEFAULT_FEATHER);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<EditResult[]>([]);
  const [chosen, setChosen] = useState(0);
  const [showBefore, setShowBefore] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  /** Mask canvas, always at the asset's own pixel size — never at screen size. */
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const rectStart = useRef<{ x: number; y: number } | null>(null);

  const asset = doc?.assets[assetId];
  const sourceUrl = asset ? assetRenderUrl(asset) ?? assetPreviewUrl(asset) : undefined;

  // Lazily create the mask canvas once the asset's dimensions are known.
  useEffect(() => {
    if (!asset) return;
    const canvas = document.createElement("canvas");
    canvas.width = asset.width;
    canvas.height = asset.height;
    maskRef.current = canvas;
    setHasMask(false);
  }, [asset]);

  /** Screen pointer → image space. The one conversion in the component. */
  const toImage = useCallback(
    (event: React.PointerEvent): { x: number; y: number } | null => {
      const stage = viewportRef.current?.querySelector("[data-image-layer]") as HTMLElement | null;
      if (!stage || !asset) return null;
      const rect = stage.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * asset.width,
        y: ((event.clientY - rect.top) / rect.height) * asset.height,
      };
    },
    [asset],
  );

  const repaintOverlay = useCallback(() => {
    const overlay = viewportRef.current?.querySelector("[data-mask-layer]") as HTMLImageElement | null;
    if (overlay && maskRef.current) overlay.src = maskRef.current.toDataURL();
  }, []);

  const paintAt = useCallback(
    (point: { x: number; y: number }) => {
      const canvas = maskRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      context.fillStyle = "rgba(255,255,255,1)";
      context.beginPath();
      context.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
      context.fill();
      setHasMask(true);
      repaintOverlay();
    },
    [brushSize, repaintOverlay],
  );

  const clearMask = useCallback(() => {
    const canvas = maskRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasMask(false);
    repaintOverlay();
  }, [repaintOverlay]);

  if (!doc || !asset) return null;

  const instance = instanceId ? (doc.items[instanceId] as AssetInstance | undefined) : undefined;
  const state = instance ? stateFromInstance(doc, instance) : null;
  const character = state ? doc.characters[state.characterId] : undefined;
  const subtitle = character
    ? `${character.name} · ${state?.pose} · ${state?.expression}`
    : asset.category === "background"
      ? "Scene"
      : asset.category === "prop"
        ? "Object"
        : asset.name;

  const generate = async () => {
    if (!maskRef.current || !sourceUrl) return;
    setBusy(true);
    setError(null);
    try {
      /**
       * The harness assembles the context; the creator only says what should
       * change. Identity, style and state are ours to supply — asking someone
       * to re-describe their own character is how identity drifts.
       */
      const style = getActiveStyleProfile(doc);
      const referenceUrls = [
        character ? doc.assets[characterReferenceId(character) ?? ""] : undefined,
      ]
        .map((candidate) => (candidate ? assetRenderUrl(candidate) : undefined))
        .filter((url): url is string => Boolean(url));

      const instruction = buildEditInstruction({
        prompt,
        category: asset.category,
        characterName: character?.name,
        state,
        styleName: style.name,
      });

      // UI and the agent share one client path: LocalEditService.
      const body = await editAssetRegion({
        sourceUrl,
        maskPng: maskRef.current.toDataURL("image/png"),
        instruction,
        feather,
        referenceUrls,
        // Scenes stay rectangular; cut-outs keep their alpha.
        preserveAlpha: asset.category !== "background",
      });
      setResults((current) => [...current, body]);
      setChosen(results.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Local edit failed");
    } finally {
      setBusy(false);
    }
  };

  const result = results[chosen];

  /** Register the chosen result as a NEW asset. The original is never touched. */
  const saveVariation = (): ID | undefined => {
    if (!result) return undefined;
    // One write path for UI and agent: LocalEditService.saveEditedVariation.
    return saveEditedVariation(dispatch, asset, result.url, prompt);
  };

  const scale = zoom;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950" onMouseDown={(e) => e.stopPropagation()}>
      {/* ── Header: WHAT am I editing ── */}
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{asset.name}</p>
          <p className="truncate text-[11px] text-zinc-500">{subtitle}</p>
        </div>
        <div className="flex-1" />
        <button className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── WHERE should it change ── */}
        <div className="flex w-52 shrink-0 flex-col gap-3 border-r border-zinc-800 p-3 text-xs">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Select what to change</p>
            <div className="flex gap-1">
              {(["brush", "rectangle"] as Tool[]).map((option) => (
                <button
                  key={option}
                  className={`flex-1 rounded border px-2 py-1 capitalize ${
                    tool === option ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "border-zinc-700 text-zinc-400"
                  }`}
                  onClick={() => setTool(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          {tool === "brush" && (
            <label className="block">
              <span className="text-[10px] text-zinc-500">Brush size {brushSize}px</span>
              <input
                type="range"
                min={8}
                max={Math.max(64, Math.round(asset.width / 3))}
                value={brushSize}
                className="w-full"
                onChange={(event) => setBrushSize(Number(event.target.value))}
              />
            </label>
          )}

          <button
            className="rounded border border-zinc-700 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            disabled={!hasMask}
            onClick={clearMask}
          >
            Clear selection
          </button>

          {advanced && (
            <label className="block">
              <span className="text-[10px] text-zinc-500">Edge softness {feather}px</span>
              <input
                type="range"
                min={0}
                max={MAX_FEATHER}
                value={feather}
                className="w-full"
                onChange={(event) => setFeather(Number(event.target.value))}
              />
            </label>
          )}

          <div className="mt-auto">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Zoom</p>
            <div className="flex items-center gap-1">
              <button className="rounded border border-zinc-700 px-2 py-0.5" onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>
                −
              </button>
              <span className="flex-1 text-center tabular-nums text-zinc-400">{Math.round(zoom * 100)}%</span>
              <button className="rounded border border-zinc-700 px-2 py-0.5" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>
                +
              </button>
            </div>
            <div className="mt-1 flex gap-1">
              <button
                className="flex-1 rounded border border-zinc-700 py-0.5 text-[10px] text-zinc-400"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                Fit
              </button>
              <button className="flex-1 rounded border border-zinc-700 py-0.5 text-[10px] text-zinc-400" onClick={() => setZoom(1)}>
                100%
              </button>
            </div>
          </div>
        </div>

        {/* ── The image ── */}
        <div
          ref={viewportRef}
          className="relative min-w-0 flex-1 overflow-hidden bg-[repeating-conic-gradient(#27272a_0%_25%,#18181b_0%_50%)] bg-[length:20px_20px]"
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom((z) => Math.max(0.1, Math.min(8, z * (event.deltaY < 0 ? 1.1 : 0.9))));
          }}
          onPointerDown={(event) => {
            if (event.button === 1 || event.altKey) return;
            const point = toImage(event);
            if (!point) return;
            drawing.current = true;
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            if (tool === "brush") paintAt(point);
            else rectStart.current = point;
          }}
          onPointerMove={(event) => {
            if (!drawing.current || tool !== "brush") return;
            const point = toImage(event);
            if (point) paintAt(point);
          }}
          onPointerUp={(event) => {
            if (!drawing.current) return;
            drawing.current = false;
            if (tool === "rectangle" && rectStart.current) {
              const end = toImage(event);
              const start = rectStart.current;
              const context = maskRef.current?.getContext("2d");
              if (end && context) {
                context.fillStyle = "rgba(255,255,255,1)";
                context.fillRect(
                  Math.min(start.x, end.x),
                  Math.min(start.y, end.y),
                  Math.abs(end.x - start.x),
                  Math.abs(end.y - start.y),
                );
                setHasMask(true);
                repaintOverlay();
              }
              rectStart.current = null;
            }
          }}
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              width: asset.width,
              height: asset.height,
            }}
            data-image-layer
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={(showBefore ? sourceUrl : result?.url ?? sourceUrl) ?? ""}
              alt={asset.name}
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
            />
            {/* Mask overlay: visible, and never written into the asset. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              data-mask-layer
              alt=""
              className="pointer-events-none absolute inset-0 h-full w-full opacity-40 mix-blend-screen"
              style={{ filter: "drop-shadow(0 0 0 #6366f1)" }}
            />
          </div>

          {result && (
            <button
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900/90 px-3 py-1 text-[11px] text-zinc-300"
              onPointerDown={() => setShowBefore(true)}
              onPointerUp={() => setShowBefore(false)}
              onPointerLeave={() => setShowBefore(false)}
            >
              {showBefore ? "Before" : "Hold to compare"}
            </button>
          )}
        </div>

        {/* ── WHAT should it become / WHICH result ── */}
        <div className="flex w-72 shrink-0 flex-col gap-3 border-l border-zinc-800 p-3 text-xs">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">What should change?</p>
            <textarea
              className="h-20 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] p-2 text-sm"
              placeholder="fix the hand and make her hold a smartphone"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] py-1.5 font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              disabled={busy || !hasMask || prompt.trim().length === 0}
              title={!hasMask ? "Select an area first" : prompt.trim() ? undefined : "Describe the change"}
              onClick={() => void generate()}
            >
              {busy ? (
                <SpinnerIcon size={13} strokeWidth={ICON_STROKE} className="animate-spin" />
              ) : (
                <GenerateIcon size={13} strokeWidth={ICON_STROKE} />
              )}
              {busy ? "Generating…" : "Generate"}
            </button>
            <p className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              Uses one AI generation.
            </p>
            {/*
              An honest limit, stated before the creator spends a generation on
              it. Everything outside the selection is copied from the original
              byte-for-byte — which is the guarantee that makes local editing
              safe, and also the reason it cannot change what shows THROUGH a
              partly transparent area.
            */}
            <p className="mt-1 text-[10px] leading-4 text-zinc-600">
              Works on solid areas. Glass, smoke and wispy hair edges keep whatever was behind them, because
              everything outside your selection is preserved exactly.
            </p>
          </div>

          {error && <p className="rounded border border-red-900/60 bg-red-950/30 p-2 text-[11px] text-red-300">{error}</p>}

          {results.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Results</p>
              <div className="flex flex-wrap gap-1">
                {results.map((candidate, index) => (
                  <button
                    key={candidate.url}
                    className={`h-14 w-14 overflow-hidden rounded border ${
                      index === chosen ? "border-[var(--accent)]" : "border-zinc-700"
                    }`}
                    onClick={() => setChosen(index)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={candidate.url} alt={`Result ${index + 1}`} className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
              {result && (
                <p className="mt-1 text-[10px] text-zinc-600">
                  {result.preservedPixels.toLocaleString()} pixels kept from the original.
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="mt-auto space-y-1">
              <button
                className="w-full rounded-md bg-[var(--accent)] py-1.5 text-white hover:bg-[var(--accent-hover)]"
                onClick={() => {
                  saveVariation();
                  onClose();
                }}
              >
                Save as Variation
              </button>
              {instanceId && (
                <button
                  className="w-full rounded border border-zinc-700 py-1.5 text-zinc-300 hover:bg-zinc-800"
                  onClick={() => {
                    // A variation plus a single-instance swap: other panels
                    // using this asset are untouched.
                    const created = saveVariation();
                    if (created) dispatch({ type: "swap-instance-asset", instanceId, assetId: created });
                    onClose();
                  }}
                >
                  Use only in this panel
                </button>
              )}
              <button
                className="w-full rounded border border-red-900/70 py-1.5 text-[11px] text-red-300 hover:bg-red-950/40"
                onClick={() => setConfirmReplace(true)}
              >
                Replace original…
              </button>
            </div>
          )}
        </div>
      </div>

      {confirmReplace && result && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/70">
          <div className="w-[400px] rounded-lg border border-red-900/70 bg-zinc-900 p-4">
            <h3 className="mb-2 font-semibold text-red-200">Replace the original asset?</h3>
            <p className="mb-4 text-[11px] leading-5 text-zinc-400">
              Every panel already using <span className="text-zinc-200">{asset.name}</span> will change. Saving a
              variation instead leaves those panels alone.
            </p>
            <div className="flex justify-end gap-2 text-xs">
              <button className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-300" onClick={() => setConfirmReplace(false)}>
                Cancel
              </button>
              <button
                className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-200"
                onClick={() => {
                  saveVariation();
                  onClose();
                }}
              >
                Save as Variation instead
              </button>
              <button
                className="rounded bg-red-700 px-3 py-1.5 text-white"
                onClick={() => {
                  const created = saveVariation();
                  if (created) dispatch({ type: "replace-asset", oldAssetId: asset.id, newAssetId: created });
                  onClose();
                }}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
