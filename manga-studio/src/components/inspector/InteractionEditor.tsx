"use client";

/**
 * Existing interactions, editable.
 *
 * Creating an interaction was never the hard part — CHANGING one was. A hug
 * from behind is a different picture from a hug from the front, and until now
 * the only way to get there was delete-and-recreate. This surface edits the
 * interaction's semantics in place (type, direction, and in Advanced mode the
 * full parameter set), then re-draws through the same service the Agent uses.
 *
 * Simple mode stays two questions: WHAT are they doing, and FROM WHERE.
 * Everything else (facing, hand, intensity, sockets, zones, free instructions)
 * lives behind Advanced mode, matching the rest of the Inspector.
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
import { useUiStore } from "@/editor/uiStore";
import { characterIdOfInstance } from "@/characters/identity";

const DIRECTIONS = ["from the front", "from behind", "from the side", "from the left", "from the right"];
const FACINGS = ["each other", "away from each other", "the same direction", "the viewer"];
const HANDS: NonNullable<InteractionParameters["hand"]>[] = ["auto", "left", "right", "both"];

function participantName(doc: ProjectDocument, kind: string, id: ID): string {
  return kind === "character"
    ? (doc.characters[id]?.name ?? "Someone")
    : (doc.assets[id]?.name ?? "Something");
}

export function InteractionEditor({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((s) => s.doc)!;
  const advanced = useUiStore((s) => s.advancedMode);
  const [busyId, setBusyId] = useState<ID | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subject = characterIdOfInstance(doc, item);
  if (!subject) return null;

  const interactions = interactionsInPanel(doc, item.panelId, subject);
  if (interactions.length === 0) return null;

  const patch = (interactionId: ID, parameters: InteractionParameters) =>
    useEditorStore.getState().dispatch({ type: "update-interaction", interactionId, patch: { parameters } });

  const redraw = async (interactionId: ID) => {
    setBusyId(interactionId);
    setError(null);
    try {
      await rerenderInteraction(interactionId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The interaction could not be redrawn");
    } finally {
      setBusyId(null);
    }
  };

  const remove = (interaction: CharacterInteraction) => {
    /**
     * Deleting the interaction returns the panel to how it looked before:
     * the composite hides, the participant sprites come back. Everything is a
     * dispatch, so a single undo restores the interaction AND its placement.
     */
    const store = useEditorStore.getState();
    const renderAssetIds = new Set(
      Object.values(doc.interactionRenders)
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

  return (
    <div className="space-y-1.5">
      {interactions.map((interaction) => (
        <InteractionRow
          key={interaction.id}
          interaction={interaction}
          busy={busyId === interaction.id}
          anyBusy={busyId !== null}
          advanced={advanced}
          onPatch={patch}
          onRedraw={redraw}
          onRemove={remove}
        />
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
  busy,
  anyBusy,
  advanced,
  onPatch,
  onRedraw,
  onRemove,
}: {
  interaction: CharacterInteraction;
  busy: boolean;
  anyBusy: boolean;
  advanced: boolean;
  onPatch: (interactionId: ID, parameters: InteractionParameters) => void;
  onRedraw: (interactionId: ID) => Promise<void>;
  onRemove: (interaction: CharacterInteraction) => void;
}) {
  const doc = useEditorStore((s) => s.doc)!;
  const [open, setOpen] = useState(false);

  const participants = interactionParticipants(interaction);
  const names = participants.map((participant) => participantName(doc, participant.kind, participant.id)).join(" + ");
  const parameters = interaction.parameters ?? {};
  const isKnownType = (INTERACTION_TYPES as string[]).includes(interaction.type);

  /** The same verdict the create path uses, so the cost label never lies. */
  const strategy = planInteractionStrategy(doc, {
    panelId: interaction.panelId,
    participantIds: interaction.participantIds,
    participants,
    type: interaction.type,
    parameters: interaction.parameters,
  }).strategy;

  const setParameter = (key: keyof InteractionParameters, value: unknown) => {
    const next = { ...parameters, [key]: value === "" || value === undefined ? undefined : value };
    onPatch(interaction.id, next);
  };

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
      <div className="flex items-center gap-1.5">
        <button
          className="flex flex-1 items-baseline gap-1.5 text-left"
          onClick={() => setOpen((value) => !value)}
          title={open ? "Collapse" : "Edit this interaction"}
        >
          <span className="text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
            {interactionLabel(interaction.type)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[9px]" style={{ color: "var(--text-muted)" }}>
            {names}
            {parameters.direction ? ` · ${parameters.direction}` : ""}
          </span>
        </button>
        {strategy === "GENERATE" ? (
          <button
            disabled={anyBusy}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] disabled:opacity-40"
            style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
            onClick={() => void onRedraw(interaction.id)}
            title="Draw this interaction with its current settings"
          >
            {busy ? (
              <SpinnerIcon size={9} strokeWidth={2} className="animate-spin" />
            ) : (
              <GenerateIcon size={9} strokeWidth={2.5} />
            )}
            Redraw
          </button>
        ) : (
          <span className="text-[8px]" style={{ color: "var(--success)" }}>
            Instant
          </span>
        )}
        <button
          className="px-1 text-[10px] text-zinc-500 hover:text-[var(--danger)]"
          title="Remove this interaction"
          onClick={() => onRemove(interaction)}
        >
          ×
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
          <label className="block">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Action
            </span>
            <select
              className="mt-0.5 w-full rounded-md px-1.5 py-1 text-[10px]"
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
            </select>
          </label>

          <label className="block">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Direction
            </span>
            <div className="mt-0.5">
              {select(parameters.direction, DIRECTIONS, (value) => setParameter("direction", value))}
            </div>
          </label>

          {advanced && (
            <>
              <label className="block">
                <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  Facing
                </span>
                <div className="mt-0.5">
                  {select(parameters.facing, FACINGS, (value) => setParameter("facing", value))}
                </div>
              </label>

              <label className="block">
                <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  Hand
                </span>
                <div className="mt-0.5">{select(parameters.hand, HANDS, (value) => setParameter("hand", value))}</div>
              </label>

              {(["intensity", "distance"] as const).map((key) => (
                <label className="block" key={key}>
                  <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    {key} {parameters[key] !== undefined ? `${Math.round((parameters[key] ?? 0) * 100)}%` : ""}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    className="mt-0.5 w-full"
                    value={Math.round((parameters[key] ?? 0.5) * 100)}
                    onChange={(event) => setParameter(key, Number(event.target.value) / 100)}
                  />
                </label>
              ))}

              {participants.map((participant, index) => {
                if (participant.kind === "character") return null;
                const asset = doc.assets[participant.id];
                const key = participant.kind === "object" ? "socket" : "zone";
                const declared = asset?.metadata?.[participant.kind === "object" ? "affordances" : "zones"] ?? [];
                const options = [...new Set([...(participant.kind === "object" ? OBJECT_SOCKETS : SCENE_ZONES), ...declared])];
                return (
                  <label className="block" key={`${participant.id}-${index}`}>
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                      {participantName(doc, participant.kind, participant.id)} {key}
                    </span>
                    <div className="mt-0.5">
                      {select(participant[key], options, (value) => {
                        const nextParticipants = participants.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, [key]: value } : entry,
                        );
                        useEditorStore.getState().dispatch({
                          type: "update-interaction",
                          interactionId: interaction.id,
                          patch: { participants: nextParticipants },
                        });
                      })}
                    </div>
                  </label>
                );
              })}

              <label className="block">
                <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  Extra instruction
                </span>
                <input
                  className="mt-0.5 w-full rounded-md px-1.5 py-1 text-[10px]"
                  style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
                  placeholder="e.g. she is laughing while being lifted"
                  defaultValue={parameters.customInstruction ?? ""}
                  onBlur={(event) => setParameter("customInstruction", event.target.value.trim() || undefined)}
                />
              </label>
            </>
          )}

          {strategy === "GENERATE" && (
            <p className="text-[9px] leading-4" style={{ color: "var(--text-muted)" }}>
              Changes apply to the next Redraw.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
