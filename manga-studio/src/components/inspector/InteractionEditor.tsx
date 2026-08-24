"use client";

/**
 * Existing interactions — browsable and editable from the Interactions tab.
 *
 * The tab leads with what EXISTS ("Hug — Yuri", "Drive — Car Interior"), not
 * with creation buttons. Clicking a row opens its editor in place: action,
 * direction, and an Advanced disclosure for the full semantics. Object and
 * scene interactions surface their defining field in the simple view (Hand for
 * an object, Zone for a scene), because that is the knob a creator reaches for.
 *
 * The list answers for BOTH ways an interaction can be selected:
 *   - a character instance is selected → their interactions;
 *   - a composite render is selected (which is exactly what happens right
 *     after a hug is drawn) → the interaction that produced it.
 * Without the second path, creating an interaction left the creator staring at
 * an image with no way to edit what it meant.
 */

import { useState } from "react";
import {
  INTERACTION_LABELS,
  INTERACTION_TYPES,
  OBJECT_SOCKETS,
  SCENE_ZONES,
  interactionLabel,
  interactionParticipants,
  interactionsInPanel,
} from "@/domain/interactions";
import { planInteractionStrategy, rerenderInteraction } from "@/services/interaction";
import { GenerateIcon, SpinnerIcon } from "../ui/icons";
import type { AssetInstance, CharacterInteraction, ID, InteractionParameters, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfInstance } from "@/characters/identity";

const DIRECTIONS = ["from the front", "from behind", "from the side", "from the left", "from the right"];
const FACINGS = ["each other", "away from each other", "the same direction", "the viewer"];
const HANDS: NonNullable<InteractionParameters["hand"]>[] = ["auto", "left", "right", "both"];

function participantName(doc: ProjectDocument, kind: string, id: ID): string {
  return kind === "character"
    ? (doc.characters[id]?.name ?? "Someone")
    : (doc.assets[id]?.name ?? "Something");
}

/** Every interaction this selection should surface, deduplicated. */
export function interactionsForItem(doc: ProjectDocument, item: AssetInstance): CharacterInteraction[] {
  const found = new Map<ID, CharacterInteraction>();
  const subject = item.kind === "asset" ? characterIdOfInstance(doc, item) : undefined;
  if (subject) {
    for (const interaction of interactionsInPanel(doc, item.panelId, subject)) found.set(interaction.id, interaction);
  }
  // A selected composite render stands for the interaction that produced it.
  if (item.kind === "asset") {
    const viaRender = Object.values(doc.interactionRenders ?? {})
      .filter((render) => render.generatedAssetId === item.sourceAssetId)
      .map((render) => doc.interactions[render.interactionId])
      .filter((interaction): interaction is CharacterInteraction => Boolean(interaction));
    for (const interaction of viaRender) found.set(interaction.id, interaction);
  }
  return [...found.values()];
}

export function InteractionEditor({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((s) => s.doc)!;
  const [error, setError] = useState<string | null>(null);

  const interactions = interactionsForItem(doc, item);
  if (interactions.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--accent-text)" }}>
        Interactions
      </p>
      {interactions.map((interaction) => (
        <InteractionRow key={interaction.id} interaction={interaction} onError={setError} />
      ))}
      {error && (
        <p className="rounded-md p-1.5 text-[10px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function InteractionRow({
  interaction,
  onError,
}: {
  interaction: CharacterInteraction;
  onError: (message: string | null) => void;
}) {
  const doc = useEditorStore((s) => s.doc)!;
  const [open, setOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const participants = interactionParticipants(interaction);
  const others = participants.filter((_, index) => index > 0);
  const names = others.map((participant) => participantName(doc, participant.kind, participant.id)).join(" + ");
  const parameters = interaction.parameters ?? {};
  const isKnownType = (INTERACTION_TYPES as string[]).includes(interaction.type);
  const objectParticipants = participants.filter((p) => p.kind === "object");
  const sceneParticipants = participants.filter((p) => p.kind === "scene");

  /** The same verdict the create path uses, so the cost label never lies. */
  const strategy = planInteractionStrategy(doc, {
    panelId: interaction.panelId,
    participantIds: interaction.participantIds,
    participants,
    type: interaction.type,
    parameters: interaction.parameters,
  }).strategy;

  const patchParameters = (key: keyof InteractionParameters, value: unknown) => {
    const next = { ...parameters, [key]: value === "" || value === undefined ? undefined : value };
    useEditorStore.getState().dispatch({
      type: "update-interaction",
      interactionId: interaction.id,
      patch: { parameters: next },
    });
  };

  const patchParticipant = (index: number, key: "socket" | "zone", value: string | undefined) => {
    const nextParticipants = participants.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, [key]: value } : entry,
    );
    useEditorStore.getState().dispatch({
      type: "update-interaction",
      interactionId: interaction.id,
      patch: { participants: nextParticipants },
    });
  };

  const regenerate = async () => {
    setBusy(true);
    onError(null);
    try {
      await rerenderInteraction(interaction.id);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "The interaction could not be redrawn");
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    /**
     * Deleting the interaction returns the panel to how it looked before:
     * the composite hides, the participant sprites come back. Everything is a
     * dispatch, so a single undo restores the interaction AND its placement.
     */
    const store = useEditorStore.getState();
    const renderAssetIds = new Set(
      Object.values(doc.interactionRenders ?? {})
        .filter((render) => render.interactionId === interaction.id)
        .map((render) => render.generatedAssetId),
    );
    for (const itemId of doc.panels[interaction.panelId]?.itemIds ?? []) {
      const candidate = store.doc?.items[itemId];
      if (candidate?.kind !== "asset") continue;
      if (renderAssetIds.has(candidate.sourceAssetId)) {
        store.dispatch({ type: "set-instance-props", instanceId: candidate.id, patch: { visible: false } });
      } else if (
        interaction.participantIds.includes(characterIdOfInstance(doc, candidate) ?? "") &&
        candidate.visible === false
      ) {
        store.dispatch({ type: "set-instance-props", instanceId: candidate.id, patch: { visible: true } });
      }
    }
    store.dispatch({ type: "remove-interaction", interactionId: interaction.id });
  };

  const field = (label: string, control: React.ReactNode) => (
    <label className="block">
      <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <div className="mt-0.5">{control}</div>
    </label>
  );

  const select = (
    value: string | undefined,
    options: readonly string[],
    onChange: (value: string | undefined) => void,
    placeholder = "—",
  ) => (
    <select
      className="w-full rounded-md px-1.5 py-1 text-[10px]"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );

  return (
    <div className="rounded-lg p-2" style={{ background: "var(--bg-elevated)" }}>
      {/* List row: the interaction in one glance, click to edit. */}
      <button className="flex w-full items-baseline gap-1.5 text-left" onClick={() => setOpen((value) => !value)}>
        <span className="text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
          {interactionLabel(interaction.type)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[9px]" style={{ color: "var(--text-muted)" }}>
          — {names}
          {parameters.direction ? ` · ${parameters.direction}` : ""}
          {sceneParticipants[0]?.zone ? ` · ${sceneParticipants[0].zone}` : ""}
        </span>
        <span className="text-[9px] text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
          {field(
            "Interaction",
            <select
              className="w-full rounded-md px-1.5 py-1 text-[10px]"
              style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
              value={interaction.type}
              onChange={(event) =>
                useEditorStore.getState().dispatch({
                  type: "update-interaction",
                  interactionId: interaction.id,
                  patch: { type: event.target.value },
                })
              }
            >
              {INTERACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INTERACTION_LABELS[type]}
                </option>
              ))}
              {!isKnownType && <option value={interaction.type}>{interactionLabel(interaction.type)}</option>}
            </select>,
          )}

          {field(
            participants.some((p) => p.kind !== "character") ? "Target" : "With",
            <p className="px-1.5 py-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
              {names}
            </p>,
          )}

          {field("Direction", select(parameters.direction, DIRECTIONS, (value) => patchParameters("direction", value)))}

          {/* The defining knob of an object/scene interaction stays in the simple view. */}
          {objectParticipants.map((participant) => {
            const index = participants.indexOf(participant);
            return (
              <div key={`socket-${participant.id}`}>
                {field(
                  `${participantName(doc, "object", participant.id)} · Socket`,
                  select(
                    participant.socket,
                    [...new Set([...OBJECT_SOCKETS, ...(doc.assets[participant.id]?.metadata?.affordances ?? [])])],
                    (value) => patchParticipant(index, "socket", value),
                  ),
                )}
              </div>
            );
          })}
          {sceneParticipants.map((participant) => {
            const index = participants.indexOf(participant);
            return (
              <div key={`zone-${participant.id}`}>
                {field(
                  "Zone",
                  select(
                    participant.zone,
                    [...new Set([...SCENE_ZONES, ...(doc.assets[participant.id]?.metadata?.zones ?? [])])],
                    (value) => patchParticipant(index, "zone", value),
                  ),
                )}
              </div>
            );
          })}
          {objectParticipants.length > 0 &&
            field("Hand", select(parameters.hand, HANDS, (value) => patchParameters("hand", value)))}

          <button
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowAdvanced((value) => !value)}
          >
            {showAdvanced ? "Advanced ▾" : "Advanced ▸"}
          </button>

          {showAdvanced && (
            <div className="space-y-1.5">
              {field("Facing", select(parameters.facing, FACINGS, (value) => patchParameters("facing", value)))}
              {(["distance", "intensity"] as const).map((param) => (
                <div key={param}>
                  {field(
                    `${param} ${parameters[param] !== undefined ? `${Math.round((parameters[param] ?? 0) * 100)}%` : ""}`,
                    <input
                      type="range"
                      min={0}
                      max={100}
                      className="w-full"
                      value={Math.round((parameters[param] ?? 0.5) * 100)}
                      onChange={(event) => patchParameters(param, Number(event.target.value) / 100)}
                    />,
                  )}
                </div>
              ))}
              {objectParticipants.length === 0 &&
                field("Hand", select(parameters.hand, HANDS, (value) => patchParameters("hand", value)))}
              {field(
                "Contact",
                <input
                  className="w-full rounded-md px-1.5 py-1 text-[10px]"
                  style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
                  placeholder="e.g. shoulder, hand"
                  defaultValue={(parameters.contact ?? []).join(", ")}
                  onBlur={(event) => {
                    const parts = event.target.value.split(",").map((part) => part.trim()).filter(Boolean);
                    patchParameters("contact", parts.length > 0 ? parts : undefined);
                  }}
                />,
              )}
              {field(
                "Custom Instruction",
                <input
                  className="w-full rounded-md px-1.5 py-1 text-[10px]"
                  style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
                  placeholder="e.g. she is laughing while being lifted"
                  defaultValue={parameters.customInstruction ?? ""}
                  onBlur={(event) => patchParameters("customInstruction", event.target.value.trim() || undefined)}
                />,
              )}
            </div>
          )}

          <div className="flex gap-1.5 pt-1">
            {strategy === "GENERATE" ? (
              <button
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[10px] disabled:opacity-40"
                style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
                onClick={() => void regenerate()}
                title="Draw this interaction with its current settings"
              >
                {busy ? (
                  <SpinnerIcon size={10} strokeWidth={2} className="animate-spin" />
                ) : (
                  <GenerateIcon size={10} strokeWidth={2.5} />
                )}
                Regenerate Interaction
              </button>
            ) : (
              <p className="flex-1 py-1 text-center text-[9px]" style={{ color: "var(--success)" }}>
                Instant — arranged live, no image to regenerate
              </p>
            )}
            <button
              className="rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
              style={{ color: "var(--text-secondary)" }}
              onClick={remove}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
