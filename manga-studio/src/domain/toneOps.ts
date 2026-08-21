/**
 * Tone operations — pure `doc → doc`, like every other domain module.
 *
 * Nothing here writes to an asset. That is the whole point: a tone is added,
 * edited, masked and removed entirely within the panel's item list, so the
 * character underneath is byte-identical before and after. If a function in
 * this file ever needs to touch `doc.assets`, the non-destructive guarantee has
 * been broken somewhere upstream.
 */

import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import { newId } from "./factory";
import { insertItem } from "./itemOps";
import { normalizeToneParams, type ProceduralToneParams, type ToneMask, type ToneRef, tonePreset } from "./tones";
import type { ID, ProjectDocument, ToneItem } from "./types";

export interface AddToneInput {
  panelId: ID;
  /** A built-in procedural preset. */
  presetId?: string;
  /** An explicit procedural pattern, when not coming from a preset. */
  params?: Partial<ProceduralToneParams>;
  /** A generated or uploaded tone image. */
  assetId?: ID;
  tileable?: boolean;
  mask?: ToneMask;
}

/**
 * Lay a tone over a panel.
 *
 * It arrives covering the whole panel, because that is what a creator reaching
 * for "Dark Mood" means. Narrowing it to a shirt is a second, deliberate act.
 */
export function addTone(doc: ProjectDocument, input: AddToneInput): { doc: ProjectDocument; itemId: ID } {
  if (!doc.panels[input.panelId]) throw new Error(`Unknown panel: ${input.panelId}`);

  let tone: ToneRef;
  if (input.assetId) {
    if (!doc.assets[input.assetId]) throw new Error(`Unknown tone asset: ${input.assetId}`);
    tone = { source: "asset", assetId: input.assetId, tileable: input.tileable ?? true };
  } else {
    const preset = input.presetId ? tonePreset(input.presetId) : undefined;
    if (input.presetId && !preset) throw new Error(`Unknown tone preset: ${input.presetId}`);
    tone = {
      source: "procedural",
      presetId: preset?.id,
      params: normalizeToneParams({ ...(preset?.params ?? {}), ...(input.params ?? {}) }),
    };
  }

  const next = cloneDoc(doc);
  const rect = panelPxRect(next, input.panelId);
  const item: ToneItem = {
    id: newId(),
    kind: "tone",
    panelId: input.panelId,
    tone,
    mask: input.mask,
    clipToPanel: true,
    scale: 1,
    cx: rect.width / 2,
    cy: rect.height / 2,
    width: rect.width,
    height: rect.height,
    rotation: 0,
    opacity: 1,
  };
  insertItem(next, item);
  touch(next);
  return { doc: next, itemId: item.id };
}

export interface TonePatch {
  params?: Partial<ProceduralToneParams>;
  opacity?: number;
  scale?: number;
  rotation?: number;
  invert?: boolean;
  clipToPanel?: boolean;
  tileable?: boolean;
  /** `null` clears the mask, returning the tone to the whole panel. */
  mask?: ToneMask | null;
}

export function updateTone(doc: ProjectDocument, itemId: ID, patch: TonePatch): ProjectDocument {
  const existing = doc.items[itemId];
  if (!existing || existing.kind !== "tone") throw new Error(`Not a tone layer: ${itemId}`);

  const next = cloneDoc(doc);
  const item = next.items[itemId] as ToneItem;

  if (patch.params && item.tone.source === "procedural") {
    item.tone = {
      ...item.tone,
      params: normalizeToneParams({ ...item.tone.params, ...patch.params }),
    };
  }
  if (patch.tileable !== undefined && item.tone.source === "asset") {
    item.tone = { ...item.tone, tileable: patch.tileable };
  }
  if (patch.opacity !== undefined) item.opacity = Math.min(1, Math.max(0, patch.opacity));
  if (patch.scale !== undefined) item.scale = Math.min(8, Math.max(0.05, patch.scale));
  if (patch.rotation !== undefined) item.rotation = patch.rotation;
  if (patch.invert !== undefined) item.invert = patch.invert;
  if (patch.clipToPanel !== undefined) item.clipToPanel = patch.clipToPanel;
  if (patch.mask !== undefined) {
    if (patch.mask === null) delete item.mask;
    else item.mask = patch.mask;
  }

  touch(next);
  return next;
}
