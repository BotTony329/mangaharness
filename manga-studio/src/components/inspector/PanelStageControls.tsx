"use client";

/**
 * Panel-level director controls: camera and perspective (§14/§25).
 *
 * Easy first — shot, angle, lens and a manga-perspective slider are the whole
 * primary surface. Advanced numeric fields sit behind a disclosure so the
 * professional capability exists without being the entry point.
 *
 * The component holds no semantic state of its own: every control reads the
 * document and writes through a domain command, so undo works and the Agent
 * and the human share one path.
 */

import {
  CAMERA_ANGLES,
  CAMERA_LENSES,
  MANGA_PERSPECTIVE_LABELS,
  MAX_MANGA_PERSPECTIVE,
  SHOT_TYPES,
  cameraMatchesPresets,
  createPanelCamera,
} from "@/domain/camera";
import { PERSPECTIVE_TYPES, createPanelPerspective } from "@/domain/perspective";
import { cameraChangeRequiresRedraw } from "@/domain/staging";
import type { CameraAngle, CameraLens, ID, PerspectiveType, ShotType } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

export function PanelStageControls({ panelId }: { panelId: ID }) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);
  const guideEditPanelId = useUiStore((state) => state.guideEditPanelId);
  const setGuideEditPanel = useUiStore((state) => state.setGuideEditPanel);
  const panel = doc?.panels[panelId];
  if (!panel) return null;

  const camera = panel.camera ?? createPanelCamera();
  const editingGuides = guideEditPanelId === panelId;
  // Tell the creator when a camera choice changes composition only.
  const redraw = cameraChangeRequiresRedraw("angle", camera).requiresRedraw
    ? cameraChangeRequiresRedraw("angle", camera)
    : cameraChangeRequiresRedraw("mangaPerspective", camera);
  const perspective = panel.perspective ?? createPanelPerspective();

  return (
    <div className="space-y-4 text-xs">
      <section className="space-y-2">
        <Label>Camera</Label>
        <Row label="Shot">
          <Select
            value={camera.shot}
            options={SHOT_TYPES}
            onChange={(shot) => dispatch({ type: "set-panel-camera", panelId, patch: { shot: shot as ShotType } })}
          />
        </Row>
        <Row label="Angle">
          <Select
            value={camera.angle}
            options={CAMERA_ANGLES}
            onChange={(angle) => dispatch({ type: "set-panel-camera", panelId, patch: { angle: angle as CameraAngle } })}
          />
        </Row>
        <Row label="Lens">
          <Select
            value={camera.lens}
            options={CAMERA_LENSES}
            onChange={(lens) => dispatch({ type: "set-panel-camera", panelId, patch: { lens: lens as CameraLens } })}
          />
        </Row>
        <div>
          <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
            <span>Perspective</span>
            <span className="text-zinc-400">{MANGA_PERSPECTIVE_LABELS[camera.mangaPerspectiveStrength]}</span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX_MANGA_PERSPECTIVE}
            step={1}
            value={camera.mangaPerspectiveStrength}
            className="w-full accent-indigo-500"
            onChange={(event) =>
              dispatch({
                type: "set-panel-camera",
                panelId,
                patch: { mangaPerspectiveStrength: Number(event.target.value) },
              })
            }
          />
          <div className="flex justify-between text-[9px] text-zinc-600">
            <span>Normal</span>
            <span>Extreme</span>
          </div>
        </div>
      </section>

      {redraw.requiresRedraw && (
        <p className="rounded border border-amber-800/60 bg-amber-950/30 p-2 text-[10px] leading-4 text-amber-300">
          {redraw.reason} Composition is updated now; the artwork itself would need regenerating to match.
        </p>
      )}

      <section className="space-y-2">
        <Label>Perspective</Label>
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
                <span>Eye level</span>
                <span className="text-zinc-400">{Math.round(perspective.horizonY * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={perspective.horizonY}
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
              Snap to Stage
            </label>
            <p className="text-[10px] leading-4 text-zinc-600">
              Drag a staged character up or down the panel to move it through depth. Line art is not snapped.
            </p>
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
                onClick={() => setGuideEditPanel(editingGuides ? null : panelId)}
              >
                {editingGuides ? "Done Editing" : "Edit Guides"}
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
        <p className="text-[10px] leading-4 text-zinc-600">Guides are editor-only and never appear in the exported page.</p>
      </section>

      <section className="space-y-2">
        <Label>Stage</Label>
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={panel.autoDepthOrder ?? false}
            onChange={(event) =>
              dispatch({ type: "set-panel-auto-depth-order", panelId, enabled: event.target.checked })
            }
          />
          Auto layer order by depth
        </label>
        <p className="text-[10px] leading-4 text-zinc-600">
          {panel.autoDepthOrder
            ? "Nearer characters draw over farther ones."
            : "Manual layer order is in control."}
        </p>
      </section>

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
            onChange={(horizonY) => dispatch({ type: "set-panel-camera", panelId, patch: { horizonY } })}
          />
          <NumberField
            label="Pitch"
            value={camera.pitch}
            step={1}
            onChange={(pitch) => dispatch({ type: "set-panel-camera", panelId, patch: { pitch } })}
          />
          <NumberField
            label="Roll (dutch tilt)"
            value={camera.roll}
            step={1}
            onChange={(roll) => dispatch({ type: "set-panel-camera", panelId, patch: { roll } })}
          />
          <NumberField
            label="Yaw (pans framing)"
            value={camera.yaw}
            step={1}
            onChange={(yaw) => dispatch({ type: "set-panel-camera", panelId, patch: { yaw } })}
          />
          <p className="text-[10px] leading-4 text-zinc-600">
            Yaw pans the framing and tells generation the camera has turned. It cannot show another side of an
            existing drawing — that needs a redraw.
          </p>
          <NumberField
            label="Field of view"
            value={camera.fov}
            step={1}
            onChange={(fov) => dispatch({ type: "set-panel-camera", panelId, patch: { fov } })}
          />
          <button
            className="w-full rounded border border-zinc-700 bg-zinc-800 py-1 hover:bg-zinc-700"
            onClick={() =>
              dispatch({
                type: "set-panel-camera",
                panelId,
                patch: { angle: camera.angle, lens: camera.lens },
              })
            }
          >
            Reset to presets
          </button>
        </div>
      </details>
    </div>
  );
}

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
