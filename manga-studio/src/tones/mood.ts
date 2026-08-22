/**
 * "Make this panel feel gloomy."
 *
 * Creators ask for tone by FEELING, not by frequency. This maps the words they
 * actually use onto the built-in patterns, so the Agent reaches for the same
 * shelf a person would instead of inventing parameters.
 *
 * Shared rather than living inside the Agent: the vocabulary belongs to the
 * tone system, and a future "suggest a tone" control in the UI must agree with
 * what the Agent picks.
 */

import { tonePreset, type TonePreset } from "@/domain/tones";

/** Mood words → the preset that expresses them. First match wins. */
const MOOD_MAP: { pattern: RegExp; presetId: string }[] = [
  { pattern: /\b(gloom\w*|despair\w*|hopeless|depress\w*|bleak|grim|miserab\w*|somber|sombre)\b/i, presetId: "gloom" },
  { pattern: /\b(dark|darkness|night|shadow|shadowy|black out|unconscious)\b/i, presetId: "darkness" },
  { pattern: /\b(anxious|anxiety|panick\w*|panic|dread|fear\w*|afraid|scared|tense|unease\w*|nervous)\b/i, presetId: "anxiety-hatch" },
  { pattern: /\b(romance|romantic|love|loving|shoujo|tender|dreamy|flowers?)\b/i, presetId: "gradient-light" },
  { pattern: /\b(daylight|day\s?light|bright\w*|sunny|sunlight|sunshine|cheerful|morning|hopeful|happy)\b/i, presetId: "gradient-light" },
  { pattern: /\b(warm|gentle|cozy|calm|peaceful)\b/i, presetId: "dot-20" },
  { pattern: /\b(cold|lonely|solitary|isolated|empty|quiet|still)\b/i, presetId: "lines-vertical" },
  { pattern: /\b(nostalg\w*|memory|memories|flashback|wistful|longing)\b/i, presetId: "dot-fine" },
  { pattern: /\b(oppress\w*|claustrophobic|ominous|suffocat\w*|dramatic)\b/i, presetId: "gradient-dark" },
  { pattern: /\b(speed|fast|rush\w*|motion|moving|dash\w*)\b/i, presetId: "speed-diagonal" },
  { pattern: /\b(impact|hit|hitting|punch\w*|crash\w*|slam\w*|smash\w*|collid\w*)\b/i, presetId: "impact-dense" },
  { pattern: /\b(grain|grainy|noise|noisy|rough|dirty|gritty|texture[d]?)\b/i, presetId: "noise-light" },
  { pattern: /\b(cross[- ]?hatch\w*|heavy shadow|deep shadow)\b/i, presetId: "cross-hatch" },
  { pattern: /\b(rain|raining|vertical lines?|falling)\b/i, presetId: "lines-vertical" },
  { pattern: /\b(gradient|fade|fading|ramp)\b/i, presetId: "gradient-light" },
  { pattern: /\b(light|subtle|faint|soft)\b/i, presetId: "dot-20" },
  { pattern: /\b(heavy|dense|deep|strong)\b/i, presetId: "dot-50" },
  { pattern: /\b(screentone|tone|shading|shade|grey|gray)\b/i, presetId: "dot-30" },
];

/**
 * The tone a phrase is asking for, if any.
 *
 * Returns undefined rather than a default when nothing matches: silently
 * applying a mid-grey to a request nobody understood is worse than saying so.
 */
export function toneForMood(text: string | undefined): TonePreset | undefined {
  if (!text) return undefined;
  for (const entry of MOOD_MAP) {
    if (entry.pattern.test(text)) return tonePreset(entry.presetId);
  }
  return undefined;
}
