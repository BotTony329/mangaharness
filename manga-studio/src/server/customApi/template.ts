/**
 * Safe request-template rendering for user-defined Custom APIs.
 *
 * Users describe an arbitrary provider's request body as JSON containing
 * {{variable}} placeholders. Substitution rules:
 *
 *   - a string value that is EXACTLY "{{name}}" is replaced by the variable's
 *     structured value (numbers stay numbers, arrays stay arrays — this is
 *     how {{messages}} or {{referenceImages}} inject as JSON, never as
 *     escaped strings);
 *   - a string containing {{name}} inline is interpolated as text;
 *   - unknown variable names are an error (typo protection), and there is no
 *     expression evaluation of any kind — replacement only.
 */

const VAR_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export class TemplateError extends Error {}

/** Parse + validate a template: legal JSON, only allowed variable names. */
export function parseTemplate(templateText: string, allowedVars: readonly string[]): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(templateText);
  } catch {
    throw new TemplateError("Request template is not valid JSON");
  }
  const unknown = collectVariables(parsed).filter((name) => !allowedVars.includes(name));
  if (unknown.length > 0) {
    throw new TemplateError(`Unknown template variable(s): ${unknown.join(", ")} — allowed: ${allowedVars.join(", ")}`);
  }
  return parsed;
}

export function collectVariables(node: unknown): string[] {
  const found = new Set<string>();
  walkStrings(node, (text) => {
    for (const match of text.matchAll(VAR_PATTERN)) found.add(match[1]);
  });
  return [...found];
}

export function renderTemplate(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === "string") return renderString(template, vars);
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, vars));
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, vars);
    return out;
  }
  return template;
}

function renderString(text: string, vars: Record<string, unknown>): unknown {
  const exact = text.match(/^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/);
  if (exact) {
    // Structured injection: the value keeps its JSON type.
    return requireVar(vars, exact[1]);
  }
  return text.replace(VAR_PATTERN, (_match, name: string) => stringify(requireVar(vars, name)));
}

function requireVar(vars: Record<string, unknown>, name: string): unknown {
  if (!(name in vars)) throw new TemplateError(`Template variable {{${name}}} is not available for this request`);
  return vars[name];
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function walkStrings(node: unknown, visit: (text: string) => void): void {
  if (typeof node === "string") visit(node);
  else if (Array.isArray(node)) node.forEach((item) => walkStrings(item, visit));
  else if (node !== null && typeof node === "object") {
    Object.values(node).forEach((value) => walkStrings(value, visit));
  }
}
