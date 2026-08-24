/**
 * Image model capability registry — the single source of truth for what a
 * given image model may be asked to do. "OpenAI-compatible" describes a
 * transport shape, NOT a capability set: gpt-image-1 rejects response_format,
 * dall-e-2 has no quality knob, third-party gateways vary wildly.
 *
 * Adding a model = adding one registry entry. No adapter code changes.
 */

export interface ImageModelCapabilities {
  textToImage: boolean;
  /** Accept reference/input images (identity-preserving generation). */
  referenceImages: boolean;
  imageEditing: boolean;
  mask: boolean;
  /** May send a size parameter at all. */
  size: boolean;
  /** If set, only these WxH strings are legal — the builder snaps to one. */
  allowedSizes?: string[];
  quality: boolean;
  /** Native transparent-background output parameter. */
  background: boolean;
  /** May send response_format (gpt-image models REJECT this key). */
  responseFormat: boolean;
  multipleImages: boolean;
  seed: boolean;
  outputTypes: ("base64" | "url")[];
}

/** Conservative legacy default: how the pre-registry adapter behaved. */
const UNKNOWN_MODEL: ImageModelCapabilities = {
  textToImage: true,
  referenceImages: false,
  imageEditing: false,
  mask: false,
  size: true,
  quality: false,
  background: false,
  responseFormat: true,
  multipleImages: false,
  seed: false,
  outputTypes: ["base64", "url"],
};

/**
 * First match wins — order families from most to least specific.
 * Matching is by lowercase prefix so future gpt-image-* / dall-e-* revisions
 * inherit their family's contract without new code.
 */
const MODEL_FAMILIES: { match: RegExp; capabilities: ImageModelCapabilities }[] = [
  {
    match: /^gpt-image-/,
    capabilities: {
      textToImage: true,
      // Reference input exists only on the edits endpoint, which this
      // adapter does not implement — declare honestly, don't pretend.
      referenceImages: false,
      imageEditing: false,
      mask: false,
      size: true,
      allowedSizes: ["1024x1024", "1536x1024", "1024x1536"],
      quality: true,
      background: true,
      // gpt-image always returns b64_json; sending response_format is an HTTP 400.
      responseFormat: false,
      multipleImages: true,
      seed: false,
      outputTypes: ["base64"],
    },
  },
  {
    match: /^dall-e-3/,
    capabilities: {
      textToImage: true,
      referenceImages: false,
      imageEditing: false,
      mask: false,
      size: true,
      allowedSizes: ["1024x1024", "1792x1024", "1024x1792"],
      quality: true,
      background: false,
      responseFormat: true,
      multipleImages: false,
      seed: false,
      outputTypes: ["base64", "url"],
    },
  },
  {
    match: /^dall-e-2/,
    capabilities: {
      textToImage: true,
      referenceImages: false,
      imageEditing: false,
      mask: false,
      size: true,
      allowedSizes: ["256x256", "512x512", "1024x1024"],
      quality: false,
      background: false,
      responseFormat: true,
      multipleImages: true,
      seed: false,
      outputTypes: ["base64", "url"],
    },
  },
];

export function capabilitiesForModel(model: string): ImageModelCapabilities {
  const normalized = model.trim().toLowerCase();
  const family = MODEL_FAMILIES.find((entry) => entry.match.test(normalized));
  return family?.capabilities ?? UNKNOWN_MODEL;
}

/** Snap a requested WxH to the nearest allowed size, preserving orientation. */
export function snapSize(
  width: number | undefined,
  height: number | undefined,
  capabilities: ImageModelCapabilities,
): string | undefined {
  if (!capabilities.size) return undefined;
  const wanted = `${width ?? 1024}x${height ?? 1024}`;
  if (!capabilities.allowedSizes) return wanted;
  if (capabilities.allowedSizes.includes(wanted)) return wanted;
  const landscape = (width ?? 1024) > (height ?? 1024);
  const portrait = (height ?? 1024) > (width ?? 1024);
  const oriented = capabilities.allowedSizes.find((size) => {
    const [w, h] = size.split("x").map(Number);
    return landscape ? w > h : portrait ? h > w : w === h;
  });
  return oriented ?? capabilities.allowedSizes[0];
}
