/**
 * Architecture boundary tests — static import-graph assertions.
 *
 * These guard the decoupling phase: the Agent and feature modules must depend
 * on Application Services, never on provider adapters, the generation HTTP
 * client, or persistence internals. A violation fails the suite, so a future
 * shortcut cannot silently re-couple the layers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

function violations(dir: string, pattern: RegExp): string[] {
  return sourceFiles(dir)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
}

describe("architecture boundaries", () => {
  it("agent never imports provider adapters, the generation HTTP client, or persistence", () => {
    for (const dir of ["agent", "agent-v2"]) {
      const bad = violations(
        join(SRC, dir),
        /@\/ai\/(clientGeneration|providers)|@\/storage\/|from ["']\.\.\/\.\.\/storage/,
      );
      expect(bad, `${dir} boundary`).toEqual([]);
    }
  });

  it("characters never calls the generation HTTP client or provider endpoints directly", () => {
    const bad = violations(
      join(SRC, "characters"),
      /@\/ai\/(clientGeneration|providers)|fetch\(["']\/api\/(generate|provider)/,
    );
    expect(bad).toEqual([]);
  });

  it("InteractionService lives in the service layer and routes generation through GenerationService", () => {
    const file = readFileSync(join(SRC, "services/interaction.ts"), "utf8");
    expect(file).not.toMatch(/@\/ai\/clientGeneration/);
    expect(file).toMatch(/@\/services\/generation/);
  });

  it("provider status endpoint is only fetched through GenerationService", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes("app/api") && !file.includes("services/generation"))
      .filter((file) => readFileSync(file, "utf8").includes('fetch("/api/provider/status")'))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("manual and agent character creation both go through CharacterService", () => {
    const manual = readFileSync(join(SRC, "components/library/CharactersTab.tsx"), "utf8");
    const agentExec = readFileSync(join(SRC, "agent-v2/process/characterProcess.ts"), "utf8");
    const agentFulfil = readFileSync(join(SRC, "agent/fulfilRequirements.ts"), "utf8");
    for (const [name, file] of [["CharactersTab", manual], ["characterProcess", agentExec], ["fulfilRequirements", agentFulfil]] as const) {
      expect(file, `${name} must call @/services/characters`).toMatch(/@\/services\/characters/);
      expect(file, `${name} must not dispatch create-character directly`).not.toMatch(/type: "create-character"/);
    }
  });
});

describe("agent V3 boundaries", () => {
  it("agent-v3 obeys the same provider/persistence boundary as agent and agent-v2", () => {
    const bad = violations(
      join(SRC, "agent-v3"),
      /@\/ai\/(clientGeneration|providers)|@\/storage\/|from ["']\.\.\/\.\.\/storage/,
    );
    expect(bad, "agent-v3 boundary").toEqual([]);
  });

  it("the editor, domain and services never import any agent engine", () => {
    for (const dir of ["editor", "domain", "services"]) {
      const bad = violations(join(SRC, dir), /@\/agent(-v2|-v3)?[/"']/);
      expect(bad, `${dir} must not import the agent`).toEqual([]);
    }
  });

  it("the production UI uses the V3 engine, never the V2 pipeline", () => {
    const panel = readFileSync(join(SRC, "components/agent/AgentPanel.tsx"), "utf8");
    expect(panel).not.toMatch(/agent-v2\/pipeline|runPipeline/);
    expect(panel).toMatch(/@\/agent-v3\/run/);
  });

  it("there is exactly one canonical Creative Director system prompt", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("CREATIVE_DIRECTOR_SYSTEM_PROMPT"),
    );
    expect(offenders.map((file) => relative(SRC, file)).sort()).toEqual([
      "agent-v3/director/creativeDirector.ts",
      "agent-v3/director/systemPrompt.ts",
    ]);
  });
});
