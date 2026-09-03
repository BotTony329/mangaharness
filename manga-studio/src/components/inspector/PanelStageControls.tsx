"use client";

/**
 * Camera / Stage — the manga shot controller, not a photography panel.
 *
 * Creator language first: Presets → Shot → Angle → Lens → Focus → Distance.
 * Every control dispatches the EXISTING camera/stage domain commands — this
 * component is a UX adapter over the frozen camera core; it holds no camera
 * state of its own and introduces no second model. Numeric photography
 * parameters (pitch / yaw / roll / fov / horizonY / raw VPs) live behind
 * Advanced; perspective machinery behind Perspective Guides.
 */

import { useState } from "react";
import {
  MANGA_PERSPECTIVE_LABELS,
  MAX_MANGA_PERSPECTIVE,
  cameraMatchesPresets,
  createPanelCamera,
  type CameraPatch,
} from "@/domain/camera";
import { PERSPECTIVE_TYPES, createPanelPerspective } from "@/domain/perspective";
import { planShotCamera } from "@/services/shotCamera";
import { applyCameraToShot } from "@/services/shotCamera";
import { characterIdOfInstance } from "@/characters/identity";
import type { CameraAngle, CameraLens, ID, PerspectiveType, ShotType } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

/* ── Creator-language vocabularies over the frozen camera model ─────────── */

const SHOTS: { id: ShotType; label: string; hint: string; icon: "close" | "medium" | "full" | "wide" }[] = [
  { id: "close-up", label: "Close-up", hint: "Face / emotion", icon: "close" },
  { id: "medium", label: "Medium", hint: "Dialogue", icon: "medium" },
  { id: "full", label: "Full", hint: "Character action", icon: "full" },
  { id: "wide", label: "Wide", hint: "Scene / environment", icon: "wide" },
];

const ANGLES: { id: CameraAngle; label: string; hint: string; arrow: "down" | "level" | "up" }[] = [
  { id: "high", label: "High", hint: "Looking down", arrow: "down" },
  { id: "eye-level", label: "Eye Level", hint: "Natural", arrow: "level" },
  { id: "low", label: "Low", hint: "Powerful / dramatic", arrow: "up" },
];

const LENSES: { id: CameraLens; label: string; hint: string }[] = [
  { id: "wide", label: "Dramatic", hint: "Stronger near/far difference" },
  { id: "normal", label: "Natural", hint: "Normal manga framing" },
  { id: "telephoto", label: "Flat", hint: "Compressed depth" },
];

/** Combos of the existing controls only — no preset state is ever stored. */
const PRESETS: { id: string; label: string; patch: { shot: ShotType; angle: CameraAngle; lens: CameraLens; mangaPerspectiveStrength?: number } }[] = [
  { id: "dialogue", label: "Dialogue", patch: { shot: "medium", angle: "eye-level", lens: "normal" } },
  { id: "close-emotion", label: "Close Emotion", patch: { shot: "close-up", angle: "eye-level", lens: "normal" } },
  { id: "hero-entrance", label: "Hero Entrance", patch: { shot: "full", angle: "low", lens: "wide" } },
  { id: "intimidating", label: "Intimidating", patch: { shot: "medium", angle: "low", lens: "wide" } },
  { id: "action-impact", label: "Action Impact", patch: { shot: "medium", angle: "eye-level", lens: "wide", mangaPerspectiveStrength: 2 } },
  { id: "establishing", label: "Establishing Shot", patch: { shot: "wide", angle: "high", lens: "normal" } },
];

/* ── Component ───────────────────────────────────────────────────────────── */

export function PanelStageControls({ panelId }: { panelId: ID }) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);
  const guideEditPanelId = useUiStore((state) => state.guideEditPanelId);
  const setGuideEditPanel = useUiStore((state) => state.setGuideEditPanel);
  const selection = useEditorStore((state) => state.selection);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const panel = doc?.panels[panelId];
  if (!doc || !panel) return null;

  const camera = panel.camera ?? createPanelCamera();
  const perspective = panel.perspective ?? createPanelPerspective();
  const editingGuides = guideEditPanelId === panelId;
  // The button's visibility verdict is the SAME judgement the Shot Camera
  // service gates on — covering angle, yaw, manga perspective, the perspective
  // rig and shot widening — so the button can never hide while the service
  // would redraw (the Phase 4.1 gap: an angle-only check hid every other
  // generative camera change behind a silent staging preview).
  const shotPlan = planShotCamera(doc, { panelId, instanceId: selection.itemId, camera, perspective });
  const redraw = { requiresRedraw: shotPlan.requiresRedraw, reason: shotPlan.reason };

  // Characters placed in this panel, in stacking order.
  const cast = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item) => item?.kind === "asset")
    .map((item) => ({ item, characterId: characterIdOfInstance(doc, item) }))
    .filter((entry) => entry.characterId && doc.characters[entry.characterId])
    .map((entry) => ({ item: entry.item, character: doc.characters[entry.characterId!] }));

  const setCamera = (patch: CameraPatch) => dispatch({ type: "set-panel-camera", panelId, patch });

  return (
    <div className="space-y-4 text-xs">
      <p className="rounded-md bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
        Camera / Stage
      </p>

      {/* Presets — combos of the controls below, nothing stored. */}
      <section className="space-y-1.5">
        <div className="grid grid-cols-3 gap-1">
          {PRESETS.map((preset) => {
            const active =
              camera.shot === preset.patch.shot &&
              camera.angle === preset.patch.angle &&
              camera.lens === preset.patch.lens &&
              (preset.patch.mangaPerspectiveStrength === undefined ||
                camera.mangaPerspectiveStrength === preset.patch.mangaPerspectiveStrength);
            return (
              <button
                key={preset.id}
                title={`${preset.label}: ${SHOTS.find((s) => s.id === preset.patch.shot)?.label} + ${ANGLES.find((a) => a.id === preset.patch.angle)?.label} + ${LENSES.find((l) => l.id === preset.patch.lens)?.label}`}
                className={`rounded border px-1 py-1.5 text-[10px] leading-3 ${
                  active
                    ? "border-violet-500 bg-violet-600/30 text-violet-100"
                    : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
                onClick={() => setCamera({ ...preset.patch })}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Shot — how much of the subject? */}
      <section className="space-y-1.5">
        <Label>Shot — how much?</Label>
        <div className="grid grid-cols-4 gap-1">
          {SHOTS.map((shot) => (
            <button
              key={shot.id}
              title={`${shot.label} — ${shot.hint}`}
              className={`rounded border py-1.5 ${
                camera.shot === shot.id
                  ? "border-violet-500 bg-violet-600/30 text-violet-100"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
              onClick={() => setCamera({ shot: shot.id })}
            >
              <ShotGlyph kind={shot.icon} />
              <span className="block text-[10px] leading-3">{shot.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[9px] text-zinc-600">
          {SHOTS.find((s) => s.id === camera.shot)?.hint ??
            `${camera.shot.replace(/-/g, " ")} (custom)`}
        </p>
      </section>

      {/* Angle — where from? */}
      <section className="space-y-1.5">
        <Label>Angle — where from?</Label>
        <div className="grid grid-cols-3 gap-1">
          {ANGLES.map((angle) => (
            <button
              key={angle.id}
              title={`${angle.label} — ${angle.hint}`}
              className={`rounded border py-1.5 ${
                camera.angle === angle.id
                  ? "border-violet-500 bg-violet-600/30 text-violet-100"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
              onClick={() => setCamera({ angle: angle.id })}
            >
              <AngleGlyph arrow={angle.arrow} />
              <span className="block text-[10px] leading-3">{angle.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[9px] text-zinc-600">
          {ANGLES.find((a) => a.id === camera.angle)?.hint ??
            `${camera.angle.replace(/-/g, " ")} (custom)`}
        </p>
      </section>

      {/* Lens — how exaggerated? */}
      <section className="space-y-1.5">
        <Label>Lens — how dramatic?</Label>
        <div className="grid grid-cols-3 gap-1">
          {LENSES.map((lens) => (
            <button
              key={lens.id}
              title={`${lens.label} (${lens.id}) — ${lens.hint}`}
              className={`rounded border px-1 py-1.5 text-[10px] leading-3 ${
                camera.lens === lens.id
                  ? "border-violet-500 bg-violet-600/30 text-violet-100"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
              onClick={() => setCamera({ lens: lens.id })}
            >
              {lens.label}
              <span className="block text-[8px] text-zinc-500">{lens.id === "telephoto" ? "tele" : lens.id}</span>
            </button>
          ))}
        </div>
        <p className="text-[9px] text-zinc-600">{LENSES.find((l) => l.id === camera.lens)?.hint}</p>
      </section>

      {/* Focus — who does the framing serve? */}
      {cast.length > 0 && (
        <section className="space-y-1.5">
          <Label>Focus on</Label>
          <div className="flex flex-wrap gap-1">
            {cast.map(({ item, character }) => (
              <button
                key={item.id}
                title="Shot and framing centre on this character"
                className={`rounded border px-2 py-1 text-[10px] ${
                  panel.focalItemId === item.id
                    ? "border-violet-500 bg-violet-600/30 text-violet-100"
                    : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
                onClick={() =>
                  dispatch({
                    type: "set-panel-focal-item",
                    panelId,
                    itemId: panel.focalItemId === item.id ? undefined : item.id,
                  })
                }
              >
                {character.name}
              </button>
            ))}
            {panel.focalItemId && (
              <button
                className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800"
                onClick={() => dispatch({ type: "set-panel-focal-item", panelId, itemId: undefined })}
              >
                None
              </button>
            )}
          </div>
        </section>
      )}

      {/* Distance — who is nearer the camera? */}
      {cast.length > 0 && (
        <section className="space-y-2">
          <Label>Distance from Camera</Label>
          {cast.map(({ item, character }) => (
            <div key={item.id}>
              <div className="mb-0.5 flex justify-between text-[10px] text-zinc-500">
                <span className="text-zinc-400">{character.name}</span>
                <span>{item.stage ? `${Math.round(item.stage.depth * 100)}%` : "not staged"}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                disabled={!item.stage}
                value={item.stage?.depth ?? 0.5}
                title={
                  item.stage
                    ? "Near makes this character larger; Far makes it smaller"
                    : "Place on Stage first (select the character → Stage)"
                }
                className="w-full accent-emerald-500 disabled:opacity-30"
                onChange={(event) =>
                  transientDispatch({
                    type: "set-instance-stage",
                    instanceId: item.id,
                    patch: { depth: window.Number(event.target.value), scaleLocked: false },
                  })
                }
                onPointerUp={() => commitTransient()}
                onKeyUp={() => commitTransient()}
              />
              <div className="flex justify-between text-[9px] text-zinc-600">
                <span>Near · larger</span>
                <span>Far · smaller</span>
              </div>
            </div>
          ))}
        </section>
      )}

      {redraw.requiresRedraw && (
        <div className="space-y-2 rounded border border-amber-800/60 bg-amber-950/30 p-2">
          <p className="text-[10px] leading-4 text-amber-300">
            {redraw.reason} Composition is updated now; the artwork itself would need regenerating to match.
          </p>
          {/*
            Generative camera, shot-level (Phase 4): ONE button hands the panel
            camera to the Shot Camera Application Service, which routes to the
            joint interaction path, character camera or scene camera. LOCAL
            camera work never shows this button. Visibility and routability are
            the service's OWN plan verdict, so the UI holds no routing branches.
          */}
          {shotPlan.routable && (
            <>
              <button
                type="button"
                disabled={cameraBusy}
                onClick={async () => {
                  setCameraBusy(true);
                  setCameraError(null);
                  try {
                    await applyCameraToShot({
                      panelId: panel.id,
                      instanceId: selection.itemId,
                      camera,
                      perspective,
                    });
                  } catch (error) {
                    setCameraError(error instanceof Error ? error.message : "Camera redraw failed");
                  } finally {
                    setCameraBusy(false);
                  }
                }}
                className="w-full rounded bg-amber-500/90 px-2 py-1.5 text-[10px] font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {cameraBusy
                  ? "Generating camera view…"
                  : `✨ Generate Camera View${shotPlan.targetName ? ` — ${shotPlan.targetName}` : ""}`}
              </button>
              {cameraError && <p className="text-[10px] leading-4 text-red-400">{cameraError}</p>}
            </>
          )}
        </div>
      )}

      {/* Perspective Guides — second tier */}
      <details className="text-[11px] text-zinc-500">
        <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-zinc-400">
          Perspective Guides
        </summary>
        <div className="mt-2 space-y-2">
          <Row label="Mode">
            <Select
              value={perspective.type}
              options={PERSPECTIVE_TYPES}
              onChange={(type) =>
                dispatch({
                  type: "set-panel-perspective",
                  panelId,
                  patch: { type: type as PerspectiveType, visible: type !== "none" },
                })
              }
            />
          </Row>
          {perspective.type !== "none" && (
            <>
              <div>
                <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
                  <span>Viewer&apos;s eye level</span>
                  <span className="text-zinc-400">{Math.round(perspective.horizonY * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={perspective.horizonY}
                  title="Move the viewer's eye level"
                  className="w-full accent-sky-500"
                  onChange={(event) =>
                    dispatch({
                      type: "set-panel-perspective",
                      panelId,
                      patch: { horizonY: window.Number(event.target.value) },
                    })
                  }
                />
                <div className="flex justify-between text-[9px] text-zinc-600">
                  <span>High</span>
                  <span>Low</span>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={perspective.snapEnabled}
                  onChange={(event) =>
                    dispatch({ type: "set-panel-perspective", panelId, patch: { snapEnabled: event.target.checked } })
                  }
                />
                Snap characters to the stage depth
              </label>
              {perspective.type === "three-point" && (
                <p className="text-[10px] leading-4 text-amber-400/90">
                  Three-point draws guides and tells generation about vertical convergence. It does not re-project
                  existing artwork.
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  className={`flex-1 rounded border py-1 text-[11px] ${
                    editingGuides
                      ? "border-violet-500 bg-violet-600/30 text-violet-200"
                      : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
                  }`}
                  title="Drag the horizon line and vanishing points directly on the panel"
                  onClick={() => setGuideEditPanel(editingGuides ? null : panelId)}
                >
                  {editingGuides ? "Done Editing" : "Edit Horizon & Vanishing Points"}
                </button>
                <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={perspective.visible}
                    onChange={(event) =>
                      dispatch({ type: "set-panel-perspective", panelId, patch: { visible: event.target.checked } })
                    }
                  />
                  Show
                </label>
              </div>
            </>
          )}

          {/* Perspective strength */}
          <div>
            <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
              <span>Perspective strength</span>
              <span className="text-zinc-400">{MANGA_PERSPECTIVE_LABELS[camera.mangaPerspectiveStrength]}</span>
            </div>
            <input
              type="range"
              min={0}
              max={MAX_MANGA_PERSPECTIVE}
              step={1}
              value={camera.mangaPerspectiveStrength}
              title="Exaggerate how much nearer things loom larger"
              className="w-full"
              onChange={(event) =>
                setCamera({ mangaPerspectiveStrength: Number(event.target.value) })
              }
            />
            <div className="flex justify-between text-[9px] text-zinc-600">
              <span>Normal</span>
              <span>Extreme</span>
            </div>
          </div>

          {/* Tilt — creator language for camera roll */}
          <div>
            <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
              <span>Tilt</span>
              <span className="text-zinc-400">{camera.roll === 0 ? "Straight" : `${camera.roll}°`}</span>
            </div>
            <input
              type="range"
              min={-30}
              max={30}
              step={1}
              value={camera.roll}
              title="Tilt the whole frame — a little feels uneasy, a lot feels dramatic"
              className="w-full accent-amber-500"
              onChange={(event) => setCamera({ roll: Number(event.target.value) })}
            />
            <div className="flex justify-between text-[9px] text-zinc-600">
              <span>Straight</span>
              <span>Dramatic</span>
            </div>
          </div>

          <p className="text-[10px] leading-4 text-zinc-600">Guides are editor-only and never appear in the exported page.</p>
        </div>
      </details>

      {/* Stage — layer order */}
      <section className="space-y-2">
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={panel.autoDepthOrder ?? false}
            onChange={(event) =>
              dispatch({ type: "set-panel-auto-depth-order", panelId, enabled: event.target.checked })
            }
          />
          Nearer characters draw over farther ones
        </label>
      </section>

      {/* Advanced — raw photography values */}
      <details className="text-[11px] text-zinc-500">
        <summary className="cursor-pointer select-none">Advanced</summary>
        <div className="mt-2 space-y-2">
          {!cameraMatchesPresets(camera) && (
            <p className="text-[10px] text-amber-400">
              Manual values are active; preset changes will not overwrite them.
            </p>
          )}
          <NumberField
            label="Eye level"
            value={camera.horizonY}
            step={0.01}
            onChange={(horizonY) => setCamera({ horizonY })}
          />
          <NumberField label="Pitch" value={camera.pitch} step={1} onChange={(pitch) => setCamera({ pitch })} />
          <NumberField label="Yaw (pans framing)" value={camera.yaw} step={1} onChange={(yaw) => setCamera({ yaw })} />
          <NumberField label="Roll (dutch tilt)" value={camera.roll} step={1} onChange={(roll) => setCamera({ roll })} />
          <NumberField label="Field of view" value={camera.fov} step={1} onChange={(fov) => setCamera({ fov })} />
          <p className="text-[10px] leading-4 text-zinc-600">
            Yaw pans the framing and tells generation the camera has turned. It cannot show another side of an
            existing drawing — that needs a redraw.
          </p>
          <button
            className="w-full rounded border border-zinc-700 bg-zinc-800 py-1 hover:bg-zinc-700"
            onClick={() => setCamera({ angle: camera.angle, lens: camera.lens })}
          >
            Reset to presets
          </button>
        </div>
      </details>
    </div>
  );
}

/* ── Glyphs: simple composition icons, no emoji ──────────────────────────── */

function ShotGlyph({ kind }: { kind: "close" | "medium" | "full" | "wide" }) {
  const heights = { close: 14, medium: 11, full: 8, wide: 5 } as const;
  const h = heights[kind];
  const y = 16 - h;
  return (
    <svg viewBox="0 0 20 16" className="mx-auto mb-0.5 h-4 w-5 text-current" aria-hidden>
      <rect x="0.5" y="0.5" width="19" height="15" rx="1.5" fill="none" stroke="currentColor" strokeOpacity="0.4" />
      <circle cx="10" cy={y + h * 0.2} r={h * 0.28} fill="currentColor" />
      <rect x={10 - h * 0.22} y={y + h * 0.45} width={h * 0.44} height={h * 0.55} rx="1" fill="currentColor" />
    </svg>
  );
}

function AngleGlyph({ arrow }: { arrow: "down" | "level" | "up" }) {
  const paths = {
    down: "M4 4 L12 12 M12 12 L12 7 M12 12 L7 12",
    level: "M4 8 L14 8 M14 8 L10 4.5 M14 8 L10 11.5",
    up: "M4 12 L12 4 M12 4 L12 9 M12 4 L7 4",
  } as const;
  return (
    <svg viewBox="0 0 16 16" className="mx-auto mb-0.5 h-4 w-4 text-current" aria-hidden>
      <path d={paths[arrow]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/* ── Small shared controls ───────────────────────────────────────────────── */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <div className="w-40">{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px]"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option.replace(/-/g, " ")}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <input
        type="number"
        step={step}
        value={Math.round(value * 100) / 100}
        className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px]"
        onChange={(event) => {
          const parsed = window.Number(event.target.value);
          if (!window.Number.isNaN(parsed)) onChange(parsed);
        }}
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-wider text-zinc-500">{children}</p>;
}
