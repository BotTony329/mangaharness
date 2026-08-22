"use client";

/**
 * LocalEditService — the single application-facing entry for local generative
 * edits. The Asset Detail Editor UI and the Manga Agent both call THIS module;
 * neither hand-rolls `/api/assets/edit` nor the variation-saving dispatch.
 *
 * The route enforces locality (pixels outside the mask come byte-for-byte from
 * the original); this module owns the client contract and the product rule
 * that an edit always lands as a NEW asset — the original is never touched.
 */

import type { CommandResult, DomainCommand } from "@/domain/commands";
import type { NewAssetInput } from "@/domain/libraryOps";
import type { ID, SourceAsset } from "@/domain/types";

export interface EditAssetRegionInput {
  sourceUrl: string;
  /** PNG mask at the asset's own pixel dimensions; white = editable. */
  maskPng: string;
  instruction: string;
  feather?: number;
  referenceUrls?: string[];
  /** Cut-out assets keep transparency; scenes stay rectangular. */
  preserveAlpha?: boolean;
}

export interface EditAssetRegionResult {
  url: string;
  editedPixels: number;
  preservedPixels: number;
}

export async function editAssetRegion(input: EditAssetRegionInput): Promise<EditAssetRegionResult> {
  const response = await fetch("/api/assets/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceUrl: input.sourceUrl,
      maskPng: input.maskPng,
      instruction: input.instruction,
      feather: input.feather,
      referenceUrls: input.referenceUrls,
      preserveAlpha: input.preserveAlpha,
    }),
  });
  const body = (await response.json()) as EditAssetRegionResult & { error?: string };
  if (!response.ok || !body.url) throw new Error(body.error ?? "Local edit failed");
  return body;
}

/**
 * Register an edit result as a NEW library asset with local-edit provenance.
 * A pixel repair is not a semantic state change (§22): intent is "cosmetic".
 */
export function saveEditedVariation(
  dispatch: (command: DomainCommand) => CommandResult,
  asset: SourceAsset,
  resultUrl: string,
  prompt: string,
): ID | undefined {
  const input: NewAssetInput = {
      category: asset.category,
      name: `${asset.name} · ${prompt.trim().slice(0, 24) || "edit"}`,
      storageUrl: resultUrl,
      processedImageUrl: resultUrl,
      width: asset.width,
      height: asset.height,
      hasAlpha: asset.hasAlpha,
      backgroundRemoved: asset.backgroundRemoved,
      processingStatus: "ready",
      metadata: asset.metadata,
      provenance: {
        ...asset.provenance,
        generatedFromAssetIds: [asset.id],
        localEdit: {
          parentAssetId: asset.id,
          editPrompt: prompt.trim(),
          intent: "cosmetic",
          editedAt: new Date().toISOString(),
        },
      },
  };
  const created = dispatch({ type: "create-asset", input });
  return created.createdId;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Dependency-free full-canvas white mask ("everything editable") as a PNG
 * data URL. Works in browser and Node — the agent path has no painted mask,
 * so locality is enforced by the instruction rather than by a region.
 */
export async function fullCanvasMaskPng(width: number, height: number): Promise<string> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter: none
    raw.fill(255, row + 1, row + 1 + w * 4);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, w);
  ihdrView.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const png = new Uint8Array(8 + (12 + 13) + (12 + compressed.length) + 12);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let offset = 8;
  for (const part of [chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]) {
    png.set(part, offset);
    offset += part.length;
  }
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
