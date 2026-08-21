/**
 * How a tone is named to a human — and to the Agent.
 *
 * One implementation, because a tone the Layers panel calls "Dot 30%" must be
 * the same thing the Agent is told about. Two descriptions drift, and then the
 * creator and the Agent are talking about different layers.
 */

import { normalizeToneParams, tonePreset, type ProceduralToneParams } from "./tones";
import type { ProjectDocument, ToneItem } from "./types";

const TYPE_LABELS: Record<ProceduralToneParams["type"], string> = {
  dot: "Dots",
  line: "Lines",
  "cross-hatch": "Cross Hatch",
  gradient: "Gradient",
  noise: "Noise",
};

export function describeTone(doc: ProjectDocument, item: ToneItem): string {
  if (item.tone.source === "asset") {
    return doc.assets[item.tone.assetId]?.name ?? "Tone";
  }
  const preset = item.tone.presetId ? tonePreset(item.tone.presetId) : undefined;
  const params = normalizeToneParams(item.tone.params);
  // A preset that has been edited is no longer that preset, and saying it still
  // is would make the Layers panel lie about what the creator is looking at.
  const edited =
    preset &&
    (Math.abs(preset.params.density - params.density) > 0.001 ||
      Math.abs(preset.params.frequency - params.frequency) > 0.001 ||
      Math.abs(preset.params.angle - params.angle) > 0.001);
  if (preset && !edited) return preset.name;
  return `${TYPE_LABELS[params.type]} ${Math.round(params.density * 100)}%`;
}

/** The Layers-panel label. */
export function toneLabel(doc: ProjectDocument, item: ToneItem): string {
  return describeTone(doc, item);
}
