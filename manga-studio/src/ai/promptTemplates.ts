/**
 * Semantic asset requests → generation prompts. Isomorphic and pure: the
 * generator dialog uses it for prompt preview, the agent's generation skill
 * uses it server-side. Keeping composition in one place is what keeps
 * "creator-native vocabulary" (pose/expression) out of provider-specific code.
 */

import type { GeneratedAssetType } from "./types";
import type { StyleProfile } from "@/domain/types";
import {
  backgroundClause,
  foregroundAssetPolicy,
  type ForegroundAssetGenerationPolicy,
} from "./foregroundPolicy";

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
  /** Manga Language Library category, for manga-effect generation. */
  languageCategory?: string;
  /** What kind of screentone, for tone generation. */
  toneType?: "texture" | "atmosphere" | "decorative" | "pattern";
  /** Tone must repeat edge to edge without a seam. */
  tileable?: boolean;
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
    case "manga-effect":
      lines.push(mangaEffectDescription(input), mangaEffectIsolation(input));
      break;
    case "prop":
      lines.push(
        `Sequential-art prop illustration: ${input.description ?? "an object"}.`,
        isolationInstruction("object", foregroundAssetPolicy({ supportsNativeTransparency: input.supportsNativeTransparency })),
      );
      break;
    case "tone":
      lines.push(toneDescription(input), toneIsolation(input));
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

/**
 * Joint-interaction prompt for composites with an object or scene participant.
 *
 * The character-only composite deliberately keeps using `buildAssetPrompt`'s
 * "character" branch untouched — that is the protected baseline. That branch's
 * isolation wording ("isolated single character", "no scenery") contradicts
 * what an object/scene composite must depict, so those mixes get their own
 * lead sentence here instead of a forked service or provider path.
 */
export function buildJointInteractionPrompt(input: {
  /** The interaction constraints, creator's free text leading. */
  description: string;
  style?: AssetPromptInput["style"];
  monochrome?: boolean;
  aspect?: "portrait" | "landscape" | "square";
  /**
   * Object composites are still cut out for panel compositing (white field).
   * Scene composites are opaque: the environment IS the picture, so no white
   * backdrop, no transparency request, no isolation wording.
   */
  cutout: boolean;
}): string {
  const backdrop = input.cutout
    ? backgroundClause(foregroundAssetPolicy({ supportsNativeTransparency: undefined }), "character")
    : "One continuous scene: every participant and the environment share the same lighting, perspective and art style, and the scene fills the entire frame.";
  const language = input.monochrome
    ? "Draw in clean monochrome black-and-white manga line art."
    : "";
  return [
    `Joint interaction illustration: ${input.description}`,
    language,
    backdrop,
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
 * How to ask for an isolated subject.
 *
 * The backdrop decision does NOT live here any more — it lives in
 * `foregroundAssetPolicy`, so character, prop, expression, SFX and decoration
 * generation cannot drift apart. What remains here is framing: what to draw and
 * what to leave out.
 *
 * No branch ever asks an opaque-only provider for a "transparent background",
 * and none names the checkerboard. Image models cannot honour negations
 * reliably: naming the checkerboard conditions them to draw one, and a model
 * with no alpha channel can only satisfy "transparent background" by painting
 * the thing transparency looks like.
 */
function isolationInstruction(subject: "character" | "object", policy: ForegroundAssetGenerationPolicy): string {
  const framing =
    subject === "character"
      ? "Isolated single character, complete unbroken silhouette, nothing cropped. No scenery, no environment, no floor, no shadow on the ground, no frame, no border, no text, no speech bubbles."
      : "Single isolated object, complete unbroken silhouette. No scenery, no surface it rests on, no shadow on the ground, no frame, no text.";
  return `${framing} ${backgroundClause(policy, subject)}`;
}

function characterIsolationInstruction(input: AssetPromptInput | Omit<AssetPromptInput, "assetType">): string {
  const policy = foregroundAssetPolicy({ supportsNativeTransparency: input.supportsNativeTransparency });
  // Monochrome states the art language and the backdrop together, so the model
  // never has to infer that "no colour" also governs what is behind the figure.
  const language = input.monochrome
    ? "Draw the character as clean monochrome black-and-white manga line art."
    : "";
  return [language, isolationInstruction("character", policy)].filter(Boolean).join(" ");
}

export function defaultAspect(assetType: GeneratedAssetType): "portrait" | "landscape" | "square" {
  if (assetType === "background") return "landscape";
  // A tone is laid over a panel and often tiled, so it is generated square —
  // a portrait tile would repeat with visibly rectangular seams.
  if (assetType === "prop" || assetType === "manga-effect" || assetType === "tone") return "square";
  return "portrait";
}

/**
 * Screentone generation (§10).
 *
 * A tone is an OVERLAY, not a picture: it is asked for as manga screentone
 * vocabulary — the terms an image model has actually seen attached to this kind
 * of artwork — and explicitly told to contain no scene, no character and no
 * frame, because anything representational stops working the moment it is laid
 * over someone's face.
 */
function toneDescription(input: AssetPromptInput): string {
  const type = input.toneType ?? "texture";
  const subject =
    type === "atmosphere"
      ? "Manga screentone atmosphere overlay"
      : type === "decorative"
        ? "Manga decorative screentone overlay"
        : type === "pattern"
          ? "Seamless manga screentone pattern tile"
          : "Manga screentone texture overlay";
  const seamless = input.tileable
    ? "Seamlessly tileable: the pattern must repeat edge to edge with no visible seam, and no element may be cut off at the border."
    : "";
  return [
    `${subject}: ${input.description ?? "a screentone"}.`,
    "Flat graphic overlay artwork only. No scene, no characters, no objects, no perspective, no horizon, no frame, no border, no text.",
    seamless,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A tone rides the SAME white-background policy as every other foreground
 * asset, so the existing transparency extraction turns it into a usable
 * overlay. There is deliberately no tone-specific extraction pipeline.
 */
function toneIsolation(input: AssetPromptInput): string {
  const policy = foregroundAssetPolicy({ supportsNativeTransparency: input.supportsNativeTransparency });
  return backgroundClause(policy, "pattern");
}

/**
 * Manga-language generation (§5/§16).
 *
 * The category is stated as manga vocabulary rather than as a generic subject,
 * because "emotion mark" and "screentone tile" are terms an image model has
 * seen in manga context and "a small graphic" is not. Project art direction is
 * appended by the shared style instruction, so a monochrome project cannot
 * receive a full-colour sparkle.
 */
const LANGUAGE_CATEGORY_PHRASING: Record<string, string> = {
  bubbles: "manga speech balloon outline, empty inside with no text or lettering",
  effects: "manga effect line artwork",
  tones: "seamless manga screentone texture tile",
  emotion: "manga emotion symbol (the small iconic mark drawn beside a character)",
  sfx: "hand-drawn manga sound-effect lettering",
  decorations: "decorative manga graphic element",
};

function mangaEffectDescription(input: AssetPromptInput): string {
  const phrasing = LANGUAGE_CATEGORY_PHRASING[input.languageCategory ?? "decorations"] ?? LANGUAGE_CATEGORY_PHRASING.decorations;
  return `A single ${phrasing}: ${input.description ?? "a manga effect"}.`;
}

function mangaEffectIsolation(input: AssetPromptInput): string {
  const policy = foregroundAssetPolicy({ supportsNativeTransparency: input.supportsNativeTransparency });
  // A tone tile must fill its frame; every other language asset is one
  // isolated graphic that will be composited over artwork.
  const framing =
    input.languageCategory === "tones"
      ? "The texture fills the entire frame edge to edge, evenly, with no border, no subject, and no text."
      : "One single isolated graphic, centered, complete and uncropped. No characters, no scenery, no frame, no border, no watermark, and no text unless the graphic itself is lettering.";
  return `${framing} ${backgroundClause(policy, "graphic")}`;
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
