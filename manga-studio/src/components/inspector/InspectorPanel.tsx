"use client";

/**
 * Context-sensitive inspector: shows the controls for whatever is selected.
 * Every control dispatches the same domain commands the agent uses.
 */

import { supportsFaceFocus } from "@/domain/geometry";
import {
  availableCharacterStateValues,
  stateFromInstance,
  type CharacterStatePatch,
  type CharacterStateValueKey,
} from "@/characters/state";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { SOCKET_DRAG_TYPE, encodeSocketDrag } from "@/characters/sockets";
import { PanelStageControls } from "./PanelStageControls";
import { LayersPanel } from "./LayersPanel";
import { InteractionControls } from "./InteractionControls";
import { useUiStore } from "@/editor/uiStore";
import { PoseEditControls } from "./PoseEditControls";
import { PuppetControls } from "./PuppetControls";
import { isPuppetInstance } from "@/domain/puppetOps";
import { InstanceStageControls } from "./InstanceStageControls";
import type { ReorderDirection } from "@/domain/itemOps";
import type { DomainCommand } from "@/domain/commands";
import type {
  AssetInstance,
  BubbleStyle,
  BubbleType,
  CharacterState,
  CropMode,
  ID,
  PanelItem,
  SourceAsset,
  SpeechBubbleItem,
} from "@/domain/types";
import { resolvedBubbleStyle } from "@/domain/bubbleStyles";
import { findExactCharacterAsset } from "@/characters/state";
import { searchLanguageAssets } from "@/language/library";
import { useEditorStore } from "@/editor/store";
import { useState } from "react";

const CROP_MODES: { mode: CropMode; label: string }[] = [
  { mode: "fit", label: "Fit" },
  { mode: "fill", label: "Fill" },
  { mode: "upper-body", label: "Upper Body" },
  { mode: "face", label: "Face" },
];

export function InspectorPanel() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  if (!doc) return null;

  const item = selection.itemId ? doc.items[selection.itemId] : null;
  if (item) {
    return (
      <>
        <ItemInspector item={item} asset={item.kind === "asset" ? doc.assets[item.sourceAssetId] : undefined} />
        {/* The layer list follows the selection's own panel, so the stack the
            creator is working in is always the one on screen. */}
        <div className="border-t border-zinc-800 p-3">
          <LayersPanel panelId={item.panelId} />
        </div>
      </>
    );
  }

  if (selection.panelId && doc.panels[selection.panelId]) {
    return (
      <div className="space-y-4 p-3">
        <SectionTitle>Panel</SectionTitle>
        <PanelStageControls panelId={selection.panelId} />
        <LayersPanel panelId={selection.panelId} />
        <p className="text-[10px] leading-4 text-zinc-600">
          Drag assets from the library into this panel, or use + Bubble / + Effect in the toolbar.
        </p>
      </div>
    );
  }
  return (
    <Hint>
      Select a panel or an object on the canvas.
      <br />
      <br />
      Drag any library asset into a panel — the panel is a viewport: only what&apos;s inside its frame renders, and every
      placement is an independent, non-destructive instance.
    </Hint>
  );
}

function ItemInspector({ item, asset }: { item: PanelItem; asset?: SourceAsset }) {
  const dispatch = (command: DomainCommand) => useEditorStore.getState().dispatch(command);
  const id = item.id;

  return (
    <div className="space-y-4 p-3 text-xs">
      <SectionTitle>
        {item.kind === "asset" ? (asset?.name ?? "Asset") : item.kind === "bubble" ? "Speech bubble" : "Effect"}
      </SectionTitle>

      {item.kind === "asset" && asset && (
        <>
          {asset.metadata?.characterId && <CharacterStateControls item={item} />}
        <div>
          <Label>Framing</Label>
          <div className="grid grid-cols-2 gap-1">
            {CROP_MODES.map(({ mode, label }) => {
              const faceUnavailable = mode === "face" && !supportsFaceFocus(asset);
              return (
                <button
                  key={mode}
                  disabled={faceUnavailable}
                  title={faceUnavailable ? "Needs face region metadata on this asset" : undefined}
                  className={`rounded border px-2 py-1.5 ${
                    item.cropMode === mode
                      ? "border-indigo-500 bg-indigo-600/30 text-indigo-200"
                      : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
                  }`}
                  onClick={() => dispatch({ type: "set-framing", instanceId: id, cropMode: mode })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {item.cropMode === "custom" && <p className="mt-1 text-[10px] text-zinc-500">Custom framing (manually adjusted)</p>}
        </div>
        </>
      )}

      {item.kind === "bubble" && (
        <>
          <div>
            <Label>Text</Label>
            <textarea
              className="h-20 w-full resize-none rounded border border-zinc-700 bg-zinc-800 p-2"
              value={item.text}
              onChange={(e) => dispatch({ type: "update-bubble", itemId: id, patch: { text: e.target.value } })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Type</Label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
                value={item.bubbleType}
                onChange={(e) => dispatch({ type: "update-bubble", itemId: id, patch: { bubbleType: e.target.value as BubbleType } })}
              >
                {BUBBLE_TYPES.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Font size</Label>
              <input
                type="number"
                min={8}
                max={96}
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
                value={item.fontSize}
                onChange={(e) => dispatch({ type: "update-bubble", itemId: id, patch: { fontSize: Number(e.target.value) || 22 } })}
              />
            </div>
          </div>
          <BubbleStyleControls item={item} />
        </>
      )}

      {item.attachment && (
        <div className="rounded border border-indigo-900/60 bg-indigo-950/20 p-2">
          <p className="text-[11px] text-indigo-300">
            Attached to {attachmentLabel(item.attachment.targetItemId)} — it moves when they move.
          </p>
          <button
            className="mt-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
            onClick={() => dispatch({ type: "detach-item", itemId: id })}
          >
            Detach (keep in place)
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
          className="w-full accent-indigo-500"
          onChange={(e) => dispatch({ type: "set-instance-props", instanceId: id, patch: { opacity: Number(e.target.value) } })}
        />
      </div>

      {item.kind === "asset" && asset && (
        <div>
          <Label>Scale</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={5}
              max={200}
              step={1}
              value={Math.max(5, Math.min(200, Math.round((item.height / Math.max(asset.height, 1)) * 100)))}
              className="min-w-0 flex-1 accent-indigo-500"
              onChange={(event) => {
                const scale = Number(event.target.value) / 100;
                dispatch({ type: "update-instance-transform", instanceId: id, patch: {
                  width: asset.width * scale,
                  height: asset.height * scale,
                }});
              }}
            />
            <span className="w-10 text-right text-[10px] text-zinc-500">
              {Math.round((item.height / Math.max(asset.height, 1)) * 100)}%
            </span>
          </div>
        </div>
      )}

      <div>
        <Label>Rotation</Label>
        <input
          type="number"
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
          value={Math.round(item.rotation)}
          onChange={(e) => dispatch({ type: "update-instance-transform", instanceId: id, patch: { rotation: Number(e.target.value) || 0 } })}
        />
      </div>

      {item.kind === "asset" && (
        <button
          className="w-full rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
          onClick={() => dispatch({ type: "set-instance-props", instanceId: id, patch: { flipX: !item.flipX } })}
        >
          Flip horizontally {item.flipX ? "(flipped)" : ""}
        </button>
      )}

      <div>
        <Label>Layer order</Label>
        <div className="grid grid-cols-4 gap-1">
          {(
            [
              ["back", "⤓"],
              ["backward", "↓"],
              ["forward", "↑"],
              ["front", "⤒"],
            ] as [ReorderDirection, string][]
          ).map(([direction, glyph]) => (
            <button
              key={direction}
              title={`Send ${direction}`}
              className="rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
              onClick={() => dispatch({ type: "reorder-instance", instanceId: id, direction })}
            >
              {glyph}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          className="flex-1 rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
          onClick={() => dispatch({ type: "duplicate-instance", instanceId: id })}
        >
          Duplicate
        </button>
        <button
          className="flex-1 rounded border border-red-900 bg-red-950/60 py-1.5 text-red-300 hover:bg-red-900/60"
          onClick={() => {
            useEditorStore.getState().select({ panelId: item.panelId });
            dispatch({ type: "delete-instance", instanceId: id });
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function CharacterStateControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc);
  // A puppet character edits locally; a legacy flat one keeps the older
  // skeleton-plus-regeneration path (§21).
  const isPuppet = Boolean(doc && isPuppetInstance(doc, item.id));
  // The skeleton pose editor authors a request that ends in regeneration; it is
  // an Advanced tool, not the normal way to move a character.
  const advanced = useUiStore((state) => state.advancedMode);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<{
    previousAssetId: string;
    previousState: CharacterState;
    generatedState: CharacterState;
  }>();
  if (!doc) return null;
  const current = stateFromInstance(doc, item);
  const character = current ? doc.characters[current.characterId] : undefined;
  if (!current || !character) return null;

  const change = async (patch: CharacterStatePatch, forceRegenerate = false) => {
    setBusy(true);
    setError(undefined);
    setStatus("Checking character library…");
    try {
      const result = await applyCharacterStateToInstance({
        instanceId: item.id,
        patch,
        forceRegenerate,
        onProgress: ({ stage, state }) => {
          if (stage === "generating") setStatus(`Generating ${title(state.expression)} + ${title(state.pose)}…`);
          if (stage === "saving") setStatus("Saving reusable character state…");
          if (stage === "complete") setStatus(undefined);
        },
      });
      if (result.source === "generated") {
        setReview({
          previousAssetId: result.previousAssetId,
          previousState: result.previousState,
          generatedState: result.state,
        });
      } else {
        setReview(undefined);
      }
    } catch (caught) {
      setStatus(undefined);
      setError(caught instanceof Error ? caught.message : "Character generation failed");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Which semantic dimensions this instance still edits through generation.
   *
   * A puppet owns its face and its arms locally, so showing generative Pose and
   * Expression dropdowns beside instant puppet controls would offer two paths
   * to the same result at wildly different cost (§4). Outfit and View remain:
   * the puppet genuinely cannot change either, and the dropdown is honest about
   * needing a render.
   */
  const controls: { key: CharacterStateValueKey; label: string }[] = isPuppet
    ? [
        { key: "outfit", label: "Outfit" },
        { key: "view", label: "View" },
      ]
    : [
        { key: "pose", label: "Pose" },
        { key: "expression", label: "Expression" },
        { key: "outfit", label: "Outfit" },
        { key: "view", label: "View" },
      ];

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <Label>{isPuppet ? "Character" : "Character state"}</Label>
        <span className="text-[10px] text-indigo-300">{character.name}</span>
      </div>
      {isPuppet && (
        <p className="mb-2 text-[10px] leading-4 text-zinc-500">
          Outfit and View still need a new render; face and pose are instant below.
        </p>
      )}
      <div className="space-y-2">
        {controls.map(({ key, label }) => (
          <div key={key}>
            <label className="mb-1 block text-[10px] text-zinc-400">{label}</label>
            <select
              aria-label={label}
              disabled={busy}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 disabled:opacity-50"
              value={current[key]}
              onChange={(event) => void change({ [key]: event.target.value })}
            >
              {availableCharacterStateValues(doc, character, key).map((value) => (
                <option key={value} value={value}>{title(value)}</option>
              ))}
            </select>
            {!isPuppet && (key === "expression" || key === "pose" || key === "outfit") && (
              <StateCardRow
                dimension={key}
                characterId={character.id}
                values={availableCharacterStateValues(doc, character, key)}
                active={current[key]}
                busy={busy}
                // The same path the dropdown takes, so click and select can
                // never diverge.
                onPick={(value) => void change({ [key]: value })}
              />
            )}
          </div>
        ))}
      </div>
      <InstanceStageControls item={item} />
      {/* Interactions sit with the actor, because that is where a creator is
          when they decide two characters should do something together. */}
      <InteractionControls item={item} />
      {isPuppet ? <PuppetControls item={item} /> : advanced ? <PoseEditControls item={item} /> : null}
      {status && <p className="mt-2 text-[10px] text-indigo-300">{status}</p>}
      {error && <p className="mt-2 text-[10px] text-red-300">{error}</p>}
      {review && (
        <div className="mt-2 border-t border-zinc-700 pt-2">
          <p className="mb-1.5 text-[10px] text-zinc-400">Review generated variation</p>
          <div className="grid grid-cols-3 gap-1">
            <button className="rounded bg-indigo-600 py-1 hover:bg-indigo-500" onClick={() => setReview(undefined)}>
              Keep
            </button>
            <button
              disabled={busy}
              className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => void change(review.generatedState, true)}
            >
              Regenerate
            </button>
            <button
              disabled={busy}
              className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => {
                useEditorStore.getState().dispatch({ type: "swap-instance-asset", instanceId: item.id, assetId: review.previousAssetId });
                setReview(undefined);
              }}
            >
              Previous
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function title(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-zinc-100">{children}</h3>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{children}</p>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-xs leading-5 text-zinc-500">{children}</p>;
}

/**
 * Draggable semantic cards (§5/§26).
 *
 * Dragging a card carries only "which dimension, which value". The canvas
 * decides whether the drop landed on a socket that accepts it, and the state
 * resolver decides how the change is realised — nothing here places an image.
 */
/**
 * Semantic state cards. CLICK is primary; drag is the power-user shortcut.
 *
 * These used to be non-interactive `<span draggable>` elements whose only
 * affordance was a "Drag onto the character's face" tooltip. Clicking — the
 * thing every creator tries first — did nothing at all. The rule now holds
 * everywhere: click applies to the SELECTED actor, drag targets a DIFFERENT
 * actor on canvas.
 *
 * Each card also says whether applying it is instant or costs a generation,
 * because that is the one implementation detail a creator genuinely needs.
 */
function StateCardRow({
  dimension,
  characterId,
  values,
  active,
  onPick,
  busy,
}: {
  dimension: "expression" | "pose" | "outfit";
  characterId: string;
  values: string[];
  active: string;
  onPick: (value: string) => void;
  busy?: boolean;
}) {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const character = doc?.characters[characterId];
  const current = doc && selection.itemId ? stateFromInstance(doc, doc.items[selection.itemId] as AssetInstance) : null;

  /** Would this pick reuse an existing render, or need a new one? */
  const isInstant = (value: string): boolean => {
    if (!doc || !character || !current) return false;
    return Boolean(findExactCharacterAsset(doc, character, { ...current, [dimension]: value }));
  };

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {values.slice(0, 10).map((value) => {
        const instant = value === active || isInstant(value);
        return (
          <button
            key={value}
            type="button"
            disabled={busy}
            draggable={!busy}
            onDragStart={(event) => {
              event.dataTransfer.setData(SOCKET_DRAG_TYPE, encodeSocketDrag({ dimension, value, characterId }));
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onPick(value)}
            title={
              value === active
                ? "Current"
                : `${instant ? "Instant — reuses an existing render" : "Needs a new render"} · click to apply, or drag onto another character`
            }
            className={`cursor-pointer rounded-full border px-2 py-0.5 text-[10px] disabled:opacity-40 ${
              value === active
                ? "border-indigo-500 bg-indigo-600/30 text-indigo-200"
                : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-indigo-600 hover:text-indigo-300"
            }`}
          >
            {title(value)}
            {value !== active && !instant && <span className="ml-1 text-[8px] text-amber-400/80">✦</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Name the thing an effect is attached to, so "detach" is an informed choice. */
function attachmentLabel(targetItemId: ID): string {
  const doc = useEditorStore.getState().doc;
  const target = doc?.items[targetItemId];
  if (!doc || target?.kind !== "asset") return "another item";
  const characterId = target.characterState?.characterId ?? doc.assets[target.sourceAssetId]?.metadata?.characterId;
  return (characterId && doc.characters[characterId]?.name) ?? doc.assets[target.sourceAssetId]?.name ?? "another item";
}

/** The full semantic bubble vocabulary (§7). */
const BUBBLE_TYPES: { id: BubbleType; label: string }[] = [
  { id: "speech", label: "Speech" },
  { id: "thought", label: "Thought" },
  { id: "whisper", label: "Whisper" },
  { id: "shout", label: "Shout" },
  { id: "narration", label: "Narration" },
  { id: "electronic", label: "Electronic / Radio" },
  { id: "tremble", label: "Tremble" },
  { id: "horror", label: "Horror" },
  { id: "cute", label: "Cute" },
  { id: "internal", label: "Internal monologue" },
  { id: "sfx", label: "SFX lettering" },
];

const SHAPES: BubbleStyle["shape"][] = [
  "ellipse",
  "rounded-rect",
  "rect",
  "spiky",
  "cloud",
  "wavy",
  "jagged",
  "scalloped",
  "none",
];

/**
 * Bubble appearance stays editable forever, because it is parameters rather
 * than a rendered image. A custom silhouette from the Manga FX shelf can be
 * used as the shape while the text layer above it keeps being text (§8).
 */
function BubbleStyleControls({ item }: { item: SpeechBubbleItem }) {
  const dispatch = useEditorStore((s) => s.dispatch);
  const doc = useEditorStore((s) => s.doc);
  const style = resolvedBubbleStyle(item);
  const patch = (change: Partial<BubbleStyle>) =>
    dispatch({ type: "update-bubble", itemId: item.id, patch: { style: change } });

  // Only uploaded/generated bubble silhouettes can act as a mask.
  const masks = doc
    ? searchLanguageAssets(doc, { category: "bubbles", format: "visual" }).map((hit) => hit.asset)
    : [];

  return (
    <details className="rounded border border-zinc-800 bg-zinc-950/50 p-2" open={false}>
      <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">Appearance</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <Label>Shape</Label>
          <select
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
            value={style.shape}
            onChange={(e) => patch({ shape: e.target.value as BubbleStyle["shape"] })}
          >
            {SHAPES.map((shape) => (
              <option key={shape} value={shape}>
                {title(shape)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Border</Label>
          <select
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
            value={style.borderStyle}
            onChange={(e) => patch({ borderStyle: e.target.value as BubbleStyle["borderStyle"] })}
          >
            {(["solid", "dashed", "double", "rough"] as const).map((border) => (
              <option key={border} value={border}>
                {title(border)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Weight</Label>
          <input
            type="number"
            min={0}
            max={20}
            step={0.5}
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
            value={style.borderWeight}
            onChange={(e) => patch({ borderWeight: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label>Tail</Label>
          <select
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
            value={style.tailType}
            onChange={(e) => patch({ tailType: e.target.value as BubbleStyle["tailType"] })}
          >
            {(["none", "point", "bubbles", "zigzag"] as const).map((tail) => (
              <option key={tail} value={tail}>
                {title(tail)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Align</Label>
          <select
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
            value={style.textAlign}
            onChange={(e) => patch({ textAlign: e.target.value as BubbleStyle["textAlign"] })}
          >
            {(["left", "center", "right"] as const).map((align) => (
              <option key={align} value={align}>
                {title(align)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Padding {Math.round(style.padding * 100)}%</Label>
          <input
            type="range"
            min={0}
            max={0.4}
            step={0.02}
            className="w-full"
            value={style.padding}
            onChange={(e) => patch({ padding: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label>Fill</Label>
          <input
            type="color"
            className="h-8 w-full rounded border border-zinc-700 bg-zinc-800"
            value={style.fill === "transparent" ? "#ffffff" : style.fill}
            onChange={(e) => patch({ fill: e.target.value })}
          />
        </div>
        <div>
          <Label>Ink</Label>
          <input
            type="color"
            className="h-8 w-full rounded border border-zinc-700 bg-zinc-800"
            value={style.textColor}
            onChange={(e) => patch({ textColor: e.target.value, stroke: e.target.value })}
          />
        </div>
      </div>

      {masks.length > 0 && (
        <div className="mt-2">
          <Label>Custom shape</Label>
          <select
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
            value={style.maskAssetId ?? ""}
            onChange={(e) => patch({ maskAssetId: e.target.value || undefined })}
          >
            <option value="">Built-in shape</option>
            {masks.map((mask) => (
              <option key={mask.id} value={mask.assetId}>
                {mask.name}
              </option>
            ))}
          </select>
          <Hint>The silhouette becomes the balloon; the text above it stays editable.</Hint>
        </div>
      )}

      {item.bubbleType === "sfx" && (
        <div className="mt-2">
          <Label>Outline {style.outlineWidth ?? 0}px</Label>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            className="w-full"
            value={style.outlineWidth ?? 0}
            onChange={(e) => patch({ outlineWidth: Number(e.target.value) })}
          />
        </div>
      )}
    </details>
  );
}

