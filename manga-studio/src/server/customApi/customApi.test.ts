import { describe, expect, it } from "vitest";
import { getAtPath, isValidPath } from "./jsonPath";
import { collectVariables, parseTemplate, renderTemplate, TemplateError } from "./template";

describe("template engine (no eval, typed injection)", () => {
  it("interpolates inline variables as text", () => {
    const template = parseTemplate('{"prompt":"draw {{prompt}} at {{width}}px"}', ["prompt", "width"]);
    expect(renderTemplate(template, { prompt: "a girl", width: 832 })).toEqual({
      prompt: "draw a girl at 832px",
    });
  });

  it("injects exact-match placeholders with their structured type", () => {
    const template = parseTemplate(
      '{"model":"{{model}}","width":"{{width}}","messages":"{{messages}}","refs":"{{referenceImages}}"}',
      ["model", "width", "messages", "referenceImages"],
    );
    const rendered = renderTemplate(template, {
      model: "m1",
      width: 832,
      messages: [{ role: "user", content: "hi" }],
      referenceImages: ["https://a/1.png", "https://a/2.png"],
    }) as Record<string, unknown>;
    expect(rendered.width).toBe(832); // number, not "832"
    expect(rendered.messages).toEqual([{ role: "user", content: "hi" }]); // structure, not escaped string
    expect(rendered.refs).toEqual(["https://a/1.png", "https://a/2.png"]);
  });

  it("rejects unknown variables at parse time (typo protection)", () => {
    expect(() => parseTemplate('{"p":"{{promt}}"}', ["prompt"])).toThrow(TemplateError);
    expect(() => parseTemplate("not json {{", ["prompt"])).toThrow(/not valid JSON/);
  });

  it("does not evaluate anything that isn't a plain variable", () => {
    // Expression-like content is not a valid {{variable}} → left untouched, never executed.
    const template = parseTemplate('{"x":"1+1 = ${2} `rm -rf` obj.toString()"}', []);
    expect(renderTemplate(template, {})).toEqual({ x: "1+1 = ${2} `rm -rf` obj.toString()" });
    expect(collectVariables({ a: "{{process}} {{env}}" })).toEqual(["process", "env"]);
  });

  it("renders nested arrays/objects", () => {
    const template = parseTemplate('{"input":{"images":["{{referenceImage}}"],"n":1}}', ["referenceImage"]);
    expect(renderTemplate(template, { referenceImage: "b64data" })).toEqual({
      input: { images: ["b64data"], n: 1 },
    });
  });
});

describe("json path mapper (traversal only)", () => {
  const body = {
    data: { images: [{ url: "https://cdn/x.png" }, { url: "https://cdn/y.png" }] },
    image_base64: "abc123",
    output: ["first", { image_url: "https://cdn/z.png" }],
  };

  it("resolves dotted and indexed paths", () => {
    expect(getAtPath(body, "data.images[0].url")).toBe("https://cdn/x.png");
    expect(getAtPath(body, "data.images[1].url")).toBe("https://cdn/y.png");
    expect(getAtPath(body, "image_base64")).toBe("abc123");
    expect(getAtPath(body, "output[1].image_url")).toBe("https://cdn/z.png");
  });

  it("returns undefined for missing paths instead of throwing", () => {
    expect(getAtPath(body, "data.nope[3].url")).toBeUndefined();
    expect(getAtPath(null, "a.b")).toBeUndefined();
  });

  it("rejects anything that isn't a plain property path", () => {
    expect(isValidPath("data.images[0].url")).toBe(true);
    expect(isValidPath("__proto__.polluted")).toBe(true); // read-only traversal — harmless
    expect(isValidPath("a[*].b")).toBe(false);
    expect(isValidPath("a.b(); rm -rf /")).toBe(false);
    expect(isValidPath("a..b")).toBe(false);
    expect(isValidPath("")).toBe(false);
  });
});
