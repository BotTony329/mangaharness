import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@/server/providerSession";
import { createCustomAgentProvider } from "./customAgent";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("custom OpenAI-style agent adapter", () => {
  it("enables Qwen streaming/non-thinking planner mode and parses SSE", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"fast\\",\\"steps\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const result = await createCustomAgentProvider(config()).completeJson("Return JSON", "Plan this");
    expect(result.text).toBe('{"summary":"fast","steps":[]}');
    expect(result.responseMode).toBe("stream");
    expect(requestBody).toMatchObject({ stream: true, enable_thinking: false, max_tokens: 2048 });
  });

  it("normalizes its historical CustomApiError timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const pending = createCustomAgentProvider(config()).completeJson("Return JSON", "Plan this", { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toMatchObject({
      safeMessage: "Agent model timed out while planning.",
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});

function config(): ProviderConfig {
  return {
    kind: "agent",
    providerType: "custom",
    name: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    apiKey: "secret-test-key",
    model: "qwen-plus",
    custom: {
      method: "POST",
      auth: { mode: "bearer" },
      headers: [],
      requestTemplate: '{"model":"{{model}}","messages":"{{messages}}","temperature":"{{temperature}}","response_format":{"type":"json_object"}}',
      referenceMode: "none",
      execution: "sync",
      responseTextPath: "choices[0].message.content",
    },
  };
}
