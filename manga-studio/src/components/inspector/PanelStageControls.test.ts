// @vitest-environment jsdom
/**
 * Phase 4.1 — REAL BUTTON CONTRACT.
 *
 * Renders the actual PanelStageControls against the real editor store (only
 * the provider seam is mocked) and drives it exactly like a creator does:
 * pick a camera control, SEE the Generate button, click it. Proves the live
 * wiring ends in exactly ONE generateImage call and a panel swap — not a
 * silent staging-only preview.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { createInteraction } from "@/domain/interactions";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

const generateImage = vi.fn();
const registerGeneratedAsset = vi.fn();

vi.mock("@/services/generation", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  registerGeneratedAsset: (...args: unknown[]) => registerGeneratedAsset(...args),
  imageProviderCapabilities: async () => ({ referenceImage: true, nativeTransparency: false }),
}));

import { PanelStageControls } from "./PanelStageControls";

function loadDoc(doc: ProjectDocument) {
  useEditorStore.setState({ doc, selection: {} } as never);
}

function place(panelId: string, assetId: string): string {
  return useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId }).createdId!;
}

function characterStudio() {
  let doc: ProjectDocument = createProjectDocument("UI");
  const mika = addCharacter(doc, "Mika");
  doc = mika.doc;
  const ref = addAsset(doc, {
    category: "character",
    name: "Mika reference",
    storageUrl: "https://example.com/mika.png",
    width: 800,
    height: 1600,
    metadata: { characterId: mika.characterId, characterAssetRole: "canonical" },
  });
  doc = ref.doc;
  const panelId = Object.keys(doc.panels)[0];
  loadDoc(doc);
  const instanceId = place(panelId, ref.assetId);
  return { panelId, instanceId, mikaId: mika.characterId, refId: ref.assetId };
}

beforeEach(() => {
  generateImage.mockReset();
  registerGeneratedAsset.mockReset();
  generateImage.mockResolvedValue({ url: "https://example.com/out.png" });
  registerGeneratedAsset.mockImplementation(async (input: { category: "character" | "background"; name: string; metadata?: object }) => {
    const current = useEditorStore.getState().doc!;
    const added = addAsset(current, {
      category: input.category,
      name: input.name,
      storageUrl: `https://example.com/gen-${Math.random()}.png`,
      width: 800,
      height: 1600,
      metadata: input.metadata,
    });
    useEditorStore.setState({ doc: added.doc } as never);
    return added.assetId;
  });
});

const generateButton = () => screen.queryByRole("button", { name: /Generate Camera View/ });

describe("REAL BUTTON CONTRACT — character", () => {
  it("Angle eye-level → high shows the button; clicking it generates exactly once and swaps the instance", async () => {
    const s = characterStudio();
    render(React.createElement(PanelStageControls, { panelId: s.panelId }));

    // Neutral camera: no redraw needed, no button.
    expect(generateButton()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^High$/ }));
    await waitFor(() => expect(generateButton()).toBeTruthy());

    fireEvent.click(generateButton()!);
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const after = useEditorStore.getState().doc!;
    const swapped = after.items[s.instanceId];
    expect(swapped.kind === "asset" && swapped.sourceAssetId).not.toBe(s.refId);
  });
});

describe("REAL BUTTON CONTRACT — scene", () => {
  it("Angle → low on a panel whose only target is a scene generates ONE background redraw", async () => {
    let doc: ProjectDocument = createProjectDocument("UIScene");
    const street = addAsset(doc, {
      category: "background",
      name: "Tokyo Street",
      storageUrl: "https://example.com/street.png",
      width: 1600,
      height: 900,
    });
    doc = street.doc;
    const panelId = Object.keys(doc.panels)[0];
    loadDoc(doc);
    place(panelId, street.assetId);

    render(React.createElement(PanelStageControls, { panelId }));
    fireEvent.click(screen.getByRole("button", { name: /^Low$/ }));
    await waitFor(() => expect(generateButton()).toBeTruthy());

    fireEvent.click(generateButton()!);
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].assetType).toBe("background");
    expect(generateImage.mock.calls[0][0].referenceUrls).toEqual(["https://example.com/street.png"]);
  });
});

describe("REAL BUTTON CONTRACT — interaction", () => {
  it("Angle → overhead on a panel with a composite interaction generates ONE joint shot", async () => {
    let doc: ProjectDocument = createProjectDocument("UIInteraction");
    const mika = addCharacter(doc, "Mika");
    doc = mika.doc;
    const ren = addCharacter(doc, "Ren");
    doc = ren.doc;
    for (const [name, characterId] of [["mika", mika.characterId], ["ren", ren.characterId]] as const) {
      const ref = addAsset(doc, {
        category: "character",
        name: `${name} reference`,
        storageUrl: `https://example.com/${name}.png`,
        width: 800,
        height: 1600,
        metadata: { characterId, characterAssetRole: "canonical" },
      });
      doc = ref.doc;
    }
    const panelId = Object.keys(doc.panels)[0];
    const created = createInteraction(doc, {
      panelId,
      participantIds: [mika.characterId, ren.characterId],
      type: "hug",
      source: "manual",
      renderMode: "composite",
    });
    loadDoc(created.doc);

    render(React.createElement(PanelStageControls, { panelId }));
    // Overhead is not a preset angle button; use the High button then verify
    // through the joint route — one call, both references, camera in the prompt.
    fireEvent.click(screen.getByRole("button", { name: /^High$/ }));
    await waitFor(() => expect(generateButton()).toBeTruthy());

    fireEvent.click(generateButton()!);
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    const request = generateImage.mock.calls[0][0];
    expect(request.referenceUrls).toEqual(["https://example.com/mika.png", "https://example.com/ren.png"]);
    expect(request.prompt).toContain("High camera angle looking down at the subject.");
    expect(request.prompt).toContain("Hug: Mika and Ren.");
  });
});

describe("REAL BUTTON CONTRACT — the Phase 4.1 visibility gap", () => {
  it("shot WIDENING (full → wide) shows the button even though angle stays eye-level", async () => {
    const s = characterStudio();
    render(React.createElement(PanelStageControls, { panelId: s.panelId }));

    fireEvent.click(screen.getByRole("button", { name: /^Wide$/ }));
    await waitFor(() => expect(generateButton()).toBeTruthy());

    fireEvent.click(generateButton()!);
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
  });
});
