/**
 * Assembling a local edit request.
 *
 * The creator types only what should change — "hold a phone". Everything that
 * keeps the result recognisably theirs (identity, style, state, transparency
 * policy) is the harness's job to supply. Asking someone to re-describe their
 * own character is how identity drifts between edits.
 *
 * Pure and separate from the editor component so the wording can be asserted:
 * a foreground edit must never reintroduce a coloured matte, and that is a
 * regression a UI-only implementation would hide.
 */

import type { AssetCategory, CharacterState } from "@/domain/types";

export interface EditInstructionInput {
  /** What the creator asked for, verbatim. */
  prompt: string;
  category: AssetCategory;
  characterName?: string;
  state?: Pick<CharacterState, "pose" | "expression" | "outfit" | "view"> | null;
  styleName?: string;
}

/**
 * Build the provider instruction.
 *
 * Note what this does NOT do: it does not promise the model will obey. The
 * locality guarantee comes from `compositeLocalEdit`, which discards anything
 * the provider changed outside the mask. This wording only improves the odds
 * that the pixels inside the mask are useful.
 */
export function buildEditInstruction(input: EditInstructionInput): string {
  const isScene = input.category === "background";
  return [
    input.prompt.trim(),
    "Change ONLY the region indicated by the supplied selection; leave everything else exactly as it is.",
    input.characterName
      ? `This is ${input.characterName}. Preserve their face, hairstyle, proportions and outfit exactly.`
      : "",
    input.state
      ? `Keep the pose (${input.state.pose}), expression (${input.state.expression}), outfit (${input.state.outfit}) and view (${input.state.view}) unchanged outside the edited region.`
      : "",
    input.styleName ? `Keep the art style consistent: ${input.styleName}.` : "",
    isScene
      ? "Keep the complete rectangular image; do not isolate a subject and do not add a border."
      : /**
         * A cut-out asset is edited in place. Asking for any backdrop at all —
         * white included — invites the model to paint one into the transparent
         * surround, which the alpha restore would then have to undo.
         */
        "Keep the area around the subject empty and transparent. Do not add any background, backdrop, colour field or screen behind it.",
  ]
    .filter(Boolean)
    .join(" ");
}
