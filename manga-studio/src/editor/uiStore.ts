"use client";

/**
 * Transient UI state that isn't part of the document (dialog visibility,
 * generator prefill). Kept out of the editor store so undo never replays UI.
 */

import { create } from "zustand";
import type { ID, MangaLanguageCategory } from "@/domain/types";
import type { PoseCalibration, PoseRigState } from "@/characters/poseRig";
import type { PuppetJoint } from "@/puppet/model";

export interface GeneratorRequest {
  assetType: "character" | "character-pose" | "character-expression" | "background" | "prop" | "manga-effect";
  characterId?: ID;
  /**
   * Manga Language Library category for a "manga-effect" generation. Accepting
   * it beside the result keeps the review flow honest: the preview knows which
   * shelf the asset will land on before the creator presses Add to Library.
   */
  languageCategory?: MangaLanguageCategory;
  /** Prefilled slot descriptor, e.g. { pose: "running" }. */
  prefill?: Record<string, string>;
  /**
   * When set, the accepted result also replaces this instance's source asset
   * ("Expression: Crying → not available → Generate" flows end by swapping
   * the selected instance).
   */
  targetInstanceId?: ID;
  /** Regeneration replaces every reference to the old source after acceptance. */
  replaceAssetId?: ID;
}

/**
 * A local puppet edit the creator asked for that the puppet cannot hold (§3).
 *
 * Surfaced as an explicit choice rather than silently distorting the artwork or
 * silently escalating to a paid generation: local-safe operations are instant,
 * and anything generative has to be chosen.
 */
export interface PuppetCapabilityPrompt {
  instanceId: ID;
  joint?: PuppetJoint;
  /** What the creator asked for, before the puppet refused it. */
  requestedDegrees?: number;
  reason: string;
  fallbackRecommendation?: string;
}

/** Live hover feedback while dragging an expression over the canvas (§1). */
export interface PuppetFaceHover {
  instanceId: ID;
  expressionId: string;
}

interface UiState {
  generator: GeneratorRequest | null;
  /** Panel currently in shape-edit mode (double-click a panel to enter). */
  shapeEditPanelId: ID | null;
  /**
   * Character instance currently in pose-edit mode, plus the draft rig.
   * The draft is editor state on purpose: dragging joints must not create undo
   * entries or touch the document until Apply (§5/§13).
   */
  poseEditInstanceId: ID | null;
  poseDraft: PoseRigState | null;
  /** Calibration mode reuses the same overlay but drags baseline anchors (§3). */
  calibrating: boolean;
  calibrationDraft: PoseCalibration | null;
  /** Panel whose perspective handles are draggable (§4 "Edit Guides"). */
  guideEditPanelId: ID | null;
  /**
   * Puppet direct manipulation. All three are editor-only: dragging a joint
   * writes to the document through transient dispatch, but the hover highlight
   * and the capability prompt never do.
   */
  puppetFaceHover: PuppetFaceHover | null;
  puppetCapabilityPrompt: PuppetCapabilityPrompt | null;
  /** Instance whose joint handles are shown; null hides them. */
  puppetHandlesInstanceId: ID | null;
  /** Compiler wizard target character, or null when closed. */
  compilerCharacterId: ID | null;
  /** AI Settings can be opened from anywhere ("Connect model" prompts). */
  settingsOpen: boolean;
  artStyleOpen: boolean;
  openGenerator(request: GeneratorRequest): void;
  closeGenerator(): void;
  setShapeEditPanel(panelId: ID | null): void;
  beginPoseEdit(instanceId: ID, rig: PoseRigState): void;
  setPoseDraft(rig: PoseRigState): void;
  endPoseEdit(): void;
  setGuideEditPanel(panelId: ID | null): void;
  beginCalibration(instanceId: ID, calibration: PoseCalibration): void;
  setCalibrationDraft(calibration: PoseCalibration): void;
  endCalibration(): void;
  setPuppetFaceHover(hover: PuppetFaceHover | null): void;
  showPuppetCapabilityPrompt(prompt: PuppetCapabilityPrompt | null): void;
  setPuppetHandlesInstance(instanceId: ID | null): void;
  openCompiler(characterId: ID): void;
  closeCompiler(): void;
  openSettings(): void;
  closeSettings(): void;
  openArtStyle(): void;
  closeArtStyle(): void;
}

export const useUiStore = create<UiState>((set) => ({
  generator: null,
  shapeEditPanelId: null,
  poseEditInstanceId: null,
  poseDraft: null,
  calibrating: false,
  calibrationDraft: null,
  guideEditPanelId: null,
  puppetFaceHover: null,
  puppetCapabilityPrompt: null,
  puppetHandlesInstanceId: null,
  compilerCharacterId: null,
  settingsOpen: false,
  artStyleOpen: false,
  openGenerator: (request) => set({ generator: request }),
  closeGenerator: () => set({ generator: null }),
  setShapeEditPanel: (panelId) => set({ shapeEditPanelId: panelId }),
  beginPoseEdit: (instanceId, rig) => set({ poseEditInstanceId: instanceId, poseDraft: rig }),
  setPoseDraft: (rig) => set({ poseDraft: rig }),
  endPoseEdit: () => set({ poseEditInstanceId: null, poseDraft: null, calibrating: false, calibrationDraft: null }),
  setGuideEditPanel: (panelId) => set({ guideEditPanelId: panelId }),
  beginCalibration: (instanceId, calibration) =>
    set({ poseEditInstanceId: instanceId, calibrating: true, calibrationDraft: calibration, poseDraft: null }),
  setCalibrationDraft: (calibration) => set({ calibrationDraft: calibration }),
  endCalibration: () => set({ calibrating: false, calibrationDraft: null, poseEditInstanceId: null }),
  setPuppetFaceHover: (hover) => set({ puppetFaceHover: hover }),
  showPuppetCapabilityPrompt: (prompt) => set({ puppetCapabilityPrompt: prompt }),
  setPuppetHandlesInstance: (instanceId) => set({ puppetHandlesInstanceId: instanceId }),
  openCompiler: (characterId) => set({ compilerCharacterId: characterId }),
  closeCompiler: () => set({ compilerCharacterId: null }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openArtStyle: () => set({ artStyleOpen: true }),
  closeArtStyle: () => set({ artStyleOpen: false }),
}));
