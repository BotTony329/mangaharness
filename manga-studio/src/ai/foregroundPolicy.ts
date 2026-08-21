/**
 * The single policy for generating any asset that will later be cut out.
 *
 * ## Why this exists
 *
 * Characters, props, expression variations, SFX graphics and manga-language
 * decorations all need transparency, and each used to decide its own backdrop
 * through `selectBackgroundStrategy`. Coloured artwork got a **magenta chroma
 * key**, which is the root cause of the purple fringe that kept coming back:
 *
 *   - a saturated screen is blended into every anti-aliased edge pixel by
 *     definition, so the contamination is created deliberately, at generation
 *     time, before any extraction code runs;
 *   - the model also bounces the screen colour onto hair strands and silhouette
 *     edges as *intended* artwork, which no post-process can separate;
 *   - and every extraction path then had to be taught to undo it, so a single
 *     path that forgot reproduced the halo.
 *
 * Decontamination made the symptom recoverable. Not introducing the matte makes
 * it impossible. White cannot tint anything, so an edge blended with white is a
 * lighter version of the artwork rather than a different hue.
 *
 * ## Why white is safe here specifically
 *
 * Only because extraction is connectivity-based: the perimeter flood removes
 * background reachable from the border and never enters enclosed regions. White
 * shirts, eye whites, highlights, paper and jewellery survive because they are
 * fenced in by artwork. A global "near-white becomes transparent" rule could
 * not use this strategy at all.
 *
 * There is exactly one exported decision here. Nothing else may choose a
 * backdrop, and no component should carry its own "#FFFFFF" string.
 */

/** Backdrops a foreground asset may be generated on. Chroma keys are absent by design. */
export type ForegroundBackground = "native-alpha" | "pure-white";

export interface ForegroundAssetGenerationPolicy {
  background: ForegroundBackground;
  extraction: "provider-alpha" | "white-background-removal";
  /** Extraction output must pass the transparency contract before registration. */
  validation: "required";
}

/**
 * Resolve the policy for one generation.
 *
 * A provider that emits a real alpha channel is still preferred — there is no
 * matte at all in that case. Everything else generates on pure white.
 * Monochrome and colour take the SAME path now; the old split is what allowed a
 * chroma key to survive for coloured art.
 */
export function foregroundAssetPolicy(input: {
  supportsNativeTransparency?: boolean;
}): ForegroundAssetGenerationPolicy {
  return input.supportsNativeTransparency
    ? { background: "native-alpha", extraction: "provider-alpha", validation: "required" }
    : { background: "pure-white", extraction: "white-background-removal", validation: "required" };
}

/**
 * The backdrop clause every foreground prompt uses.
 *
 * Names what the background must be AND what must not appear because of it.
 * Image models do not honour bare negations, so each clause pairs the
 * prohibition with the positive instruction it replaces — "clean separation"
 * rather than only "no coloured outline".
 */
export function backgroundClause(policy: ForegroundAssetGenerationPolicy, subject: string): string {
  if (policy.background === "native-alpha") {
    return `Output a PNG whose background is genuinely empty using a real alpha channel, with clean anti-aliased edges and no coloured fringe around the ${subject}.`;
  }
  return [
    `Place the ${subject} isolated on a pure solid white background (#FFFFFF).`,
    "The background must be plain white everywhere: no coloured background, no gradient, no texture, no pattern, no scenery, no floor, and no cast shadow on the background.",
    `No coloured rim light, no glow, and no coloured outline around the ${subject} caused by the background.`,
    `Keep a clean separation between the ${subject} and the white background.`,
  ].join(" ");
}

/**
 * Colour words that must never appear in a foreground prompt.
 *
 * Asserted by tests against every generated prompt: the policy is only real if
 * nothing can reintroduce a coloured matte by editing one template in isolation.
 */
export const FORBIDDEN_BACKDROP_TERMS = [
  "magenta background",
  "purple background",
  "green screen",
  "greenscreen",
  "blue screen",
  "bluescreen",
  "chroma key",
  "chroma-key",
  "chromakey",
];

/** True when a prompt asks for a coloured matte. Used by tests and by the guard. */
export function requestsColouredMatte(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return FORBIDDEN_BACKDROP_TERMS.some((term) => text.includes(term));
}
