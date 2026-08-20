/**
 * Semantic asset requests → generation prompts. Isomorphic and pure: the
 * generator dialog uses it for prompt preview, the agent's generation skill
 * uses it server-side. Keeping composition in one place is what keeps
 * "creator-native vocabulary" (pose/expression) out of provider-specific code.
 */

import type { GeneratedAssetType } from "./types";

export interface AssetPromptInput {
  assetType: GeneratedAssetType;
  /** Free-text description: scene, subject, or extra instruction. */
  description?: string;
  characterName?: string;
  characterDescription?: string;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  /** True when a character reference image accompanies the request. */
  hasReference?: boolean;
  aspect?: "portrait" | "landscape" | "square";
}

const MANGA_STYLE = "black-and-white manga line art style, clean ink lines, screentone shading";

export function buildAssetPrompt(input: AssetPromptInput): string {
  const lines: string[] = [];
  switch (input.assetType) {
    case "character":
      lines.push(
        `Full-body manga character design${input.characterName ? ` of ${input.characterName}` : ""}.`,
        input.characterDescription ?? "",
        input.description ?? "",
        "Standing neutral pose, front view, whole body visible head to feet.",
        "Isolated single character on a plain white background, no scenery, no text, no speech bubbles.",
      );
      break;
    case "character-pose":
    case "character-expression": {
      const slot =
        input.assetType === "character-pose"
          ? `pose: ${input.pose ?? "standing"}${input.expression ? `, expression: ${input.expression}` : ""}`
          : `expression: ${input.expression ?? "neutral"}${input.pose ? `, pose: ${input.pose}` : ""}`;
      lines.push(
        input.hasReference
          ? `Redraw the exact same manga character from the reference image with a new ${slot}.`
          : `Full-body manga character${input.characterName ? ` ${input.characterName}` : ""}${
              input.characterDescription ? ` (${input.characterDescription})` : ""
            } with ${slot}.`,
        input.hasReference
          ? "Keep the face, hairstyle, proportions, outfit and art style identical to the reference."
          : "",
        input.outfit ? `Outfit: ${input.outfit}.` : "",
        input.view ? `Camera angle: ${input.view}.` : "",
        input.description ?? "",
        "Whole body visible, isolated single character on a plain white background, no scenery, no text.",
      );
      break;
    }
    case "background":
      lines.push(
        `Manga background scene: ${input.description ?? "a scene"}.`,
        "Detailed environment, no people, no characters, no text.",
      );
      break;
    case "prop":
      lines.push(
        `Manga prop illustration: ${input.description ?? "an object"}.`,
        "Single isolated object on a plain white background, no scenery, no text.",
      );
      break;
  }
  lines.push(MANGA_STYLE, aspectHint(input.aspect ?? defaultAspect(input.assetType)));
  return lines.filter(Boolean).join(" ");
}

/** Complete prompt for one semantic character render, always identity anchored. */
export function buildCharacterStatePrompt(input: Omit<AssetPromptInput, "assetType">): string {
  return [
    input.hasReference
      ? `Redraw the exact same manga character from the canonical identity reference: ${input.characterName ?? "character"}.`
      : `Full-body manga character${input.characterName ? ` ${input.characterName}` : ""}.`,
    input.characterDescription ?? "",
    `Pose: ${input.pose ?? "standing"}.`,
    `Expression: ${input.expression ?? "neutral"}.`,
    `Outfit: ${input.outfit ?? "default outfit"}.`,
    `View: ${input.view ?? "front"}.`,
    input.hasReference
      ? "Preserve identity exactly: same face, facial structure, hairstyle, body proportions, and line-art style. Follow the requested outfit while keeping the character recognizable. Do not redesign the character."
      : "Keep the design distinctive and internally consistent.",
    input.description ?? "",
    "Whole body visible head to feet, isolated single character on a plain white background, no scenery, no text, no speech bubbles.",
    MANGA_STYLE,
    aspectHint(input.aspect ?? "portrait"),
  ]
    .filter(Boolean)
    .join(" ");
}

export function defaultAspect(assetType: GeneratedAssetType): "portrait" | "landscape" | "square" {
  if (assetType === "background") return "landscape";
  if (assetType === "prop") return "square";
  return "portrait";
}

function aspectHint(aspect: "portrait" | "landscape" | "square"): string {
  switch (aspect) {
    case "portrait":
      return "Portrait orientation, 2:3 aspect ratio.";
    case "landscape":
      return "Landscape orientation, 3:2 aspect ratio.";
    case "square":
      return "Square 1:1 aspect ratio.";
  }
}
