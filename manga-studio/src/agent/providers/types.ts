/**
 * Agent model abstraction: the LLM is a replaceable reasoning engine behind
 * this interface. The harness (context, skills, tools, execution, undo)
 * never depends on a specific vendor — provider quirks stay inside adapters.
 *
 * All adapters return one JSON document (the plan). This doubles as the
 * structured fallback for models without native tool calling: the internal
 * tool schema is Manga Studio's own, validated by validatePlan before
 * anything executes.
 */

export interface AgentModelProvider {
  /** e.g. "openai-compatible @ api.deepseek.com" — safe to show users. */
  label: string;
  model: string;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
  completeJson(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class AgentModelError extends Error {
  readonly safeMessage: string;
  readonly status: number;

  constructor(safeMessage: string, status = 502) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
  }
}

export const AGENT_REQUEST_TIMEOUT_MS = 120_000;
