/**
 * Scene interactions: coordinated actions between characters.
 *
 * ## The rule this module exists to enforce
 *
 * `hug(Yuri, Mio)` must NEVER decay into `Yuri.pose = "hug"` plus
 * `Mio.pose = "hug"` generated independently. Two independent renders share no
 * geometry, so the arms miss, the torsos interpenetrate, the heads sit at
 * unrelated heights and the scales disagree. An interaction owns the geometry
 * that is *between* the participants; that is the whole reason it is a separate
 * object rather than a pose value on each character.
 *
 * ## Local versus generative
 *
 * Some interactions are just placement (`beside`), some are a shared contact
 * point two rigs can reach (`hold_hands`), and some require the participants to
 * genuinely overlap and occlude each other (`hug`). Forcing all three through
 * puppet deformation would produce broken artwork; forcing all three through
 * generation would burn money on a problem that is arithmetic. The capability
 * evaluator picks, and says why.
 */

import { newId, now } from "./factory";
import { cloneDoc, touch } from "./docHelpers";
import type {
  CharacterInteraction,
  ID,
  InteractionAnchor,
  InteractionRender,
  InteractionRenderMode,
  InteractionType,
  Point,
  ProjectDocument,
} from "./types";
import { canApplyJoint } from "@/puppet/capability";
import { partOfType, type MangaPuppet } from "@/puppet/model";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const INTERACTION_TYPES: InteractionType[] = [
  "beside",
  "face_to_face",
  "look_at",
  "hold_hands",
  "hug",
  "high_five",
  "hand_object",
  "lean_on",
  "walk_together",
  "sit_together",
];

export const INTERACTION_LABELS: Record<InteractionType, string> = {
  beside: "Beside",
  face_to_face: "Face to Face",
  look_at: "Look At",
  hold_hands: "Hold Hands",
  hug: "Hug",
  high_five: "High Five",
  hand_object: "Hand Over Object",
  lean_on: "Lean On",
  walk_together: "Walk Together",
  sit_together: "Sit Together",
};

/**
 * Phrases a creator or the Agent might use, mapped to a type.
 *
 * Longest match wins so "hold hands" beats "hand". Anything unlisted resolves
 * to null rather than being coerced into the nearest-looking interaction.
 */
const INTERACTION_TERMS: { terms: string[]; type: InteractionType }[] = [
  { terms: ["hold hands", "holding hands", "hold her hand", "hold his hand"], type: "hold_hands" },
  { terms: ["high five", "high-five"], type: "high_five" },
  { terms: ["hug", "hugs", "hugging", "embrace", "embraces"], type: "hug" },
  { terms: ["hand over", "hands over", "give", "gives", "pass", "passes"], type: "hand_object" },
  { terms: ["lean on", "leans on", "leaning on"], type: "lean_on" },
  { terms: ["walk together", "walking together", "walk with", "walks with"], type: "walk_together" },
  { terms: ["sit together", "sitting together", "sit with", "sits with"], type: "sit_together" },
  { terms: ["face to face", "facing each other", "face each other"], type: "face_to_face" },
  { terms: ["look at", "looks at", "looking at", "stare at", "stares at"], type: "look_at" },
  { terms: ["beside", "next to", "stand with", "stands with"], type: "beside" },
];

export function interactionTypeFromPhrase(phrase: string): InteractionType | null {
  const text = phrase.toLowerCase();
  const matches = INTERACTION_TERMS.flatMap((entry) =>
    entry.terms.filter((term) => text.includes(term)).map((term) => ({ term, type: entry.type })),
  ).sort((a, b) => b.term.length - a.term.length);
  return matches[0]?.type ?? null;
}

// ─── Capability ─────────────────────────────────────────────────────────────

export type InteractionMode = "LOCAL_STAGE" | "LOCAL_PUPPET" | "HYBRID" | "JOINT_GENERATION";

export interface InteractionCapabilityResult {
  supportedLocally: boolean;
  mode: InteractionMode;
  reason?: string;
  /** Which participants lack the rig this interaction would need. */
  blockedBy?: ID[];
}

/** Interactions that are pure placement — no rig involvement at all. */
const STAGE_ONLY: InteractionType[] = ["beside", "face_to_face", "walk_together", "sit_together"];

/** Interactions realised by a shared contact point two rigs reach toward. */
const CONTACT: Partial<Record<InteractionType, { joint: "wristLeft" | "wristRight"; contact: "leftHand" | "rightHand" }>> = {
  hold_hands: { joint: "wristRight", contact: "rightHand" },
  high_five: { joint: "wristRight", contact: "rightHand" },
  hand_object: { joint: "wristRight", contact: "rightHand" },
};

/**
 * Interactions whose participants genuinely overlap and occlude one another.
 *
 * These are not a rig problem. A hug needs one arm *behind* the other person's
 * back, which flat parts cannot express at all — no joint rotation produces
 * occlusion that the source artwork does not contain.
 */
const REQUIRES_JOINT_RENDER: InteractionType[] = ["hug", "lean_on"];

export interface CapabilityInput {
  type: InteractionType;
  /** Puppet per participant, when they have one. */
  puppets: (MangaPuppet | undefined)[];
  participantIds: ID[];
}

export function evaluateInteractionCapability(input: CapabilityInput): InteractionCapabilityResult {
  const { type, puppets, participantIds } = input;

  if (participantIds.length < 2) {
    return { supportedLocally: false, mode: "JOINT_GENERATION", reason: "An interaction needs at least two participants." };
  }

  if (STAGE_ONLY.includes(type)) {
    // Pure placement: works for flat characters and puppets alike, because it
    // only moves whole actors on the existing stage.
    return { supportedLocally: true, mode: "LOCAL_STAGE" };
  }

  if (REQUIRES_JOINT_RENDER.includes(type)) {
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      reason: `A ${INTERACTION_LABELS[type].toLowerCase()} needs the characters to overlap and occlude each other, which cannot be produced by moving existing artwork.`,
    };
  }

  if (type === "look_at") {
    // Turning a head is a single joint, so this is local when both have one.
    const blockedBy = participantIds.filter((_, index) => {
      const puppet = puppets[index];
      return !puppet || !canApplyJoint(puppet, "head", 20).supported;
    });
    if (blockedBy.length === 0) return { supportedLocally: true, mode: "LOCAL_PUPPET" };
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      blockedBy,
      reason: "Looking at each other needs head rotation these characters cannot do locally.",
    };
  }

  const contact = CONTACT[type];
  if (contact) {
    const blockedBy = participantIds.filter((_, index) => {
      const puppet = puppets[index];
      if (!puppet) return true;
      // Both an articulated arm and a hand part are needed to meet an anchor.
      return !partOfType(puppet, "handRight") || !canApplyJoint(puppet, contact.joint, 20).supported;
    });
    if (blockedBy.length === 0) return { supportedLocally: true, mode: "LOCAL_PUPPET" };
    /**
     * One rigged participant and one flat one is genuinely a hybrid: the rigged
     * arm can reach the anchor while the flat character is only positioned.
     * Reporting that honestly beats pretending either extreme.
     */
    if (blockedBy.length < participantIds.length) {
      return {
        supportedLocally: false,
        mode: "HYBRID",
        blockedBy,
        reason: "Only some participants can reach a shared contact point; the rest can only be positioned.",
      };
    }
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      blockedBy,
      reason: "Neither character has an arm rig that can reach a shared contact point.",
    };
  }

  return { supportedLocally: false, mode: "JOINT_GENERATION", reason: "This interaction has no local representation yet." };
}

// ─── Document operations ────────────────────────────────────────────────────

export interface CreateInteractionInput {
  panelId: ID;
  participantIds: ID[];
  type: InteractionType;
  roles?: Record<string, ID>;
  renderMode?: InteractionRenderMode;
  anchors?: InteractionAnchor[];
  status?: CharacterInteraction["status"];
}

export function createInteraction(
  doc: ProjectDocument,
  input: CreateInteractionInput,
): { doc: ProjectDocument; interactionId: ID } {
  if (!doc.panels[input.panelId]) throw new Error(`Unknown panel: ${input.panelId}`);
  if (input.participantIds.length < 2) throw new Error("An interaction needs at least two participants");
  for (const id of input.participantIds) {
    if (!doc.characters[id]) throw new Error(`Unknown character: ${id}`);
  }
  const next = cloneDoc(doc);
  const interaction: CharacterInteraction = {
    id: newId(),
    panelId: input.panelId,
    participantIds: [...input.participantIds],
    type: input.type,
    roles: input.roles,
    anchors: input.anchors,
    renderMode: input.renderMode,
    status: input.status ?? "planned",
    createdAt: now(),
  };
  next.interactions[interaction.id] = interaction;
  touch(next);
  return { doc: next, interactionId: interaction.id };
}

export function removeInteraction(doc: ProjectDocument, interactionId: ID): ProjectDocument {
  if (!doc.interactions[interactionId]) return doc;
  const next = cloneDoc(doc);
  delete next.interactions[interactionId];
  touch(next);
  return next;
}

/** Attach a shared contact anchor, e.g. the point two joined hands meet at. */
export function setInteractionAnchor(
  doc: ProjectDocument,
  interactionId: ID,
  anchor: InteractionAnchor,
): ProjectDocument {
  const next = cloneDoc(doc);
  const interaction = next.interactions[interactionId];
  if (!interaction) throw new Error(`Unknown interaction: ${interactionId}`);
  const anchors = interaction.anchors ?? [];
  const index = anchors.findIndex((candidate) => candidate.id === anchor.id);
  if (index === -1) anchors.push(anchor);
  else anchors[index] = anchor;
  interaction.anchors = anchors;
  touch(next);
  return next;
}

/** Interactions in a panel, optionally filtered to those involving a character. */
export function interactionsInPanel(doc: ProjectDocument, panelId: ID, characterId?: ID): CharacterInteraction[] {
  return Object.values(doc.interactions ?? {}).filter(
    (interaction) =>
      interaction.panelId === panelId &&
      (!characterId || interaction.participantIds.includes(characterId)),
  );
}

// ─── Shared anchors ─────────────────────────────────────────────────────────

/**
 * The midpoint two participants should both reach.
 *
 * Deliberately arithmetic, not a solver: the anchor sits between the actors at
 * a plausible hand height, and each rig aims at it. Building a constraint
 * solver here would be the "physics engine" the brief rules out, and it would
 * not survive contact with flat artwork anyway.
 */
export function midpointAnchor(
  a: { cx: number; cy: number; width: number; height: number },
  b: { cx: number; cy: number; width: number; height: number },
  contacts: InteractionAnchor["contacts"],
  id = "shared-hand",
): InteractionAnchor {
  const at: Point = {
    x: (a.cx + b.cx) / 2,
    // Hands hang around two-thirds down the figure; use the shorter actor so
    // the taller one reaches down rather than the shorter one reaching up.
    y: Math.max(a.cy + a.height * 0.18, b.cy + b.height * 0.18),
  };
  return { id, at, contacts };
}

/** How far each participant's contact point currently sits from the anchor. */
export function anchorDeviation(
  anchor: InteractionAnchor,
  contactPoints: Record<ID, Point>,
): { participantId: ID; distance: number }[] {
  return Object.entries(anchor.contacts).map(([participantId]) => {
    const point = contactPoints[participantId];
    return {
      participantId,
      distance: point ? Math.hypot(point.x - anchor.at.x, point.y - anchor.at.y) : Infinity,
    };
  });
}

// ─── Joint generation contract ──────────────────────────────────────────────

export interface MultiCharacterGenerationRequest {
  participantCharacterIds: ID[];
  /** One identity reference per participant, in the same order. Never merged. */
  participantReferenceAssetIds: ID[];
  interactionType: InteractionType;
  roles?: Record<string, ID>;
  cameraContext?: string[];
  styleProfileId?: ID;
  identityConstraints: string[];
  outfitConstraints: string[];
  interactionConstraints: string[];
}

/**
 * Everything that makes a joint render reusable.
 *
 * Participants are sorted so Yuri+Mio and Mio+Yuri share a cache entry, but the
 * ROLES are included unsorted — "Yuri hugs Mio" and "Mio hugs Yuri" are
 * different images. Outfits, view and style are included because a school
 * uniform hug is not a casual-clothes hug.
 */
export function interactionCacheKey(input: {
  participantCharacterIds: ID[];
  type: InteractionType;
  roles?: Record<string, ID>;
  outfits: string[];
  view: string;
  styleProfileId?: ID;
  shot?: string;
  angle?: string;
}): string {
  const participants = [...input.participantCharacterIds].sort();
  const roles = Object.entries(input.roles ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, id]) => `${role}:${id}`)
    .join(",");
  const outfits = [...input.outfits].map((outfit) => outfit.trim().toLowerCase()).sort();
  return [
    `p=${participants.join("+")}`,
    `t=${input.type}`,
    `r=${roles}`,
    `o=${outfits.join("+")}`,
    `v=${input.view.trim().toLowerCase()}`,
    `s=${input.styleProfileId ?? "default"}`,
    `c=${input.shot ?? "any"}/${input.angle ?? "any"}`,
  ].join("|");
}

/** An existing joint render for this exact configuration, or null. */
export function findInteractionRender(doc: ProjectDocument, cacheKey: string): InteractionRender | null {
  return (
    Object.values(doc.interactionRenders ?? {}).find((render) => {
      if (render.cacheKey !== cacheKey) return false;
      // A render whose asset was deleted is not reusable.
      const asset = doc.assets[render.generatedAssetId];
      return Boolean(asset) && asset.status !== "archived";
    }) ?? null
  );
}

export function recordInteractionRender(
  doc: ProjectDocument,
  input: Omit<InteractionRender, "id" | "createdAt">,
): { doc: ProjectDocument; renderId: ID } {
  const next = cloneDoc(doc);
  const render: InteractionRender = { ...input, id: newId(), createdAt: now() };
  next.interactionRenders[render.id] = render;
  const interaction = next.interactions[input.interactionId];
  if (interaction) {
    interaction.renderId = render.id;
    interaction.renderMode = "composite";
    interaction.status = "active";
  }
  touch(next);
  return { doc: next, renderId: render.id };
}

/**
 * Which characters a generated image actually contains.
 *
 * Grounding and deletion both need this: a composite render of Yuri and Mio is
 * not "a Yuri asset", and deleting Mio should be able to report that it would
 * orphan this image.
 */
export function charactersInAsset(doc: ProjectDocument, assetId: ID): ID[] {
  const render = Object.values(doc.interactionRenders ?? {}).find(
    (candidate) => candidate.generatedAssetId === assetId,
  );
  if (render) return [...render.participantCharacterIds];
  const single = doc.assets[assetId]?.metadata?.characterId;
  return single ? [single] : [];
}

/**
 * Build the joint-generation request.
 *
 * Every participant contributes their OWN reference image. Describing one
 * character in text while sending the other's picture is what makes a model
 * blend two people into one, so a participant without a usable reference is a
 * hard failure rather than a text fallback.
 */
export function buildMultiCharacterRequest(
  doc: ProjectDocument,
  interaction: CharacterInteraction,
  context: { cameraContext?: string[]; styleProfileId?: ID; outfits?: Record<ID, string> },
): MultiCharacterGenerationRequest {
  const references: ID[] = [];
  for (const characterId of interaction.participantIds) {
    const character = doc.characters[characterId];
    const referenceId = character?.canonicalReferenceAssetId ?? character?.referenceAssetId;
    if (!referenceId || !doc.assets[referenceId]) {
      throw new Error(
        `${character?.name ?? characterId} has no canonical reference, so their identity cannot be preserved in a joint render.`,
      );
    }
    references.push(referenceId);
  }

  const names = interaction.participantIds.map((id) => doc.characters[id]?.name ?? id);
  return {
    participantCharacterIds: [...interaction.participantIds],
    participantReferenceAssetIds: references,
    interactionType: interaction.type,
    roles: interaction.roles,
    cameraContext: context.cameraContext,
    styleProfileId: context.styleProfileId,
    identityConstraints: names.map(
      (name, index) =>
        `Preserve ${name}'s exact face, hairstyle and proportions from reference image ${index + 1}. Do not blend their features with the other character.`,
    ),
    outfitConstraints: interaction.participantIds.map((id, index) => {
      const outfit = context.outfits?.[id];
      return outfit
        ? `${names[index]} wears ${outfit}, unchanged.`
        : `Keep ${names[index]}'s outfit exactly as shown in reference image ${index + 1}.`;
    }),
    interactionConstraints: interactionConstraintsFor(interaction.type, names),
  };
}

function interactionConstraintsFor(type: InteractionType, names: string[]): string[] {
  const [first, second] = names;
  const shared = [
    "Both characters occupy the same scene, at the same scale, from one consistent viewpoint.",
    "Consistent lighting and one shared perspective across both figures.",
  ];
  switch (type) {
    case "hug":
      return [
        `${first} and ${second} share a natural mutual embrace, arms wrapped around each other with believable contact and overlap.`,
        "Show correct occlusion where one figure passes behind the other.",
        ...shared,
      ];
    case "lean_on":
      return [`${second} leans against ${first} with real contact and weight.`, ...shared];
    case "hold_hands":
      return [`${first} and ${second} hold hands, with their hands actually meeting.`, ...shared];
    case "high_five":
      return [`${first} and ${second} high-five, palms meeting at one point.`, ...shared];
    default:
      return [`${first} and ${second} ${INTERACTION_LABELS[type].toLowerCase()}.`, ...shared];
  }
}
