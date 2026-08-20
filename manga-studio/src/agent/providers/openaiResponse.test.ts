import { describe, expect, it } from "vitest";
import { readOpenAiCompletion } from "./openaiResponse";

describe("OpenAI-compatible planning response normalization", () => {
  it("accepts structured JSON in message content", async () => {
    const response = jsonResponse({ choices: [{ message: { content: '{"summary":"ok","steps":[]}' }, finish_reason: "stop" }] });
    await expect(readOpenAiCompletion(response)).resolves.toMatchObject({
      text: '{"summary":"ok","steps":[]}',
      finishReason: "stop",
      responseMode: "buffered",
    });
  });

  it("normalizes a null-content tool_calls-only response into canonical steps", async () => {
    const response = jsonResponse({
      choices: [{
        message: {
          content: null,
          reasoning_content: "private thought trace is ignored",
          tool_calls: [{ function: { name: "add_effect", arguments: '{"panel":2,"effectKind":"focus-lines"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const completion = await readOpenAiCompletion(response);
    expect(JSON.parse(completion.text).steps).toEqual([
      { tool: "add_effect", args: { panel: 2, effectKind: "focus-lines" } },
    ]);
    expect(completion.finishReason).toBe("tool_calls");
  });

  it("assembles a slow streamed tool call and records first-byte/completion events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"compose_character","arguments":"{\\"panel\\":2,"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"characterName\\":\\"Mio\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const events: string[] = [];
    const completion = await readOpenAiCompletion(new Response(stream, { headers: { "content-type": "text/event-stream" } }), {
      onEvent: (event) => events.push(event.stage),
    });
    expect(JSON.parse(completion.text).steps[0]).toEqual({ tool: "compose_character", args: { panel: 2, characterName: "Mio" } });
    expect(events).toEqual(["first_response_byte", "tool_calls_discovered", "provider_response_complete"]);
  });

  it("rejects malformed and empty provider envelopes with a parsing-stage error", async () => {
    await expect(readOpenAiCompletion(jsonResponse({ nope: true }))).rejects.toMatchObject({ stage: "parsing" });
    await expect(readOpenAiCompletion(jsonResponse({ choices: [{ message: { content: null }, finish_reason: "stop" }] }))).rejects.toMatchObject({
      safeMessage: "Agent provider responded, but no valid tool plan was found.",
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
