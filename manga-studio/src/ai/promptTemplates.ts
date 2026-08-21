/**
 * Semantic asset requests → generation prompts. Isomorphic and pure: the
 * generator dialog uses it for prompt preview, the agent's generation skill
 * uses it server-side. Keeping composition in one place is what keeps
 * "creator-native vocabulary" (pose/expression) out of provider-specific code.
 */

import type { GeneratedAssetType } from "./types";
import type { StyleProfile } from "@/domain/types";

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
  /** Provider can emit a real alpha channel; otherwise we ask for a keyable flat field. */
  supportsNativeTransparency?: boolean;
  /** Project style is black-and-white line art, which selects the white-background strategy. */
  monochrome?: boolean;
  /**
   * Camera the asset is being generated for (§18). Provider-neutral sentences
   * so a new character or background matches the stage it joins.
   */
  cameraContext?: string[];
  aspect?: "portrait" | "landscape" | "square";
  /** Provider-neutral project art direction. */
  style?: Pick<StyleProfile, "name" | "positivePrompt" | "visualProperties">;
}

const LEGACY_STYLE = "black-and-white manga line art style, clean ink lines, screentone shading";

export function buildAssetPrompt(input: AssetPromptInput): string {
  const lines: string[] = [];
  switch (input.assetType) {
    case "character":
      lines.push(
        `Full-body sequential-art character design${input.characterName ? ` of ${input.characterName}` : ""}.`,
        input.characterDescription ?? "",
        input.description ?? "",
        "Standing neutral pose, front view, whole body visible head to feet.",
        characterIsolationInstruction(input),
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
          : `Full-body sequential-art character${input.characterName ? ` ${input.characterName}` : ""}${
              input.characterDescription ? ` (${input.characterDescription})` : ""
            } with ${slot}.`,
        input.hasReference
          ? "Keep the face, hairstyle, proportions, outfit and art style identical to the reference."
          : "",
        input.outfit ? `Outfit: ${input.outfit}.` : "",
        input.view ? `Camera angle: ${input.view}.` : "",
        input.description ?? "",
        `Whole body visible head to feet. ${characterIsolationInstruction(input)}`,
      );
      break;
    }
    case "background":
      lines.push(
        `Sequential-art background scene: ${input.description ?? "a scene"}.`,
        "Detailed environment, no people, no characters, no text.",
      );
      break;
    case "prop":
      lines.push(
        `Sequential-art prop illustration: ${input.description ?? "an object"}.`,
        isolationInstruction(
          "object",
          selectBackgroundStrategy({
            supportsNativeTransparency: input.supportsNativeTransparency,
            monochrome: input.monochrome,
          }),
        ),
      );
      break;
  }
  lines.push(...(input.cameraContext ?? []));
  lines.push(styleInstruction(input.style), aspectHint(input.aspect ?? defaultAspect(input.assetType)));
  return lines.filter(Boolean).join(" ");
}

/** Complete prompt for one semantic character render, always identity anchored. */
export function buildCharacterStatePrompt(input: Omit<AssetPromptInput, "assetType">): string {
  return [
    input.hasReference
      ? `Redraw the exact same manga character from the canonical identity reference: ${input.characterName ?? "character"}.`
      : `Full-body sequential-art character${input.characterName ? ` ${input.characterName}` : ""}.`,
    input.characterDescription ?? "",
    `Pose: ${input.pose ?? "standing"}.`,
    `Expression: ${input.expression ?? "neutral"}.`,
    `Outfit: ${input.outfit ?? "default outfit"}.`,
    `View: ${input.view ?? "front"}.`,
    input.hasReference
      ? "Preserve the exact visual language, face design, proportions, hairstyle, outfit, and line style of the supplied character reference. Change only the requested pose and expression. Do not redesign the character."
      : "Keep the design distinctive and internally consistent.",
    input.description ?? "",
    `Whole body visible head to feet. ${characterIsolationInstruction(input)}`,
    ...(input.cameraContext ?? []),
    styleInstruction(input.style),
    aspectHint(input.aspect ?? "portrait"),
  ]
    .filter(Boolean)
    .join(" ");
}

function styleInstruction(style: AssetPromptInput["style"]): string {
  if (!style) return LEGACY_STYLE;
  const properties = style.visualProperties
    ? Object.entries(style.visualProperties)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ")
    : "";
  return `Project art style — ${style.name}: ${style.positivePrompt}.${properties ? ` Visual properties: ${properties}.` : ""} Keep this visual language consistent across the project.`;
}

/**
 * The colour the extractor keys out when a provider cannot emit alpha.
 *
 * Magenta is chosen because it is maximally distant from ink, paper, and skin
 * in RGB, so the perimeter flood has a wide safety margin, and because it is
 * far rarer in manga artwork than a green screen would be.
 */
export const CHROMA_KEY_PROMPT_COLOR = "magenta (RGB 255, 0, 255)";

/**
 * How to ask for an isolated subject.
 *
 * Critically, no branch ever asks an opaque-only provider for a "transparent
 * background", and none uses the word checkerboard. Image models cannot honour
 * negations reliably, so naming the checkerboard conditions them to draw one;
 * and a model with no alpha channel can only satisfy "transparent background"
 * by painting the thing transparency looks like — the grey grid. That pairing
 * produced the baked checkerboards this pipeline then failed to remove.
 *
 * Every branch instead asks for something an opaque model CAN deliver and the
 * extractor can key deterministically: one flat, unbroken field.
 */
export type BackgroundStrategy = "native-alpha" | "white" | "chroma-key";

/**
 * Which background to ask the model for.
 *
 * Monochrome line art gets a pure white field rather than a chroma key. A
 * saturated screen reflects onto the subject, and the model bakes that spill
 * into hair strands and silhouette edges as part of the artwork — no
 * post-process can separate it from intended colour afterwards, and on a
 * black-and-white asset a magenta halo is glaring. White cannot tint anything.
 *
 * White is only safe because extraction is connectivity-based: the flood
 * removes perimeter-connected background and never touches enclosed whites, so
 * eye whites, white clothing, highlights, and interior gaps survive. A global
 * "near-white becomes transparent" rule could not use this strategy at all.
 *
 * Coloured art keeps the chroma key: its own palette can occupy the full
 * near-white range, where a white background offers no separation.
 */
export function selectBackgroundStrategy(input: {
  supportsNativeTransparency?: boolean;
  monochrome?: boolean;
}): BackgroundStrategy {
  if (input.supportsNativeTransparency) return "native-alpha";
  return input.monochrome ? "white" : "chroma-key";
}

function backgroundInstruction(subject: "character" | "object", strategy: BackgroundStrategy): string {
  switch (strategy) {
    case "native-alpha":
      return `Output a PNG whose background is genuinely empty using a real alpha channel.`;
    case "white":
      return `Place the ${subject} on a completely uniform pure white (#FFFFFF) background. The background must contain no objects, texture, gradient, shadows, pattern, or colour.`;
    case "chroma-key":
      return `Place the ${subject} on a completely flat, uniform, solid ${CHROMA_KEY_PROMPT_COLOR} background — one single unbroken colour covering every pixel behind the ${subject}, with no gradient, shading, texture, pattern, or objects.`;
  }
}

function isolationInstruction(subject: "character" | "object", strategy: BackgroundStrategy): string {
  const framing =
    subject === "character"
      ? "Isolated single character, complete unbroken silhouette, nothing cropped. No scenery, no environment, no floor, no shadow on the ground, no frame, no border, no text, no speech bubbles."
      : "Single isolated object, complete unbroken silhouette. No scenery, no surface it rests on, no shadow on the ground, no frame, no text.";
  return `${framing} ${backgroundInstruction(subject, strategy)}`;
}

function characterIsolationInstruction(input: AssetPromptInput | Omit<AssetPromptInput, "assetType">): string {
  const strategy = selectBackgroundStrategy({
    supportsNativeTransparency: input.supportsNativeTransparency,
    monochrome: input.monochrome,
  });
  // Monochrome renders state the art language and the background together, so
  // the model never has to infer that "no colour" also governs the backdrop.
  if (strategy === "white") {
    return "Draw the character as clean monochrome black-and-white manga line art on a completely uniform pure white background. The background must contain no objects, texture, gradient, shadows, pattern, checkerboard, or colour. Isolated single character, complete unbroken silhouette, nothing cropped, no frame, no text, no speech bubbles.";
  }
  return isolationInstruction("character", strategy);
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
