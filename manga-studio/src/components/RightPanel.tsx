"use client";

/** Right dock: context-sensitive inspector + the Manga Agent. */

import { useState } from "react";
import { AgentPanel } from "./agent/AgentPanel";
import { InspectorPanel } from "./inspector/InspectorPanel";

export function RightPanel() {
  const [tab, setTab] = useState<"inspector" | "agent">("inspector");

  return (
    <aside className="flex w-[320px] shrink-0 flex-col" style={{ background: "var(--bg-panel)" }}>
      <nav className="flex border-b text-xs" style={{ borderColor: "var(--border-subtle)" }}>
        {(
          [
            { id: "inspector", label: "Inspector" },
            { id: "agent", label: "Manga Agent" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-2 py-2 ${
              tab === t.id ? "border-b-2 border-[var(--accent)] text-[var(--text-primary)]" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">{tab === "inspector" ? <InspectorPanel /> : <AgentPanel />}</div>
    </aside>
  );
}
