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
  completeJson(systemPrompt: string, userPrompt: string, options?: AgentCompletionOptions): Promise<AgentCompletion>;
}

export type AgentProviderStage =
  | "outbound_request_start"
  | "first_response_byte"
  | "tool_calls_discovered"
  | "provider_response_complete";

export interface AgentProviderEvent {
  stage: AgentProviderStage;
  responseMode?: "stream" | "buffered";
  providerStatus?: number;
  finishReason?: string;
}

export interface AgentCompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgentProviderEvent) => void;
}

export interface AgentCompletion {
  text: string;
  finishReason?: string;
  responseMode: "stream" | "buffered";
}

export class AgentModelError extends Error {
  readonly safeMessage: string;
  readonly status: number;

  readonly stage: "planning" | "parsing" | "validation";
  readonly providerStatus?: number;
  readonly finishReason?: string;

  constructor(
    safeMessage: string,
    status = 502,
    details: { stage?: "planning" | "parsing" | "validation"; providerStatus?: number; finishReason?: string } = {},
  ) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
    this.stage = details.stage ?? "planning";
    this.providerStatus = details.providerStatus;
    this.finishReason = details.finishReason;
  }
}

/** Planner calls must return before the platform timeout and before the UI feels frozen. */
export const AGENT_REQUEST_TIMEOUT_MS = 25_000;
