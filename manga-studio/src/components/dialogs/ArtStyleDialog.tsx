"use client";

import { useEffect, useRef, useState } from "react";
import type { StyleFamilyId, StyleProfile } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import {
  BUILTIN_STYLE_PROFILES,
  STYLE_FAMILIES,
  getActiveStyleProfile,
} from "@/styles/profiles";
import { inspectReferenceImage, REFERENCE_ACCEPT, type ReferenceImageSelection } from "@/components/library/referenceImage";
import { uploadImageFile } from "@/components/library/uploadAsset";
import { assetRenderUrl } from "@/assets/renderSource";
import { isMonochromeStyle } from "@/styles/generation";

export function ArtStyleDialog() {
  const open = useUiStore((state) => state.artStyleOpen);
  const close = useUiStore((state) => state.closeArtStyle);
  if (!open) return null;
  return <ArtStyleDialogInner onClose={close} />;
}

function ArtStyleDialogInner({ onClose }: { onClose: () => void }) {
  const doc = useEditorStore((state) => state.doc);
  const [family, setFamily] = useState<StyleFamilyId>(() => doc ? getActiveStyleProfile(doc).family : "japanese-manga");
  if (!doc) return null;
  const active = getActiveStyleProfile(doc);
  const customProfiles = Object.values(doc.project.settings.artStyle.customProfiles);
  const profiles = family === "custom"
    ? customProfiles
    : BUILTIN_STYLE_PROFILES.filter((profile) => profile.family === family);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-5" onMouseDown={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Project Art Style</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Every new character, background, prop, and Agent generation inherits this visual language.</p>
          </div>
          <div className="ml-auto rounded-full border border-violet-700/60 bg-violet-950/40 px-3 py-1 text-xs text-violet-200">
            Active · {active.name}
          </div>
          <button aria-label="Close art style" className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800" onClick={onClose}>✕</button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[230px_1fr]">
          <nav className="overflow-y-auto border-r border-zinc-800 p-3">
            <p className="mb-2 px-2 text-[10px] uppercase tracking-[0.16em] text-zinc-600">Style families</p>
            {STYLE_FAMILIES.map((item) => (
              <button
                key={item.id}
                className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left ${family === item.id ? "bg-violet-600/25 text-violet-100" : "text-zinc-400 hover:bg-zinc-800"}`}
                onClick={() => setFamily(item.id)}
              >
                <span className="block text-sm font-medium">{item.name}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">{item.description}</span>
              </button>
            ))}
          </nav>

          <main className="overflow-y-auto p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-zinc-200">{STYLE_FAMILIES.find((item) => item.id === family)?.name}</h3>
              <p className="mt-1 text-xs text-zinc-500">Selecting a style affects future generations only. Existing assets remain unchanged.</p>
            </div>

            {family === "custom" && <CustomStyleForm />}

            {profiles.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {profiles.map((profile) => (
                  <StyleCard
                    key={profile.id}
                    profile={profile}
                    active={profile.id === active.id}
                    onSelect={() => useEditorStore.getState().dispatch({ type: "set-project-style", styleId: profile.id })}
                  />
                ))}
              </div>
            ) : family === "custom" ? (
              <p className="rounded-lg border border-dashed border-zinc-700 p-6 text-center text-xs text-zinc-500">Create your first custom style above.</p>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}

function StyleCard({ profile, active, onSelect }: { profile: StyleProfile; active: boolean; onSelect: () => void }) {
  return (
    <button
      className={`overflow-hidden rounded-xl border text-left transition ${active ? "border-violet-400 ring-2 ring-violet-500/30" : "border-zinc-700 hover:border-zinc-500"}`}
      onClick={onSelect}
    >
      <StylePreview profile={profile} />
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">{profile.name}</span>
          {active && <span className="ml-auto rounded bg-violet-600/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-violet-200">Active</span>}
        </div>
        <p className="mt-1 text-[11px] leading-4 text-zinc-500">{profile.description}</p>
      </div>
    </button>
  );
}

function StylePreview({ profile, localPreview }: { profile: StyleProfile; localPreview?: string }) {
  const doc = useEditorStore((state) => state.doc);
  const referenceUrl = profile.referenceAssetId && doc ? assetRenderUrl(doc.assets[profile.referenceAssetId]) : undefined;
  const image = localPreview ?? profile.previewImage ?? referenceUrl;
  const seed = hash(profile.id);
  const monochrome = isMonochromeStyle(profile);
  const accent = hue(seed);
  return (
    <div
      className="relative h-28 overflow-hidden bg-zinc-100"
      style={image ? { backgroundImage: `url(${image})`, backgroundPosition: "center", backgroundSize: "cover" } : {
        background: monochrome
          ? "linear-gradient(145deg, #fafafa 0%, #d4d4d8 100%)"
          : `linear-gradient(145deg, hsl(${accent} 70% 88%), hsl(${(accent + 55) % 360} 55% 65%))`,
      }}
    >
      {!image && (
        <>
          <div className="absolute left-[18%] top-[18%] h-16 w-12 rounded-[48%_48%_42%_42%] border-[3px] border-zinc-800" />
          <div className="absolute left-[25%] top-[34%] h-1.5 w-1.5 rounded-full bg-zinc-800 shadow-[18px_0_0_#27272a]" />
          <div className="absolute left-[30%] top-[52%] h-[2px] w-4 rotate-3 bg-zinc-700" />
          <div className="absolute right-[12%] top-[16%] h-[3px] w-24 -rotate-12 bg-zinc-700/80 shadow-[0_12px_0_#52525b,0_24px_0_#71717a,0_36px_0_#a1a1aa]" />
          <div className="absolute bottom-2 right-3 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">{profile.visualProperties?.lineStyle ?? "visual style"}</div>
        </>
      )}
    </div>
  );
}

function CustomStyleForm() {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [reference, setReference] = useState<ReferenceImageSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (reference) URL.revokeObjectURL(reference.previewUrl);
  }, [reference]);

  const choose = async (file?: File) => {
    if (!file) return;
    try {
      const inspected = await inspectReferenceImage(file);
      const previewUrl = URL.createObjectURL(file);
      setReference((previous) => {
        if (previous) URL.revokeObjectURL(previous.previewUrl);
        return { ...inspected, previewUrl };
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Style reference could not be read");
    }
  };

  const save = async () => {
    if (!name.trim() || !description.trim()) {
      setError("Style name and description are required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const referenceAssetId = reference
        ? await uploadImageFile(reference.file, "upload", { name: `${name.trim()} style reference` })
        : undefined;
      useEditorStore.getState().dispatch({
        type: "add-custom-style",
        input: {
          name: name.trim(),
          description: description.trim(),
          positivePrompt: positive.trim() || description.trim(),
          negativePrompt: negative.trim() || undefined,
          referenceAssetId,
          visualProperties: { rendering: "custom", detailLevel: "user-defined" },
        },
      });
      setExpanded(false);
      setName("");
      setDescription("");
      setPositive("");
      setNegative("");
      setReference(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Custom style could not be saved");
    } finally {
      setBusy(false);
    }
  };

  if (!expanded) {
    return <button className="mb-4 w-full rounded-lg border border-dashed border-violet-700/70 bg-violet-950/20 py-3 text-xs text-violet-300 hover:bg-violet-950/40" onClick={() => setExpanded(true)}>+ Create Custom Style</button>;
  }

  const previewProfile: StyleProfile = {
    id: "custom-preview",
    family: "custom",
    name: name || "Custom Style",
    description: description || "Your project-specific visual direction",
    positivePrompt: positive || description,
    negativePrompt: negative || undefined,
    visualProperties: { rendering: "custom" },
  };

  return (
    <div className="mb-5 grid grid-cols-[1fr_220px] gap-4 rounded-xl border border-violet-800/60 bg-violet-950/15 p-4">
      <div className="space-y-3">
        <Field label="Style name" value={name} onChange={setName} placeholder="Simple Newspaper Cartoon" />
        <TextField label="Description" value={description} onChange={setDescription} placeholder="Minimal black-and-white comic-strip drawing using very few lines…" />
        <TextField label="Positive visual instructions (optional)" value={positive} onChange={setPositive} placeholder="Rounded simplified anatomy, restrained faces, almost no shading" />
        <TextField label="Things to avoid (optional)" value={negative} onChange={setNegative} placeholder="Detailed anime hair, cinematic shading, photorealism" />
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy} className="rounded bg-violet-600 px-4 py-1.5 text-xs text-white hover:bg-violet-500 disabled:opacity-50" onClick={() => void save()}>{busy ? "Saving…" : "Save & Use Style"}</button>
          <button disabled={busy} className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => setExpanded(false)}>Cancel</button>
        </div>
      </div>
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Style reference (optional)</p>
        <input ref={inputRef} type="file" accept={REFERENCE_ACCEPT.join(",")} className="hidden" onChange={(event) => void choose(event.target.files?.[0])} />
        <button className="w-full overflow-hidden rounded-lg border border-dashed border-zinc-600" onClick={() => inputRef.current?.click()}>
          <StylePreview profile={previewProfile} localPreview={reference?.previewUrl} />
          <span className="block py-2 text-[10px] text-zinc-500">{reference ? "Replace reference" : "Add reference image"}</span>
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="block text-xs text-zinc-400">{label}<input className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-200" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="block text-xs text-zinc-400">{label}<textarea className="mt-1 h-16 w-full resize-none rounded border border-zinc-700 bg-zinc-900 p-2 text-zinc-200" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function hue(seed: number): number {
  return seed % 360;
}
