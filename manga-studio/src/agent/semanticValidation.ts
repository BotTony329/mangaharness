/**
 * Semantic Validation — the deterministic layer that does NOT trust the LLM.
 *
 * The parser contract tells the model the rules; this module enforces them
 * against the literal evidence of the user's own prompt. A plan that creates
 * a character from an attribute word ("Japanese"), a location ("Kyoto"), or
 * thin air is stopped HERE, before AssetRequirements and the executor can
 * faithfully execute a wrong meaning.
 *
 * Every check is evidence-based, never case-based: no place names, no
 * nationalities, no test strings are hard-coded. The rules are structural —
 * "was this surface explicitly named? does it appear after a location
 * preposition?" — which is what makes them provider- and prompt-independent.
 */

import { attributeTokenSet, extractLiteralEvidence, normalizeEvidenceName } from "./literalEvidence";
import type { GroundingReport } from "./grounding";
import { normalizeReference } from "./grounding";
import type { AgentPlan } from "./tools/schemas";
import type { Character } from "@/domain/types";

export interface SemanticViolation {
  stepIndex: number;
  tool: string;
  rule:
    | "explicit-name-preservation"
    | "location-protection"
    | "attribute-protection"
    | "unevidenced-creation"
    | "duplicate-participant";
  message: string;
}

/** Step args that carry a character NAME string, per tool. */
const NAME_ARGS: Record<string, string[]> = {
  create_character: ["name"],
  generate_character_asset: ["characterName"],
  place_character: ["characterName"],
  compose_character: ["characterName"],
  set_character_slot: ["characterName"],
  set_character_depth: ["characterName"],
  set_focal_character: ["characterName"],
  set_puppet_expression: ["characterName"],
  set_puppet_joint: ["characterName"],
  set_character_pose_rig: ["characterName"],
  attach_bubble: ["characterName"],
  add_scene_relationship: ["subjectCharacterName"],
  create_interaction: ["subjectCharacterName", "targetCharacterName"],
};


export function validatePlanSemantics(input: {
  prompt: string;
  plan: AgentPlan;
  grounding: GroundingReport;
  authorizedNames: string[];
  projectCharacters: Character[];
}): SemanticViolation[] {
  const evidence = extractLiteralEvidence(input.prompt);
  const attributes = attributeTokenSet(evidence);
  const existing = new Set(
    input.projectCharacters.flatMap((character) => [character.name, ...(character.aliases ?? [])]).map(normalizeReference),
  );
  const authorized = new Set(input.authorizedNames.map(normalizeReference));
  const violations: SemanticViolation[] = [];

  const checkName = (stepIndex: number, tool: string, raw: unknown): void => {
    if (typeof raw !== "string" || raw.trim().length === 0) return;
    const normalized = normalizeReference(raw);
    const evidNormalized = normalizeEvidenceName(raw);
    // An explicitly written name is always a legitimate identity — even when
    // the same word names a place elsewhere ("a villain named Kyoto").
    if (evidence.explicitNameSet.has(evidNormalized)) return;
    if (existing.has(normalized) || authorized.has(normalized)) return;

    if (evidence.locationSet.has(evidNormalized)) {
      violations.push({
        stepIndex,
        tool,
        rule: "location-protection",
        message: `"${raw}" appears in the prompt as a place, not a person. Refusing to treat a location as a character.`,
      });
      return;
    }
    if (attributes.has(evidNormalized)) {
      violations.push({
        stepIndex,
        tool,
        rule: "attribute-protection",
        message: `"${raw}" is a description word bound to a named character in the prompt, not a character. Refusing to create identity from an attribute.`,
      });
      return;
    }
    if (tool === "create_character") {
      violations.push({
        stepIndex,
        tool,
        rule: "unevidenced-creation",
        message: `create_character("${raw}") has no evidence in the prompt — the name was never written by the creator. Refusing to invent a character.`,
      });
    }
  };

  input.plan.steps.forEach((step, index) => {
    for (const arg of NAME_ARGS[step.tool] ?? []) {
      checkName(index, step.tool, step.args[arg]);
    }
    if (step.tool === "create_interaction") {
      const subject = step.args.subjectCharacterName;
      const target = step.args.targetCharacterName;
      if (
        typeof subject === "string" &&
        typeof target === "string" &&
        normalizeReference(subject) === normalizeReference(target)
      ) {
        violations.push({
          stepIndex: index,
          tool: step.tool,
          rule: "duplicate-participant",
          message: `Interaction names "${subject}" as both participants — apposition must fold to one participant, not two.`,
        });
      }
    }
  });

  return violations;
}
