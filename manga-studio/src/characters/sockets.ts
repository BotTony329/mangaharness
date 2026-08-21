/**
 * Semantic sockets — the "digital action figure" drop targets (§5/§6).
 *
 * Dropping an expression card on a character's face must change
 * `CharacterState.expression`. It must never overlay an image: the state
 * resolver decides how the expression is visually produced, which is what keeps
 * one character one entity instead of a stack of PNGs.
 *
 * Sockets are DERIVED, never stored. They are hit-test regions over an
 * instance, not document data — storing them would create a second state
 * system alongside the document, and they would immediately drift whenever an
 * instance is resized, reframed, or swapped to another asset.
 *
 * Region geometry is an honest heuristic: the face band reuses the same
 * upper-body convention the framing code already uses. When an asset carries
 * real `focusRegions`, `socketRegions` prefers them, so accuracy improves
 * without any caller changing.
 */

import type { AssetInstance, CharacterSocket, FocusRegion, Rect } from "@/domain/types";

/** Fraction of the instance height treated as the head when no metadata exists. */
const HEURISTIC_FACE_HEIGHT = 0.28;

export interface SocketRegion {
  socket: CharacterSocket;
  /** Normalized 0–1 within the instance's own box. */
  rect: Rect;
  /** True when the region came from real asset metadata rather than the heuristic. */
  precise: boolean;
}

export interface SocketTarget {
  socket: CharacterSocket;
  instanceId: string;
}

export type SocketDimension = "expression" | "pose" | "outfit" | "props";

/** What each socket changes, so the UI can label a drag without knowing the model. */
export const SOCKET_DIMENSION: Record<CharacterSocket, SocketDimension> = {
  face: "expression",
  body: "pose",
  outfit: "outfit",
  hand: "props",
};

export function socketForDimension(dimension: SocketDimension): CharacterSocket {
  if (dimension === "expression") return "face";
  if (dimension === "pose") return "body";
  if (dimension === "props") return "hand";
  return "outfit";
}

/**
 * Socket regions for an instance, ordered smallest-first.
 *
 * Order matters for hit testing: the face sits inside the body, so a point in
 * the head must resolve to `face`. `outfit` deliberately shares the body's
 * region — it is reachable by explicit drop type, not by position, because
 * there is no separate place on a drawing that means "the clothes".
 */
export function socketRegions(focusRegions?: FocusRegion[]): SocketRegion[] {
  const face = focusRegions?.find((region) => region.kind === "face");
  return [
    {
      socket: "face",
      rect: face?.rect ?? { x: 0.2, y: 0, width: 0.6, height: HEURISTIC_FACE_HEIGHT },
      precise: Boolean(face),
    },
    // Hands sit at the sides around waist height in a standing full body. This
    // is a heuristic band, not detection; a prop drop anywhere on the figure
    // still resolves via `acceptable`, so precision here only affects the
    // highlight, never whether the drop works.
    { socket: "hand", rect: { x: 0, y: 0.4, width: 1, height: 0.3 }, precise: false },
    { socket: "body", rect: { x: 0, y: 0, width: 1, height: 1 }, precise: false },
  ];
}

/**
 * Which socket a panel-local point lands on, or null when outside the instance.
 *
 * `acceptable` restricts the answer to sockets the current drag can satisfy, so
 * dragging a pose card over the head resolves to `body` rather than reporting a
 * face hit the drop could not honour.
 */
export function resolveSocketAt(
  instance: AssetInstance,
  point: { x: number; y: number },
  focusRegions?: FocusRegion[],
  acceptable?: CharacterSocket[],
): CharacterSocket | null {
  const left = instance.cx - instance.width / 2;
  const top = instance.cy - instance.height / 2;
  if (instance.width <= 0 || instance.height <= 0) return null;
  const u = (point.x - left) / instance.width;
  const v = (point.y - top) / instance.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  for (const region of socketRegions(focusRegions)) {
    if (acceptable && !acceptable.includes(region.socket)) continue;
    const { rect } = region;
    if (u >= rect.x && u <= rect.x + rect.width && v >= rect.y && v <= rect.y + rect.height) {
      return region.socket;
    }
  }
  return null;
}

/** Socket region in panel-local pixels, for drawing the drop highlight. */
export function socketRectPx(instance: AssetInstance, socket: CharacterSocket, focusRegions?: FocusRegion[]): Rect {
  const region = socketRegions(focusRegions).find((candidate) => candidate.socket === socket);
  const rect = region?.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  const left = instance.cx - instance.width / 2;
  const top = instance.cy - instance.height / 2;
  return {
    x: left + rect.x * instance.width,
    y: top + rect.y * instance.height,
    width: rect.width * instance.width,
    height: rect.height * instance.height,
  };
}

/** MIME-ish drag payload so the canvas can accept semantic cards, not files. */
export const SOCKET_DRAG_TYPE = "application/x-character-state";

export interface SocketDragPayload {
  dimension: SocketDimension;
  value: string;
  characterId?: string;
}

export function encodeSocketDrag(payload: SocketDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeSocketDrag(raw: string): SocketDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as SocketDragPayload;
    if (!parsed || typeof parsed.value !== "string") return null;
    const dimensions: SocketDimension[] = ["expression", "pose", "outfit", "props"];
    if (!dimensions.includes(parsed.dimension)) return null;
    return parsed;
  } catch {
    return null;
  }
}
