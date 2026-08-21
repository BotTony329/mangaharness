"use client";

/**
 * The Character Kit: one character as a parts box, not a folder of renders (§4).
 *
 * Every option is labelled with its real availability. CACHED means the exact
 * state already has a render; AVAILABLE means the value exists in some other
 * combination and this one must be generated; NEW means it has never been
 * rendered. Collapsing those three into "available" is exactly how a tool ends
 * up pretending a semantic state exists when only a compatible image does.
 *
 * Cards are draggable onto a placed character — the canvas resolves the socket
 * and the resolver decides cache-or-generate. This component performs no
 * generation and holds no semantic state of its own.
 */

import { useState } from "react";
import { buildCharacterKit, kitDimensionLabel, KIT_DIMENSIONS, type KitAvailability, type KitOption } from "@/characters/kit";
import { describeRecord } from "@/characters/stateGraph";
import { SOCKET_DRAG_TYPE, encodeSocketDrag, type SocketDimension } from "@/characters/sockets";
import { stateFromInstance } from "@/characters/state";
import { assetPreviewUrl } from "@/assets/renderSource";
import type { Character, CharacterState, ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

/**
 * Which kit dimensions can be dragged onto the figure. `view` is absent on
 * purpose: there is no region of a drawing that means "camera angle", so it
 * stays a dropdown rather than pretending to be a socket.
 */
const DIMENSION_DRAG: Partial<Record<string, SocketDimension>> = {
  pose: "pose",
  expression: "expression",
  outfit: "outfit",
};

export function CharacterKitPanel({ character }: { character: Character }) {
  const doc = useEditorStore((state) => state.doc);
  const selection = useEditorStore((state) => state.selection);
  const openGenerator = useUiStore((state) => state.openGenerator);
  const [showStates, setShowStates] = useState(false);
  if (!doc) return null;

  // When a character instance is selected, the kit describes THAT instance's
  // state, so "cached" answers the question the creator is actually asking.
  const selectedItem = selection.itemId ? doc.items[selection.itemId] : undefined;
  const selectedState: CharacterState | undefined =
    selectedItem?.kind === "asset" ? (stateFromInstance(doc, selectedItem) ?? undefined) : undefined;
  const viewedState = selectedState?.characterId === character.id ? selectedState : undefined;
  const kit = buildCharacterKit(doc, character, viewedState);

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
      <header className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-200">{kit.name}</span>
        <span className="ml-auto text-[10px] text-zinc-500">{kit.renderedStateCount} states</span>
      </header>

      {kit.canonicalAssetId ? (
        <div className="mb-2 flex items-center gap-2">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded border border-zinc-700 bg-[repeating-conic-gradient(#3f3f46_0%_25%,#27272a_0%_50%)] bg-[length:10px_10px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={assetPreviewUrl(doc.assets[kit.canonicalAssetId])}
              alt={`${kit.name} canonical`}
              className="h-full w-full object-contain"
            />
          </div>
          <div className="min-w-0 text-[10px] leading-4 text-zinc-500">
            <p className="text-zinc-400">Canonical identity</p>
            <p>Anchors every generated state.</p>
          </div>
        </div>
      ) : (
        <button
          className="mb-2 w-full rounded border border-dashed border-zinc-700 py-2 text-[11px] text-zinc-500 hover:border-indigo-600 hover:text-indigo-300"
          onClick={() => openGenerator({ assetType: "character", characterId: character.id })}
        >
          Generate canonical reference
        </button>
      )}

      {viewedState && (
        <p className="mb-2 truncate text-[10px] text-indigo-300" title="Options are shown relative to the selected instance">
          Editing: {describeState(viewedState)}
        </p>
      )}

      {KIT_DIMENSIONS.map((dimension) => (
        <Group
          key={dimension}
          label={kitDimensionLabel(dimension)}
          options={kit.dimensions[dimension]}
          dragDimension={DIMENSION_DRAG[dimension]}
          characterId={character.id}
          active={kit.state[dimension]}
          onAdd={() =>
            openGenerator({
              assetType: dimension === "expression" ? "character-expression" : "character-pose",
              characterId: character.id,
            })
          }
        />
      ))}

      {kit.props.length > 0 && (
        <Group
          label="Props"
          options={kit.props}
          dragDimension="props"
          characterId={character.id}
          active={(kit.state.props ?? []).join(", ")}
        />
      )}

      {kit.renderedStates.length > 0 && (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <button
            className="flex w-full items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowStates(!showStates)}
          >
            <span>{showStates ? "▾" : "▸"}</span> Rendered states ({kit.renderedStates.length})
          </button>
          {showStates && (
            <ul className="mt-1 space-y-0.5">
              {kit.renderedStates.map((record) => (
                <li key={record.id} className="flex items-center gap-1 text-[10px] text-zinc-400">
                  <span className="truncate">{describeRecord(record)}</span>
                  {record.parentStateId && doc.characterStates[record.parentStateId] && (
                    <span className="ml-auto shrink-0 text-[9px] text-zinc-600" title="Generated from">
                      ← {describeRecord(doc.characterStates[record.parentStateId])}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Group({
  label,
  options,
  dragDimension,
  characterId,
  active,
  onAdd,
}: {
  label: string;
  options: KitOption[];
  dragDimension?: SocketDimension;
  characterId: ID;
  active: string;
  onAdd?: () => void;
}) {
  return (
    <div className="mb-2">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <Card key={option.value} option={option} dimension={dragDimension} characterId={characterId} active={option.value === active} />
        ))}
        {onAdd && (
          <button
            className="rounded-full border border-dashed border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-indigo-600 hover:text-indigo-300"
            onClick={onAdd}
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}

const AVAILABILITY_STYLE: Record<KitAvailability, string> = {
  cached: "border-emerald-700/70 bg-emerald-950/40 text-emerald-300",
  available: "border-zinc-700 bg-zinc-800 text-zinc-400",
  new: "border-zinc-800 bg-zinc-900 text-zinc-500",
};

const AVAILABILITY_TITLE: Record<KitAvailability, string> = {
  cached: "Cached — a render of this exact state already exists",
  available: "Available — will be generated from the nearest existing render",
  new: "New — never rendered for this character",
};

function Card({
  option,
  dimension,
  characterId,
  active,
}: {
  option: KitOption;
  dimension?: SocketDimension;
  characterId: ID;
  active: boolean;
}) {
  const title = option.referenceLabel
    ? `${AVAILABILITY_TITLE[option.availability]} · from ${option.referenceLabel}`
    : AVAILABILITY_TITLE[option.availability];
  return (
    <span
      draggable={Boolean(dimension)}
      title={title}
      onDragStart={(event) => {
        if (!dimension) return;
        event.dataTransfer.setData(SOCKET_DRAG_TYPE, encodeSocketDrag({ dimension, value: option.value, characterId }));
        event.dataTransfer.effectAllowed = "copy";
      }}
      className={`${dimension ? "cursor-grab" : "cursor-default"} rounded-full border px-2 py-0.5 text-[10px] ${
        active ? "border-indigo-500 bg-indigo-600/30 text-indigo-200" : AVAILABILITY_STYLE[option.availability]
      }`}
    >
      {option.label}
      {option.availability === "cached" && <span className="ml-1 text-[8px]">●</span>}
    </span>
  );
}

function describeState(state: CharacterState): string {
  return [state.pose, state.expression].map((value) => value.replace(/(^|\s)\w/g, (m) => m.toUpperCase())).join(" · ");
}
