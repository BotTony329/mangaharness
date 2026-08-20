import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelProvider } from "./providers/types";
import { planAgentRun, type AgentRequestInput } from "./planner";

const input: AgentRequestInput = {
  prompt: "Add a smile to Panel 2",
  context: "Panel 2: selected",
  scope: {
    kind: "selected-panel",
    pageId: "page-1",
    pageName: "Page 1",
    panelCount: 4,
    panelId: "panel-2",
    panelNumber: 2,
    label: "Selected Panel · Panel 2",
  },
};

afterEach(() => vi.useRealTimers());

describe("planner response failures", () => {
  it("returns a controlled timeout before the serverless deadline", async () => {
    vi.useFakeTimers();
    const slow: AgentModelProvider = {
      ...provider(""),
      completeJson: async (_system, _user, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    };
    const pending = planAgentRun(slow, input);
    const assertion = expect(pending).rejects.toMatchObject({
      safeMessage: "Agent model timed out while planning.",
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it("normalizes invalid JSON as a parsing failure", async () => {
    await expect(planAgentRun(provider("not json"), input)).rejects.toMatchObject({
      safeMessage: "Agent provider responded, but the planning response could not be parsed.",
      stage: "parsing",
    });
  });

  it("normalizes a JSON object with missing steps/actions as validation failure", async () => {
    await expect(planAgentRun(provider('{"summary":"missing actions"}'), input)).rejects.toMatchObject({
      safeMessage: "Agent provider responded, but no valid tool plan was found.",
      stage: "validation",
    });
  });

  it("keeps cross-panel calls rejected under selected Panel 2 scope", async () => {
    const result = await planAgentRun(provider(JSON.stringify({
      summary: "try two panels",
      steps: [
        { tool: "add_effect", args: { panel: 1, effectKind: "focus-lines" } },
        { tool: "add_effect", args: { panel: 2, effectKind: "focus-lines" } },
      ],
    })), input);
    expect(result.plan.steps.map((step) => step.args.panel)).toEqual([2]);
    expect(result.rejected[0]?.error).toContain("allows only panel 2");
  });
});

function provider(text: string): AgentModelProvider {
  return {
    label: "Test Qwen",
    model: "qwen-plus",
    testConnection: async () => ({ ok: true }),
    completeJson: async () => ({ text, responseMode: "buffered" }),
  };
}
