"use client";

/**
 * Transient UI state that isn't part of the document (dialog visibility,
 * generator prefill). Kept out of the editor store so undo never replays UI.
 */

import { create } from "zustand";
import type { ID } from "@/domain/types";

export interface GeneratorRequest {
  assetType: "character" | "character-pose" | "character-expression" | "background" | "prop";
  characterId?: ID;
  /** Prefilled slot descriptor, e.g. { pose: "running" }. */
  prefill?: Record<string, string>;
  /**
   * When set, the accepted result also replaces this instance's source asset
   * ("Expression: Crying → not available → Generate" flows end by swapping
   * the selected instance).
   */
  targetInstanceId?: ID;
}

interface UiState {
  generator: GeneratorRequest | null;
  /** Panel currently in shape-edit mode (double-click a panel to enter). */
  shapeEditPanelId: ID | null;
  /** AI Settings can be opened from anywhere ("Connect model" prompts). */
  settingsOpen: boolean;
  artStyleOpen: boolean;
  openGenerator(request: GeneratorRequest): void;
  closeGenerator(): void;
  setShapeEditPanel(panelId: ID | null): void;
  openSettings(): void;
  closeSettings(): void;
  openArtStyle(): void;
  closeArtStyle(): void;
}

export const useUiStore = create<UiState>((set) => ({
  generator: null,
  shapeEditPanelId: null,
  settingsOpen: false,
  artStyleOpen: false,
  openGenerator: (request) => set({ generator: request }),
  closeGenerator: () => set({ generator: null }),
  setShapeEditPanel: (panelId) => set({ shapeEditPanelId: panelId }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openArtStyle: () => set({ artStyleOpen: true }),
  closeArtStyle: () => set({ artStyleOpen: false }),
}));
