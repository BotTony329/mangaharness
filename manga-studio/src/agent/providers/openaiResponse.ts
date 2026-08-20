import { AgentModelError, type AgentCompletion, type AgentCompletionOptions } from "./types";

interface ToolCallAccumulator {
  name: string;
  arguments: string;
}

interface OpenAiMessage {
  content?: string | null | { type?: string; text?: string }[];
  reasoning_content?: string | null;
  tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[];
}

interface OpenAiEnvelope {
  choices?: { message?: OpenAiMessage; delta?: OpenAiMessage; finish_reason?: string | null }[];
}

export async function readOpenAiCompletion(
  response: Response,
  options: AgentCompletionOptions = {},
): Promise<AgentCompletion> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream")
    ? readStream(response, options)
    : readBuffered(response, options);
}

async function readBuffered(response: Response, options: AgentCompletionOptions): Promise<AgentCompletion> {
  options.onEvent?.({ stage: "first_response_byte", responseMode: "buffered", providerStatus: response.status });
  const body = (await response.json().catch(() => null)) as OpenAiEnvelope | null;
  const choice = body?.choices?.[0];
  if (!choice?.message) throw parseError("Agent provider responded, but the planning response could not be parsed.", response.status);
  if (choice.message.tool_calls?.length) options.onEvent?.({ stage: "tool_calls_discovered", responseMode: "buffered", providerStatus: response.status });
  const text = normalizeMessage(choice.message);
  options.onEvent?.({
    stage: "provider_response_complete",
    responseMode: "buffered",
    providerStatus: response.status,
    finishReason: choice.finish_reason ?? undefined,
  });
  return { text, finishReason: choice.finish_reason ?? undefined, responseMode: "buffered" };
}

async function readStream(response: Response, options: AgentCompletionOptions): Promise<AgentCompletion> {
  if (!response.body) throw parseError("Agent provider returned an empty stream.", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  let sawFirstByte = false;
  let sawToolCalls = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!sawFirstByte) {
      sawFirstByte = true;
      options.onEvent?.({ stage: "first_response_byte", responseMode: "stream", providerStatus: response.status });
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, "");
      if (!data || data === "[DONE]") continue;
      const chunk = safeJson(data) as OpenAiEnvelope | null;
      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      content += contentText(choice.delta?.content);
      if (appendToolCalls(toolCalls, choice.delta?.tool_calls) && !sawToolCalls) {
        sawToolCalls = true;
        options.onEvent?.({ stage: "tool_calls_discovered", responseMode: "stream", providerStatus: response.status });
      }
      finishReason = choice.finish_reason ?? finishReason;
    }
  }
  if (buffer.trim()) {
    const data = buffer.trim().replace(/^data:\s*/, "");
    if (data !== "[DONE]") {
      const choice = (safeJson(data) as OpenAiEnvelope | null)?.choices?.[0];
      content += contentText(choice?.delta?.content);
      if (appendToolCalls(toolCalls, choice?.delta?.tool_calls) && !sawToolCalls) {
        sawToolCalls = true;
        options.onEvent?.({ stage: "tool_calls_discovered", responseMode: "stream", providerStatus: response.status });
      }
      finishReason = choice?.finish_reason ?? finishReason;
    }
  }
  const text = content.trim() || toolPlanJson([...toolCalls.values()]);
  if (!text) throw parseError("Agent provider responded, but no valid tool plan was found.", response.status, finishReason);
  options.onEvent?.({ stage: "provider_response_complete", responseMode: "stream", providerStatus: response.status, finishReason });
  return { text, finishReason, responseMode: "stream" };
}

export function normalizeMessage(message: OpenAiMessage): string {
  const content = contentText(message.content).trim();
  if (content) return content;
  const calls = (message.tool_calls ?? []).map((call) => ({
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}",
  }));
  const plan = toolPlanJson(calls);
  if (plan) return plan;
  throw parseError("Agent provider responded, but no valid tool plan was found.");
}

function contentText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function appendToolCalls(
  target: Map<number, ToolCallAccumulator>,
  deltas: OpenAiMessage["tool_calls"],
): boolean {
  let appended = false;
  for (const [fallbackIndex, call] of (deltas ?? []).entries()) {
    const index = call.index ?? fallbackIndex;
    const current = target.get(index) ?? { name: "", arguments: "" };
    current.name += call.function?.name ?? "";
    current.arguments += call.function?.arguments ?? "";
    target.set(index, current);
    appended = true;
  }
  return appended;
}

function toolPlanJson(calls: ToolCallAccumulator[]): string {
  if (calls.length === 0) return "";
  const steps = calls.map((call) => {
    if (!call.name) throw parseError("Agent provider returned a tool call without a name.");
    const args = safeJson(call.arguments || "{}");
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw parseError(`Agent provider returned invalid arguments for ${call.name}.`);
    }
    return { tool: call.name, args };
  });
  return JSON.stringify({ summary: "Execute the provider tool plan", steps });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseError(message: string, providerStatus?: number, finishReason?: string): AgentModelError {
  return new AgentModelError(message, 502, { stage: "parsing", providerStatus, finishReason });
}
