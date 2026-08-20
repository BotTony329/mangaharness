/**
 * Limited safe property-path mapper for Custom API response mapping:
 * `data.images[0].url`, `result[2]`, `image_base64`. Traversal only —
 * no expressions, no wildcards, no code.
 */

const PATH_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*(\[\d+\])*(\.[A-Za-z_$][A-Za-z0-9_$]*(\[\d+\])*)*$/;
const TOKENIZER = /([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]/g;

export function isValidPath(path: string): boolean {
  return path.length > 0 && path.length <= 300 && PATH_SHAPE.test(path);
}

export function getAtPath(root: unknown, path: string): unknown {
  if (!isValidPath(path)) return undefined;
  let current: unknown = root;
  for (const match of path.matchAll(TOKENIZER)) {
    if (current === null || current === undefined) return undefined;
    const key = match[1] ?? Number(match[2]);
    if (typeof key === "number") {
      current = Array.isArray(current) ? current[key] : undefined;
    } else {
      current = typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    }
  }
  return current;
}
