"use client";

/**
 * Relationships — persistent project facts about who people are to each other.
 *
 * ## Not the same thing as an Interaction
 *
 *   RELATIONSHIP  Yuri ↔ Mori = Close Friend.  A standing fact about the
 *                 project. Generates nothing. Lives as long as the characters
 *                 do, across every page.
 *
 *   INTERACTION   Yuri hugs Mori in panel 3.   A scene action. May cost a
 *                 generation. Belongs to one panel.
 *
 * Conflating them is how "her close friend" becomes a guess. A relationship is
 * what lets the Agent resolve that phrase deterministically instead of picking
 * whichever character looks plausible — which is exactly the guessing the
 * grounding layer exists to refuse.
 *
 * Editing a type is a remove plus an add: the domain keeps one edge per pair
 * per type, so there is no separate update command to build and no second way
 * for the graph to be written.
 */

import { useState } from "react";
import { RELATIONSHIP_LABELS, relationshipsFor } from "@/domain/relationships";
import type { Character, ID, RelationshipType } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { CloseIcon, ICON_STROKE, PlusIcon, RenameIcon } from "../ui/icons";

const TYPES = Object.keys(RELATIONSHIP_LABELS) as RelationshipType[];

export function RelationshipEditor({ character, compact }: { character: Character; compact?: boolean }) {
  const doc = useEditorStore((s) => s.doc)!;
  const dispatch = useEditorStore((s) => s.dispatch);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<ID | null>(null);
  const [otherId, setOtherId] = useState("");
  const [type, setType] = useState<RelationshipType>("friend");

  const edges = relationshipsFor(doc, character.id);
  const others = Object.values(doc.characters).filter(
    (candidate) => candidate.id !== character.id && typeof candidate.name === "string",
  );

  const save = () => {
    if (!otherId) return;
    // Re-typing an existing edge: drop the old one first so the pair does not
    // end up carrying two contradictory relationships.
    if (editingId) dispatch({ type: "remove-relationship", relationshipId: editingId });
    dispatch({
      type: "add-relationship",
      characterAId: character.id,
      characterBId: otherId,
      relationshipType: type,
    });
    setAdding(false);
    setEditingId(null);
    setOtherId("");
  };

  const startEdit = (edgeId: ID, partnerId: ID, currentType: RelationshipType) => {
    setEditingId(edgeId);
    setOtherId(partnerId);
    setType(currentType);
    setAdding(true);
  };

  return (
    <div className={compact ? "" : "rounded-lg p-2.5"} style={compact ? undefined : { background: "var(--bg-elevated)" }}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Relationships
        </span>
        <button
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
          disabled={others.length === 0}
          title={others.length === 0 ? "Create another character first" : "Add a relationship"}
          onClick={() => {
            setEditingId(null);
            setOtherId("");
            setType("friend");
            setAdding((open) => !open);
          }}
        >
          {adding ? (
            "Cancel"
          ) : (
            <>
              <PlusIcon size={11} strokeWidth={ICON_STROKE} />
              Add Relationship
            </>
          )}
        </button>
      </div>

      {edges.length === 0 && !adding && (
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
          None yet. Add one so the Agent can resolve “her close friend” to a real character instead of guessing.
        </p>
      )}

      <ul className="space-y-0.5">
        {edges.map((edge) => {
          const partnerId = edge.characterAId === character.id ? edge.characterBId : edge.characterAId;
          const partner = doc.characters[partnerId];
          return (
            <li key={edge.id} className="flex items-center gap-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                {partner?.name ?? "Unknown"}
                <span style={{ color: "var(--text-muted)" }}> · {edge.label ?? RELATIONSHIP_LABELS[edge.type]}</span>
              </span>
              <button
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                style={{ color: "var(--text-muted)" }}
                aria-label={`Edit relationship with ${partner?.name ?? "character"}`}
                title="Change relationship"
                onClick={() => startEdit(edge.id, partnerId, edge.type)}
              >
                <RenameIcon size={11} strokeWidth={2} />
              </button>
              <button
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                style={{ color: "var(--text-muted)" }}
                aria-label={`Remove relationship with ${partner?.name ?? "character"}`}
                title="Remove relationship"
                onClick={() => dispatch({ type: "remove-relationship", relationshipId: edge.id })}
              >
                <CloseIcon size={11} strokeWidth={2.25} />
              </button>
            </li>
          );
        })}
      </ul>

      {adding && (
        <div className="mt-1.5 space-y-1">
          <label className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
            Character
            <select
              aria-label="Related character"
              className="mt-0.5 w-full rounded-md border px-1 py-1 text-[11px]"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}
              value={otherId}
              onChange={(event) => setOtherId(event.target.value)}
            >
              <option value="">Choose a character…</option>
              {others.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
            Relationship
            <select
              aria-label="Relationship type"
              className="mt-0.5 w-full rounded-md border px-1 py-1 text-[11px]"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}
              value={type}
              onChange={(event) => setType(event.target.value as RelationshipType)}
            >
              {TYPES.map((key) => (
                <option key={key} value={key}>
                  {RELATIONSHIP_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="w-full rounded-md bg-[var(--accent)] py-1 text-[11px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
            disabled={!otherId}
            onClick={save}
          >
            {editingId ? "Save change" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
