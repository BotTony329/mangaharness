/**
 * The Kumanga mark, inline.
 *
 * Inline rather than an <img> so it inherits `currentColor`: the same component
 * is the black mark on a light tile and the white mark on the dark toolbar,
 * with no second file to keep in step. The static SVGs in `public/brand` exist
 * for surfaces that cannot inline — favicon, manifest, README.
 *
 * `compact` drops the speech bubble. Below roughly 20px the bubble's ring is a
 * fraction of a pixel and turns to mud; the bear silhouette is the part that
 * still identifies Kumanga at that size.
 *
 * Generated geometry — edit `scripts/build-brand.mjs` and re-run it, not this.
 */

import { useId } from "react";

const HEAD =
  "M 25 14 C 40.12 14 46 22.96 46 33.5 C 46 44.04 40.12 53 25 53 C 9.88 53 4 44.04 4 33.5 C 4 22.96 9.88 14 25 14 Z";
const HEAD_COMPACT =
  "M 32 11.5 C 49.28 11.5 56 21.8 56 34 C 56 46.2 49.28 56.5 32 56.5 C 14.72 56.5 8 46.2 8 34 C 8 21.8 14.72 11.5 32 11.5 Z";
const BUBBLE =
  "M 43 32.5 H 55 A 5 5 0 0 1 60 37.5 V 45.5 A 5 5 0 0 1 55 50.5 H 43 A 5 5 0 0 1 38 45.5 V 37.5 A 5 5 0 0 1 43 32.5 Z";
const TAIL = "M 42.6 47 L 38.4 57.4 L 49.4 50.4 Z";
const BUBBLE_HOLE =
  "M 44.2 36.4 H 53.8 A 2.6 2.6 0 0 1 56.4 39 V 44 A 2.6 2.6 0 0 1 53.8 46.6 H 44.2 A 2.6 2.6 0 0 1 41.6 44 V 39 A 2.6 2.6 0 0 1 44.2 36.4 Z";

export interface KumangaMarkProps {
  size?: number;
  compact?: boolean;
  className?: string;
  /** Set when the mark sits beside the word "Kumanga" and would repeat it. */
  decorative?: boolean;
}

export function KumangaMark({ size = 24, compact = false, className, decorative }: KumangaMarkProps) {
  const id = useId();
  const useCompact = compact || size < 20;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "Kumanga"}
    >
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        {useCompact ? (
          <>
            <path d={HEAD_COMPACT} fill="#fff" />
            <circle cx="14" cy="14.5" r="10" fill="#fff" />
            <circle cx="50" cy="14.5" r="10" fill="#fff" />
            <ellipse cx="22" cy="29.5" rx="3.7" ry="4.9" fill="#000" />
            <ellipse cx="42" cy="29.5" rx="3.7" ry="4.9" fill="#000" />
            <ellipse cx="32" cy="43" rx="11" ry="7.8" fill="#000" />
            <ellipse cx="32" cy="40" rx="4" ry="3" fill="#fff" />
          </>
        ) : (
          <>
            <path d={HEAD} fill="#fff" />
            <circle cx="12.2" cy="15.4" r="8.7" fill="#fff" />
            <circle cx="37.8" cy="15.4" r="8.7" fill="#fff" />
            <ellipse cx="17.6" cy="29.5" rx="3.1" ry="4.1" fill="#000" />
            <ellipse cx="32.4" cy="29.5" rx="3.1" ry="4.1" fill="#000" />
            <ellipse cx="25" cy="41.5" rx="9.4" ry="6.6" fill="#000" />
            <ellipse cx="25" cy="38.9" rx="3.3" ry="2.5" fill="#fff" />
            <g fill="#000" stroke="#000" strokeWidth="5.4" strokeLinejoin="round">
              <path d={BUBBLE} />
              <path d={TAIL} />
            </g>
            <path d={BUBBLE} fill="#fff" />
            <path d={TAIL} fill="#fff" />
            <path d={BUBBLE_HOLE} fill="#000" />
          </>
        )}
      </mask>
      <rect width="64" height="64" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

/** Mark + name, for the toolbar and the welcome screen. */
export function KumangaLockup({ size = 20, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <KumangaMark size={size} decorative />
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Kumanga
        </span>
        {tagline && (
          <span className="mt-1 text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--text-muted)" }}>
            AI Manga Studio
          </span>
        )}
      </span>
    </span>
  );
}
