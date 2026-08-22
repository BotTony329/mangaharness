"use client";

/**
 * Manga Agent V2 — public entry.
 *
 * The execution engine is split by domain process (character / scene / panel /
 * dialogue / tone / camera / interaction / local edit); `orchestrator` owns
 * the run lifecycle (transaction, policy, validation, summary) and `pipeline`
 * owns the UNDERSTAND → PLAN → RESOLVE → CALL → VALIDATE chain. UI code
 * imports from here, never from process internals.
 */

export { executePlan, executeStep, describeStep, countGenerations, runningDetail, completedDetail } from "./orchestrator";
export {
  DENY_ALL_CREATION,
  type ExecutionSummary,
  type InteractionArgs,
  type RunContext,
  type RunGuards,
  type StepProgress,
  type StepStatus,
} from "./types";
