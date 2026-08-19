"use client";

/**
 * Image loading for canvas rendering. Every image is requested with
 * crossOrigin=anonymous so remotely stored (Vercel Blob) assets don't taint
 * the canvas — without this, page export would fail only in production.
 * A module-level cache keeps one HTMLImageElement per URL.
 */

import { useEffect, useState } from "react";

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

export function loadImageElement(url: string): Promise<HTMLImageElement> {
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      cache.set(url, img);
      pending.delete(url);
      resolve(img);
    };
    img.onerror = () => {
      pending.delete(url);
      reject(new Error(`Failed to load image: ${url}`));
    };
    img.src = url;
  });
  pending.set(url, promise);
  return promise;
}

export function useImageElement(url: string | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(url ? (cache.get(url) ?? null) : null);

  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    let cancelled = false;
    loadImageElement(url)
      .then((img) => {
        if (!cancelled) setImage(img);
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return image;
}
