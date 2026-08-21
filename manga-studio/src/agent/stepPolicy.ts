/**
 * Step criticality and fallback policy — the product semantics of a failed step.
 *
 * ## Why this exists
 *
 * The run used to end with "Done with 1 failed step" — a sentence that tells
 * the creator nothing about whether their page is intact. A step failure is
 * not one kind of event; it is one of three:
 *
 *   REQUIRED + no fallback     → the run FAILED, the page rolls back
 *   REQUIRED + fallback ran    → PARTIALLY COMPLETED, and the fallback is named
 *   NONCRITICAL                → skipped, the run is PARTIALLY COMPLETED
 *
 * The classification lives HERE, keyed by tool, so no UI string matching and
 * no per-call-site judgement can reintroduce "done but broken".
 */

import type { ToolName } from "./tools/schemas";

export type FallbackPolicy =
  /** No substitute exists. Failure aborts the run and rolls the page back. */
  | "NONE"
  /** A joint render may be approximated by composing existing reusable assets. */
  | "APPROXIMATE_COMPOSITION"
  /** Decoration the scene does not depend on. Failure skips the step. */
  | "SKIP_NONCRITICAL";

export interface StepPolicy {
  required: boolean;
  fallback: FallbackPolicy;
}

const REQUIRED: StepPolicy = { required: true, fallback: "NONE" };
const NONCRITICAL: StepPolicy = { required: false, fallback: "SKIP_NONCRITICAL" };

/**
 * Overrides only — every tool not listed is REQUIRED with no fallback, because
 * a step the plan bothered to include is load-bearing unless stated otherwise.
 */
const OVERRIDES: Partial<Record<ToolName, StepPolicy>> = {
  // A failed joint render can still become a scene: both participants placed
  // from their existing reusable assets. It must be LABELLED as approximate —
  // it is not the joint render the creator asked for.
  create_interaction: { required: true, fallback: "APPROXIMATE_COMPOSITION" },
  // Pure decoration. A speed line that fails to place must not roll back the
  // fight scene underneath it.
  add_effect: NONCRITICAL,
  apply_tone: NONCRITICAL,
  place_manga_effect: NONCRITICAL,
  generate_manga_effect: NONCRITICAL,
};

export function stepPolicyFor(tool: ToolName): StepPolicy {
  return OVERRIDES[tool] ?? REQUIRED;
}

export type RunStatus = "completed" | "partially_completed" | "failed";

export interface StepFailure {
  index: number;
  tool: ToolName;
  message: string;
}

export interface FallbackUse {
  index: number;
  tool: ToolName;
  /** What the fallback did, in the creator's terms. */
  detail: string;
}

/**
 * The one place a run's final status is decided.
 *
 * COMPLETED requires every required step AND clean-enough validation: a fatal
 * issue already rolled the run back upstream, so reaching here means warnings
 * at most. Any fallback or skipped noncritical step makes the run partial —
 * never "done".
 */
export function runStatusOf(input: {
  rolledBack: boolean;
  fallbacks: FallbackUse[];
  skippedSteps: StepFailure[];
  unresolvedWarnings: number;
}): RunStatus {
  if (input.rolledBack) return "failed";
  if (input.fallbacks.length > 0 || input.skippedSteps.length > 0 || input.unresolvedWarnings > 0) {
    return "partially_completed";
  }
  return "completed";
}
