"use client";

/**
 * Capability Router — translates the Creative Task Map into the existing
 * tool-step plan the deterministic harness (agent-v2 orchestrator) executes.
 *
 * It reimplements NO service logic: every creative intent maps onto the same
 * tools the editor and the old engine already use, so transactions, rollback,
 * preserved-asset honesty and placeholder protection all apply unchanged.
 *
 * Identity rule: steps address characters by NAME only. Real IDs are bound at
 * execution time by the runtime binding table — this module never emits one
 * for a character being created.
 */

import type { AgentPlan } from "@/agent/tools/schemas";
import type { CreativeTaskMap } from "../contract/creativeTaskMap";
import type { Resolution } from "../resolution/entityResolver";
import { resolveCameraIntent } from "./cameraSemantics";
import { resolveInteraction } from "./interactionSemantics";
import { resolveDialogueDelivery } from "./dialogueSemantics";

type Step = AgentPlan["steps"][number];

export interface CompiledPlan {
  plan: AgentPlan;
  /** Soft-normalization notes (unknown creative camera words etc.). */
  warnings: string[];
}

function stateInstruction(action: string | undefined, poseDetails: string[]): string | undefined {
  const parts = [action, ...poseDetails].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export function compileTaskMap(map: CreativeTaskMap, resolution: Resolution): CompiledPlan {
  const steps: Step[] = [];
  const defaultPanel = map.target.panel;
  const camera = resolveCameraIntent(map.cameraIntent);
  const warnings = [...(camera?.warnings ?? [])];

  // ── EnsureCharacter: create only what the director said is new ──
  for (const binding of resolution.participants.values()) {
    if (binding.status !== "create") continue;
    steps.push({
      tool: "create_character",
      args: { name: binding.name, appearance: binding.attributes.join(", ") || undefined },
      reason: "Introduced by the request",
    });
    steps.push({
      tool: "generate_character_asset",
      args: { characterName: binding.name, kind: "reference" },
      reason: "Canonical identity reference",
    });
  }

  // ── EnsureScene ──
  if (map.scene && !resolution.sceneAssetId) {
    steps.push({
      tool: "generate_background",
      args: { description: map.scene.description },
      reason: "Scene the request needs",
    });
  }

  // ── EnsureObject ──
  for (const object of map.objects) {
    steps.push({
      tool: "generate_prop",
      args: { description: object.description, name: object.name },
      reason: "Object the request needs",
    });
  }

  // ── Beats: EnsureCharacterState → PlaceParticipant / ComposeInteraction / AddDialogue ──
  for (const beat of map.beats) {
    const panel = beat.panel ?? defaultPanel ?? 1;
    const binding = resolution.participants.get(beat.actor);
    const actorId = binding?.status === "existing" ? binding.characterId : undefined;

    if (beat.action || beat.poseDetails.length > 0) {
      steps.push({
        tool: "generate_character_asset",
        args: {
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          kind: "pose",
          instruction: stateInstruction(beat.action, beat.poseDetails),
        },
        reason: "The state this beat actually needs",
      });
    }

    if (beat.target && beat.interaction) {
      const interaction = resolveInteraction(beat.interaction);
      if (interaction?.warning) warnings.push(interaction.warning);
      if (interaction?.type) {
        steps.push({
          tool: "create_interaction",
          args: {
            panel,
            interaction: interaction.type,
            subjectCharacterName: beat.actor,
            targetCharacterName: beat.target,
            expressions: beat.expression ? { [beat.actor]: beat.expression } : undefined,
            // The director's exact wording reaches the render prompt; the mapped
            // type and extracted direction are supporting structure, not a
            // replacement for what was actually asked.
            parameters: { ...interaction.parameters, customInstruction: beat.interaction },
          },
          reason: "Coordinated interaction",
        });
      } else {
        /**
         * Unmapped creative interaction: never FAIL, never discard. Both
         * participants are placed and the raw intent survives as the scene
         * relationship text and the actor's generation instruction.
         */
        steps.push({
          tool: "place_character",
          args: { panel, characterName: beat.actor, pose: beat.action ?? interaction?.raw, expression: beat.expression, generateIfMissing: true },
          reason: "Put the actor in the panel",
        });
        steps.push({
          tool: "add_scene_relationship",
          args: { panel, subjectCharacterName: beat.actor, action: interaction?.raw ?? "interacts with", targetCharacterName: beat.target },
          reason: "Scene action between participants",
        });
      }
    } else {
      steps.push({
        tool: "place_character",
        args: {
          panel,
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          pose: beat.action,
          expression: beat.expression,
          generateIfMissing: true,
        },
        reason: "Put the actor in the panel",
      });
      if (beat.target) {
        steps.push({
          tool: "add_scene_relationship",
          args: { panel, subjectCharacterName: beat.actor, action: beat.action ?? "interacts with", targetCharacterName: beat.target },
          reason: "Scene action between participants",
        });
      }
    }

    if (beat.dialogue) {
      const delivery = resolveDialogueDelivery(beat.dialogueKind);
      if (delivery.warning) warnings.push(delivery.warning);
      steps.push({
        tool: "attach_bubble",
        args: {
          panel,
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          bubbleType: delivery.bubbleType,
          text: beat.dialogue,
        },
        reason: "Exact dialogue from the prompt",
      });
    }
  }

  // ── Scene placement ──
  const scenePanel = map.target.panel ?? map.beats[0]?.panel ?? 1;
  if (map.scene) {
    steps.push(
      resolution.sceneAssetId
        ? { tool: "place_asset", args: { panel: scenePanel, assetName: map.scene.reuseExisting, category: "background" }, reason: "Reuse the scene" }
        : { tool: "place_asset", args: { panel: scenePanel, assetName: map.scene.description.slice(0, 60), category: "background" }, reason: "Place the generated scene" },
    );
  }
  for (const object of map.objects) {
    steps.push({
      tool: "place_asset",
      args: { panel: scenePanel, assetName: object.name ?? object.description.slice(0, 60), category: "prop" },
      reason: "Place the object",
    });
  }

  // ── SetCameraIntent ──
  /**
   * Phase 5: ONE camera intent = ONE patch = ONE service execution. Focus and
   * perspective are part of the same intent; the focal step lands first so
   * staging and any panel redraw both see it. The Agent never decides
   * LOCAL/GENERATIVE here — `doSetCamera` hands the patch to the Panel Camera
   * application service, whose CameraResolver verdict is the only judgement.
   */
  const cameraPanel = map.target.panel ?? map.beats[0]?.panel ?? 1;
  if (map.cameraIntent?.focusSubject) {
    steps.push({
      tool: "set_focal_character",
      args: { panel: cameraPanel, characterName: map.cameraIntent.focusSubject },
      reason: "Camera focus subject",
    });
  }
  if (camera?.perspective) {
    steps.push({
      tool: "set_perspective",
      args: { panel: cameraPanel, type: camera.perspective },
      reason: "Camera perspective intent",
    });
  }
  if (camera && (camera.shot || camera.angle || camera.lens)) {
    steps.push({
      tool: "set_camera",
      args: {
        panel: cameraPanel,
        shot: camera.shot,
        angle: camera.angle,
        lens: camera.lens,
      },
      reason: "Camera intent",
    });
  }

  // ── Effects / tone / local edits ──
  for (const effect of map.effects) {
    steps.push({ tool: "add_effect", args: { panel: effect.panel ?? defaultPanel ?? 1, effectKind: effect.kind }, reason: "Manga effect" });
  }
  if (map.tone) {
    steps.push({ tool: "apply_tone", args: { panel: map.tone.panel ?? defaultPanel ?? 1, mood: map.tone.mood }, reason: "Tone" });
  }
  for (const edit of map.localEdits) {
    steps.push({
      tool: "edit_asset_region",
      args: { panel: edit.panel, characterName: edit.target, instruction: edit.instruction },
      reason: "Local edit",
    });
  }

  return { plan: { summary: map.summary, targetScope: undefined, steps }, warnings };
}

/** Names this run may create — the generation-boundary authorization. */
export function creationAuthorization(resolution: Resolution): string[] {
  return [...resolution.participants.values()]
    .filter((binding) => binding.status === "create")
    .map((binding) => binding.name.toLowerCase());
}
