/**
 * Sequence plan — the typed layer between understanding and editor commands.
 *
 * ## Why natural language does not become tool calls directly
 *
 * The scene intent knew that "run toward the camera, THEN shout" was two
 * moments. Nothing enforced it: the planner was told, and whether beat two
 * landed in its own panel depended on what the model chose to emit. A structure
 * that is only advisory is not a structure.
 *
 * A `SequencePlan` is the enforced form. Every beat carries the panel it runs
 * in, resolved deterministically by `panelAllocation`, and compiles into the
 * editor commands Kumanga already has. The planner may interpret language; it
 * does not get to decide where a moment happens.
 *
 * ## Compilation order matters
 *
 * Layout growth first (so later panels exist), then per-panel: camera, then
 * placement, then depth, then focus, then dialogue. Camera before placement
 * because framing changes re-stage the panel; depth after placement because an
 * actor must be present before they can be pushed back.
 *
 * ## Nothing here generates
 *
 * Every command this emits is an EDITOR_OP or a reuse-first placement. A closer
 * shot re-frames existing artwork; it never redraws a character.
 */

import type { ID, ProjectDocument } from "@/domain/types";
import type { AgentPlan } from "./tools/schemas";
import { allocatePanels, inferLayout, type PanelAllocation } from "./panelAllocation";
import { isEmptyCameraIntent, parseCameraIntent, resolveDepthPlacements, type CameraIntent } from "./cameraIntent";
import { namesNextPanel, panelOrdinalIn, type SceneBeat, type SceneIntent } from "./sceneIntent";
import type { AgentRunScope } from "./scope";

export interface PlannedBeat {
  beatId: string;
  /** 1-based panel this beat executes in. Authoritative. */
  panelNumber: number;
  /**
   * Everyone who must be IN the panel for this moment.
   *
   * Wider than the actor: "她回头看Mori" needs Mori present to be looked at.
   */
  subjects: ID[];
  /**
   * The one performing the action.
   *
   * Applying the pose to every subject made Mori turn around too, because she
   * was named in the sentence. Being mentioned is not being the actor.
   */
  actorId?: ID;
  action?: string;
  expression?: string;
  dialogue?: { speakerId: ID; text: string; delivery: "normal" | "shout" | "whisper" | "thought" };
  camera?: CameraIntent;
  interaction?: { type: string; partnerId: ID };
  /** The creator's own words this beat came from. */
  source: string;
}

export interface SequencePlan {
  pageId: ID;
  beats: PlannedBeat[];
  /** Distinct visual moments the prompt asked for. */
  requiredPanelCount: number;
  allocation: PanelAllocation;
  /** True when the plan is only camera/staging work — no new pixels needed. */
  editorOnly: boolean;
  /** True when any beat asks for camera, perspective or focus — panel-level work. */
  needsPanelLevel: boolean;
}

/**
 * Group beats into visual MOMENTS.
 *
 * A moment is everything that happens at one instant: running while smiling is
 * one drawing. The scene intent already split the sentence on temporal
 * connectives, so each fragment is one moment — beats are grouped by the
 * fragment they came from.
 */
function moments(intent: SceneIntent): SceneBeat[][] {
  const bySource = new Map<string, SceneBeat[]>();
  const order: string[] = [];
  for (const beat of intent.beats) {
    if (!bySource.has(beat.source)) {
      bySource.set(beat.source, []);
      order.push(beat.source);
    }
    bySource.get(beat.source)!.push(beat);
  }
  return order.map((source) => bySource.get(source)!);
}

export interface BuildSequenceInput {
  doc: ProjectDocument;
  intent: SceneIntent;
  scope: AgentRunScope;
  /** Grounded characters, subject first. */
  characterIds: ID[];
}

export function buildSequencePlan(input: BuildSequenceInput): SequencePlan {
  const { doc, intent, scope, characterIds } = input;
  const grouped = moments(intent);
  const page = doc.pages[scope.pageId];
  const anchorFromScope = scope.panelNumber ?? 1;

  /**
   * Resolve which panel each moment wants BEFORE deciding how the page grows.
   *
   * Growth depends on the highest panel the sequence reaches, and that number
   * is only known once "下一格" and "第三格" have been honoured. Allocating first
   * and then applying the names produced a plan that asked for panel 2 on a
   * page that had only been grown to hold panel 1.
   */
  const firstOrdinal = grouped.length > 0 ? panelOrdinalIn(grouped[0][0]?.source ?? "") : undefined;
  const anchor = firstOrdinal ?? anchorFromScope;

  const targets: number[] = [];
  grouped.forEach((group, index) => {
    const source = group[0]?.source ?? "";
    const explicit = panelOrdinalIn(source);
    const previous = targets[targets.length - 1];
    if (explicit !== undefined) {
      targets.push(explicit);
      return;
    }
    if (namesNextPanel(source)) {
      // "the next panel" — after the previous moment, or after the panel the
      // creator is working in when this is the first thing they said.
      targets.push((previous ?? anchor) + 1);
      return;
    }
    targets.push(previous !== undefined ? previous + 1 : anchor + index);
  });
  if (targets.length === 0) targets.push(anchor);

  const highest = Math.max(...targets);
  const allocation = allocatePanels({
    doc,
    pageId: scope.pageId,
    anchorPanelNumber: Math.min(...targets),
    requiredMoments: highest - Math.min(...targets) + 1,
    currentLayout: inferLayout(doc, scope.pageId),
  });
  // The allocation exists to decide GROWTH; the resolved targets stay authoritative.
  allocation.panelNumbers = [...new Set(targets)].sort((a, b) => a - b);

  const beats: PlannedBeat[] = [];
  grouped.forEach((group, index) => {
    const source = group[0]?.source ?? "";
    const panelNumber = targets[index];

    const subjects = [...new Set(group.map((beat) => beat.actor).filter((id): id is ID => Boolean(id)))];
    const movement = group.find((beat) => beat.type === "movement");
    const expression = group.find((beat) => beat.type === "expression");
    const dialogue = group.find((beat) => beat.type === "dialogue");
    const interaction = group.find((beat) => beat.type === "interaction");
    const other = group.find((beat) => beat.type === "action");

    const camera = parseCameraIntent({
      text: source,
      doc,
      characterIds,
      subjectId: subjects[0] ?? characterIds[0],
    });

    /**
     * Movement toward the camera is a depth statement about the LATER moment:
     * the actor ends up nearer than they started. Expressed through the stage,
     * not by scaling artwork.
     */
    if (movement?.direction === "toward_camera" && subjects[0]) {
      camera.placements = [
        ...(camera.placements ?? []).filter((p) => p.characterId !== subjects[0]),
        { characterId: subjects[0], placement: index === 0 ? "midground" : "foreground" },
      ];
      camera.shot = camera.shot ?? (index === 0 ? "full" : "medium");
      camera.focalCharacterId = camera.focalCharacterId ?? subjects[0];
    }

    /** Everyone the moment names appears in it, not only its actor. */
    const mentioned = characterIds.filter((id) => {
      const name = doc.characters[id]?.name;
      return typeof name === "string" && source.toLowerCase().includes(name.toLowerCase());
    });
    for (const id of mentioned) if (!subjects.includes(id)) subjects.push(id);
    if (subjects.length === 0 && characterIds[0]) subjects.push(characterIds[0]);

    beats.push({
      beatId: `beat-${index + 1}`,
      panelNumber,
      subjects,
      actorId: movement?.actor ?? other?.actor ?? expression?.actor ?? dialogue?.actor ?? subjects[0],
      action: movement?.action ?? other?.action,
      expression: expression?.action,
      dialogue:
        dialogue?.text && dialogue.actor
          ? { speakerId: dialogue.actor, text: dialogue.text, delivery: dialogue.delivery ?? "normal" }
          : undefined,
      camera: isEmptyCameraIntent(camera) ? undefined : camera,
      interaction: interaction?.interaction && interaction.partner
        ? { type: interaction.interaction, partnerId: interaction.partner }
        : undefined,
      source,
    });
  });

  const editorOnly = beats.every((beat) => !beat.interaction && !beat.action && !beat.expression);

  const needsPanelLevel = beats.some(
    (beat) =>
      beat.camera?.shot !== undefined ||
      beat.camera?.angle !== undefined ||
      beat.camera?.lens !== undefined ||
      beat.camera?.perspective !== undefined ||
      beat.camera?.focalCharacterId !== undefined,
  );

  return {
    pageId: page?.id ?? scope.pageId,
    beats,
    needsPanelLevel,
    requiredPanelCount: new Set(beats.map((beat) => beat.panelNumber)).size,
    allocation,
    editorOnly,
  };
}

// ─── Compilation ────────────────────────────────────────────────────────────

type Step = AgentPlan["steps"][number];

/**
 * Compile the plan into editor commands.
 *
 * The output is an ordinary tool plan, so it goes through the same validation,
 * capability routing, transaction and post-condition checks every other run
 * does. There is no privileged execution path.
 */
export function compileSequencePlan(plan: SequencePlan, doc: ProjectDocument): Step[] {
  const steps: Step[] = [];
  const name = (id: ID) => doc.characters[id]?.name ?? id;

  // 1. Grow the page first, so the panels later beats need actually exist.
  if (plan.allocation.layoutUpgrade) {
    steps.push({ tool: "set_page_layout", args: { layout: plan.allocation.layoutUpgrade } });
  }

  for (const beat of plan.beats) {
    const panel = beat.panelNumber;

    // 2. Camera before placement: framing re-stages the panel.
    if (beat.camera) {
      const { shot, angle, lens, roll } = beat.camera;
      if (shot || angle || lens || roll !== undefined) {
        steps.push({
          tool: "set_camera",
          args: { panel, ...(shot ? { shot } : {}), ...(angle ? { angle } : {}), ...(lens ? { lens } : {}) },
        });
      }
      if (beat.camera.perspective) {
        steps.push({ tool: "set_perspective", args: { panel, type: beat.camera.perspective } });
      }
    }

    /**
     * 3. The actors this moment needs.
     *
     * An actor already standing in the panel is REUSED, never placed again:
     * "Yuri在前景" is a staging instruction about the Yuri who is already there,
     * and emitting a placement would leave two of her in the frame with the
     * depth applied to only one. When such an actor also needs a new pose or
     * expression, that is a state change on the existing instance.
     */
    for (const characterId of beat.subjects) {
      // Only the actor takes the pose and expression; the rest are simply there.
      const isActor = characterId === beat.actorId;
      const pose = isActor ? beat.action : undefined;
      const expression = isActor ? beat.expression : undefined;
      const present = alreadyInPanel(doc, plan.pageId, panel, characterId);
      if (present) {
        if (pose || expression) {
          steps.push({
            tool: "set_character_slot",
            args: {
              panel,
              characterName: name(characterId),
              characterId,
              ...(pose ? { pose } : {}),
              ...(expression ? { expression } : {}),
            },
          });
        }
        continue;
      }
      steps.push({
        tool: "place_character",
        args: {
          panel,
          characterName: name(characterId),
          characterId,
          ...(pose ? { pose } : {}),
          ...(expression ? { expression } : {}),
        },
      });
    }

    // 4. A coordinated action replaces two independent placements.
    if (beat.interaction && beat.subjects[0]) {
      steps.push({
        tool: "create_interaction",
        args: {
          panel,
          interaction: beat.interaction.type,
          subjectCharacterName: name(beat.subjects[0]),
          subjectCharacterId: beat.subjects[0],
          targetCharacterName: name(beat.interaction.partnerId),
          targetCharacterId: beat.interaction.partnerId,
        },
      });
    }

    // 5. Depth once the actors are present.
    for (const placement of resolveDepthPlacements(beat.camera ?? {})) {
      steps.push({
        tool: "set_character_depth",
        args: {
          panel,
          characterName: name(placement.characterId),
          characterId: placement.characterId,
          placement: placement.placement,
        },
      });
    }

    // 6. Focus, which reframes around whoever the shot is about.
    if (beat.camera?.focalCharacterId) {
      steps.push({
        tool: "set_focal_character",
        args: { panel, characterName: name(beat.camera.focalCharacterId), characterId: beat.camera.focalCharacterId },
      });
    }

    // 7. Dialogue last, so the bubble sits over a finished panel.
    if (beat.dialogue) {
      steps.push({
        tool: "attach_bubble",
        args: {
          panel,
          characterName: name(beat.dialogue.speakerId),
          characterId: beat.dialogue.speakerId,
          bubbleType: beat.dialogue.delivery === "shout" ? "shout" : beat.dialogue.delivery === "whisper" ? "whisper" : "speech",
          text: beat.dialogue.text,
        },
      });
    }
  }

  return steps;
}


/** Is this character already standing in that panel? */
function alreadyInPanel(doc: ProjectDocument, pageId: ID, panelNumber: number, characterId: ID): boolean {
  const panelId = doc.pages[pageId]?.panelIds[panelNumber - 1];
  if (!panelId) return false;
  return (doc.panels[panelId]?.itemIds ?? []).some((itemId) => {
    const item = doc.items[itemId];
    if (item?.kind !== "asset") return false;
    const owner = item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
    return owner === characterId;
  });
}

/** Creator-facing summary of where each moment lands. */
export function describeSequencePlan(plan: SequencePlan, doc: ProjectDocument): string[] {
  return plan.beats.map((beat) => {
    const who = beat.subjects.map((id) => doc.characters[id]?.name ?? id).join(" + ") || "the panel";
    const parts: string[] = [];
    if (beat.action) parts.push(beat.action);
    if (beat.expression) parts.push(beat.expression);
    if (beat.interaction) parts.push(`${beat.interaction.type.replace(/_/g, " ")} with ${doc.characters[beat.interaction.partnerId]?.name ?? ""}`);
    if (beat.dialogue) parts.push(`says “${beat.dialogue.text}”`);
    return `Panel ${beat.panelNumber} · ${who}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
  });
}
