/**
 * The built-in manga-language catalogue.
 *
 * Built-ins are **code, not document data**. They are merged into the library
 * at read time rather than written into every project, which means:
 *
 *   - they cannot be deleted into undeletable clutter (§15),
 *   - a new built-in appears in existing projects on upgrade with no migration,
 *   - and a saved document only carries what the creator actually owns.
 *
 * Every built-in here is *structured* — a parameterized definition the editor
 * instantiates and the creator keeps editing. None is a generated bitmap.
 */

import { defaultBubbleStyle } from "@/domain/bubbleStyles";
import type { BubbleType, EffectKind, MangaLanguageAsset, MangaLanguageCategory } from "@/domain/types";

/** A built-in before it is given a project id — the shape the catalogue stores. */
export type BuiltinLanguageAsset = Omit<MangaLanguageAsset, "projectId" | "createdAt"> & {
  builtinId: string;
};

const EPOCH = "1970-01-01T00:00:00.000Z";

function bubble(builtinId: string, name: string, bubbleType: BubbleType, tags: string[]): BuiltinLanguageAsset {
  return {
    id: `builtin:${builtinId}`,
    builtinId,
    category: bubbleType === "sfx" ? "sfx" : "bubbles",
    name,
    source: "builtin",
    format: "structured",
    tags,
    structuredDefinition: { kind: "bubble", bubbleType, style: defaultBubbleStyle(bubbleType) },
  };
}

function effect(
  builtinId: string,
  name: string,
  category: MangaLanguageCategory,
  effectKind: EffectKind,
  params: Record<string, unknown>,
  tags: string[],
): BuiltinLanguageAsset {
  return {
    id: `builtin:${builtinId}`,
    builtinId,
    category,
    name,
    source: "builtin",
    format: "structured",
    tags,
    structuredDefinition: { kind: "effect", effectKind, params },
  };
}

function sfx(builtinId: string, name: string, text: string, tags: string[]): BuiltinLanguageAsset {
  return {
    id: `builtin:${builtinId}`,
    builtinId,
    category: "sfx",
    name,
    source: "builtin",
    format: "structured",
    tags,
    structuredDefinition: { kind: "sfx", text, style: defaultBubbleStyle("sfx") },
  };
}

/**
 * Presets are variations on the existing typed effect parameters, not new
 * renderers. "Radial speed" and "trailing lines" are both speed-lines with
 * different numbers — which is exactly why the parameterized model was worth
 * keeping. New *kinds* are a renderer change; new *presets* are data.
 */
export const BUILTIN_LANGUAGE_ASSETS: BuiltinLanguageAsset[] = [
  // ── Bubbles (§7) ──
  bubble("bubble-speech", "Speech", "speech", ["dialogue", "talk"]),
  bubble("bubble-thought", "Thought", "thought", ["dialogue", "thinking", "inner"]),
  bubble("bubble-whisper", "Whisper", "whisper", ["dialogue", "quiet", "soft"]),
  bubble("bubble-shout", "Shout", "shout", ["dialogue", "loud", "yell", "scream"]),
  bubble("bubble-narration", "Narration Box", "narration", ["caption", "narrator"]),
  bubble("bubble-electronic", "Electronic / Radio", "electronic", ["phone", "radio", "robot", "tv"]),
  bubble("bubble-tremble", "Tremble", "tremble", ["shaky", "nervous", "afraid", "weak"]),
  bubble("bubble-horror", "Horror", "horror", ["scary", "dread", "trembling", "dark", "creepy"]),
  bubble("bubble-cute", "Cute", "cute", ["shoujo", "sweet", "soft"]),
  bubble("bubble-internal", "Internal Monologue", "internal", ["inner", "thinking", "caption"]),

  // ── Motion (§9) ──
  effect("fx-speed-horizontal", "Horizontal Speed", "effects", "speed-lines", { direction: 0, density: 0.55, length: 0.8, spread: 0.12 }, ["motion", "speed", "run", "fast"]),
  effect("fx-speed-radial", "Radial Speed", "effects", "focus-lines", { density: 0.7, radius: 0.2, intensity: 0.85 }, ["motion", "speed", "zoom", "rush"]),
  effect("fx-speed-trailing", "Trailing Lines", "effects", "speed-lines", { direction: Math.PI, density: 0.35, length: 0.95, spread: 0.3 }, ["motion", "trail", "drag"]),
  effect("fx-shake", "Shake", "effects", "speed-lines", { direction: Math.PI / 2, density: 0.8, length: 0.25, spread: 0.6 }, ["motion", "shake", "vibrate", "tremble"]),
  effect("fx-impact", "Impact", "effects", "impact-burst", { spikes: 18, irregularity: 0.4, intensity: 0.95 }, ["motion", "impact", "hit", "crash", "boom"]),

  // ── Focus (§9) ──
  effect("fx-focus-rays", "Focus Rays", "effects", "focus-lines", { density: 0.6, radius: 0.35 }, ["focus", "attention", "rays", "dramatic"]),
  effect("fx-focus-black", "Black Focus Rays", "effects", "focus-lines", { density: 0.85, radius: 0.22, intensity: 1 }, ["focus", "dramatic", "black", "intense"]),
  effect("fx-focus-soft", "Soft Focus Burst", "effects", "impact-burst", { spikes: 28, irregularity: 0.15, intensity: 0.5 }, ["focus", "soft", "glow", "gentle"]),

  // ── Emotion (§9) ──
  effect("fx-emotion-shock", "Shock", "emotion", "emotion", { emotion: "shock", intensity: 0.9 }, ["emotion", "shock", "shocked", "surprise", "surprised", "startled"]),
  effect("fx-emotion-gloom", "Gloom", "emotion", "emotion", { emotion: "gloom", intensity: 0.8 }, ["emotion", "gloom", "sad", "depressed", "despair"]),
  effect("fx-emotion-anger", "Anger", "emotion", "emotion", { emotion: "anger", intensity: 0.9 }, ["emotion", "anger", "angry", "mad", "rage", "vein"]),
  effect("fx-emotion-sweat", "Sweat", "emotion", "emotion", { emotion: "sweat", intensity: 0.7 }, ["emotion", "sweat", "nervous", "awkward", "drop"]),
  effect("fx-emotion-sparkle", "Sparkle", "emotion", "emotion", { emotion: "sparkle", intensity: 0.8 }, ["emotion", "sparkle", "shine", "shoujo", "pretty", "glitter"]),

  // ── Tone (§9) ──
  effect("tone-dot", "Screentone Dot", "tones", "screentone", { dotSize: 0.35, spacing: 0.5, angle: Math.PI / 4 }, ["tone", "screentone", "dots", "shading"]),
  effect("tone-gradient", "Gradient Tone", "tones", "screentone", { dotSize: 0.5, spacing: 0.35, angle: 0, intensity: 0.45 }, ["tone", "gradient", "fade", "shading"]),
  effect("tone-shadow", "Shadow Tone", "tones", "screentone", { dotSize: 0.7, spacing: 0.25, angle: Math.PI / 4, intensity: 0.85 }, ["tone", "shadow", "dark", "shading"]),
  effect("tone-noise", "Noise Tone", "tones", "screentone", { dotSize: 0.2, spacing: 0.15, angle: 1.1, intensity: 0.4 }, ["tone", "noise", "grain", "texture"]),

  // ── SFX lettering (§14) ──
  sfx("sfx-bam", "BAM", "BAM", ["sfx", "impact", "hit", "loud"]),
  sfx("sfx-whoosh", "WHOOSH", "WHOOSH", ["sfx", "motion", "wind", "fast"]),
  sfx("sfx-don", "ドン", "ドン", ["sfx", "impact", "japanese", "boom"]),
  sfx("sfx-zuki", "ズキ", "ズキ", ["sfx", "pain", "japanese", "throb"]),
];

const BY_ID = new Map(BUILTIN_LANGUAGE_ASSETS.map((asset) => [asset.id, asset]));

export function builtinLanguageAsset(id: string): BuiltinLanguageAsset | undefined {
  return BY_ID.get(id);
}

/** Materialize the catalogue for one project. Pure — it stores nothing. */
export function builtinLibrary(projectId: string): MangaLanguageAsset[] {
  return BUILTIN_LANGUAGE_ASSETS.map((asset) => ({ ...asset, projectId, createdAt: EPOCH }));
}
