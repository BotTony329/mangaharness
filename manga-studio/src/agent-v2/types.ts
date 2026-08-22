"use client";

import { type CompositionIssue } from "@/domain/compositionValidation";
import type { ID, InteractionType } from "@/domain/types";
import { type FallbackUse, type RunStatus, type StepFailure } from "@/agent/stepPolicy";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepProgress {
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ExecutionSummary {
  completed: number;
  failed: number;
  validationIssues: CompositionIssue[];
  /** True when nothing was committed and the document was restored. */
  rolledBack: boolean;
  /** Why the run was abandoned, when it was. */
  abortReason?: string;
  /**
   * The product truth of the run: COMPLETED / PARTIALLY_COMPLETED / FAILED.
   * "Done with a failed step" is not a status — see `stepPolicy.ts`.
   */
  status: RunStatus;
  /** Required steps rescued by an explicit fallback, named for the creator. */
  fallbacks: FallbackUse[];
  /** Noncritical steps that failed and were skipped. */
  skippedSteps: StepFailure[];
  /**
   * Names of library assets generated during a run whose page changes were
   * rolled back. The images cost real money and survive on purpose
   * (preserveRunArtifacts) — the run result must say so, never "nothing
   * changed" while the library quietly grew.
   */
  preservedAssets: string[];
}

/**
 * Runtime authorization for one agent run.
 *
 * This is the §19 generation boundary. It is deliberately *not* derived from
 * the plan or from anything the model said: it comes from the grounding phase,
 * which read the user's own prompt. A planner that decides to create a
 * character cannot widen its own permission.
 */
export interface RunGuards {
  creationAuthorized: boolean;
  /** Empty means "one unnamed new character"; otherwise creation is limited to these. */
  authorizedCreationNames: string[];
  selectedCharacterId?: ID;
  /** Characters the run is expected to touch, keyed by step index for post-conditions. */
  expectedCharacterIds?: ID[];
}

/** Default: no creation unless grounding authorized it. */
export const DENY_ALL_CREATION: RunGuards = { creationAuthorized: false, authorizedCreationNames: [] };

export type InteractionArgs = {
  panel: number;
  interaction: InteractionType;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  targetCharacterName: string;
  targetCharacterId?: ID;
};

/**
 * Fallback Composition — an explicit product behaviour, not a hidden rescue.
 *
 * A joint render that failed leaves two characters who still have perfectly
 * good reusable assets. The fallback places each of them from EXISTING ready
 * assets only (generateIfMissing is false: a fallback must never spend a
 * second generation trying to fix the first). The run then reports
 * PARTIALLY COMPLETED and names what is missing — the true joint render.
 */

/** Per-run context threaded through every process — replaces module globals. */
export interface RunContext {
  guards: RunGuards;
  createdCharacterIds: ID[];
  lastLanguageAction: string | undefined;
  currentDoc(): import("@/domain/types").ProjectDocument;
  dispatch(command: import("@/domain/commands").DomainCommand): import("@/domain/commands").CommandResult;
  panelIdByNumber(panel: number): ID;
  stageOnWorkspace(assetId: ID): void;
  requireCharacterOrNull(
    doc: import("@/domain/types").ProjectDocument,
    args: { characterId?: string; characterName?: string },
  ): import("@/domain/types").Character | null;
  findTargetInstance(
    doc: import("@/domain/types").ProjectDocument,
    args: { panel?: number; characterName?: string; characterId?: ID },
    scope?: import("@/agent/scope").AgentRunScope,
  ): import("@/domain/types").AssetInstance;
}
