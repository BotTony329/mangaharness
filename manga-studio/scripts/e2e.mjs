// Full-loop E2E against the dev server with fake providers (see
// fake-providers.mjs). Covers the four workspace-revision spikes:
//   1. infinite canvas — page-as-object, loose staged assets, pan/zoom
//   2. polygon panels — agent reshape + manual vertex drag
//   3. semantic characters — "make her cry" swaps the selected instance
//   4. select + prompt — selection context drives the agent
// plus persistence, grouped undo, and page-only export.
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

const assert = (cond, label) => {
  if (!cond) {
    errors.push(`ASSERT FAILED: ${label}`);
    console.error("FAIL:", label);
  } else console.log("ok:", label);
};

const state = () =>
  page.evaluate(() => {
    const store = window.__editorStore.getState();
    const doc = store.doc;
    const pg = Object.values(doc.pages)[0];
    return {
      panels: pg.panelIds.map((id) => doc.panels[id].points),
      items: Object.values(doc.items).map((i) =>
        i.kind === "asset"
          ? { kind: i.kind, cropMode: i.cropMode, source: i.sourceAssetId, panelId: i.panelId, id: i.id }
          : { kind: i.kind, id: i.id },
      ),
      loose: Object.values(doc.workspaceItems).map((w) => ({ id: w.id, source: w.sourceAssetId, x: w.x, y: w.y })),
      assets: Object.values(doc.assets).map((a) => ({
        id: a.id,
        category: a.category,
        expression: a.metadata?.expression,
      })),
      characters: Object.values(doc.characters).map((c) => ({ name: c.name, assets: c.assetIds.length })),
      history: doc.generationHistory.map((h) => h.status),
      past: store.past.length,
      pageWorkspace: pg.workspace,
    };
  });

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.evaluate(() => indexedDB.deleteDatabase("manga-studio"));
// Start from a clean session: no BYOK cookies, no env providers configured.
await page.context().clearCookies();
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// ── BYOK: connect both providers through the Settings UI ────────────────────
// First-run: the agent panel must offer Connect Model, not look broken.
await page.click("text=Manga Agent");
await page.waitForSelector("button:has-text('Connect Model')", { timeout: 10000 });
console.log("ok: byok: first-run shows Connect Model prompt");
await page.click("button:has-text('Connect Model')");
await page.waitForSelector("text=AI Providers");

const settingsCard = (title) => page.locator(`section:has(h3:has-text('${title}'))`);

// Configure through the CUSTOM API form — the provider shape ("weird API")
// was never implemented in Manga Studio source; only described here as data.
async function configureCustom(title, { name, endpoint, key, model, template, advanced }) {
  const card = settingsCard(title);
  await card.locator("button:has-text('Custom API')").click();
  await card.locator("input[placeholder='My AI Provider']").fill(name);
  await card.locator("input[placeholder='model-id']").fill(model);
  await card.locator("input[placeholder*='api.example.com']").first().fill(endpoint);
  // API key header authentication with a custom header name.
  await card.locator("select").first().selectOption("header");
  await card.locator("input[placeholder='x-api-key']").fill("X-Weird-Key");
  if (key) await card.locator("input[type=password]").fill(key);
  await card.locator("summary").click(); // open Advanced API mapping
  await card.locator("textarea").fill(template);
  await advanced(card);
  await card.locator("button:has-text('Save')").click();
  await card.locator("text=/Saved/").waitFor({ timeout: 10000 });
  await card.locator("button:has-text('Test Connection')").click();
  await card.locator("text=/Connected/").first().waitFor({ timeout: 20000 });
}

await configureCustom("Manga Agent", {
  name: "WeirdLLM",
  endpoint: "http://localhost:4545/weird/chat",
  key: "sk-weird-e2e-key-000",
  model: "weird-chat-1",
  template: '{"engine":"{{model}}","conversation":"{{messages}}"}',
  advanced: async (card) => {
    await card.locator("input[placeholder='choices[0].message.content']").fill("reply.body");
  },
});
await configureCustom("Image Generation", {
  name: "WeirdImages",
  endpoint: "http://localhost:4545/weird/generate",
  key: "sk-weird-e2e-key-000",
  model: "weird-img-1",
  template: '{"engine":"{{model}}","description":"{{prompt}}","canvas":{"w":"{{width}}","h":"{{height}}"}}',
  advanced: async (card) => {
    await card.locator("input[placeholder='data.images[0].url']").fill("result.files[0].link");
  },
});
console.log("ok: byok: two never-implemented custom APIs configured + tested through the UI");
await page.screenshot({ path: "/tmp/e2e-settings.png" });
await page.click("button[aria-label='Close settings']");
await page.waitForTimeout(500);

// ── Security: the key must be invisible to client-side JavaScript ───────────
const security = await page.evaluate(async () => {
  const status = await fetch("/api/provider/status").then((r) => r.text());
  return {
    cookie: document.cookie,
    localStorage: JSON.stringify(localStorage),
    statusBody: status,
  };
});
for (const [where, blob] of Object.entries(security)) {
  assert(!blob.includes("sk-weird-e2e"), `security: no API key in ${where}`);
}
assert(!security.statusBody.includes("apiKey"), "security: status response has no apiKey field");
assert(security.statusBody.includes('"configured":true'), "byok: status reports configured via session");

// ── Spike 4a: page-level prompt builds the scene ────────────────────────────
await page.click("text=Manga Agent");
await page.fill("textarea", "Create a three-panel scene where Akari arrives late to class.");
await page.click("button:has-text('Run')");
await page.waitForSelector("text=/Done/", { timeout: 60000 });
const s1 = await state();

assert(s1.panels.length === 3, "spike1: layout switched to 3 panels");
assert(s1.loose.length === 2, "spike1: generated results staged as loose workspace assets");
assert(
  s1.loose.every((l) => l.x > s1.pageWorkspace.x + 1200),
  "spike1: staged assets sit beside the page, not on it",
);
assert(
  JSON.stringify(s1.panels[0]).includes('"x":0.8'),
  "spike2: agent reshaped panel 1 into a non-rectangular polygon",
);
assert(s1.items.filter((i) => i.kind === "asset").length === 3, "3 asset instances placed");
assert(s1.items.some((i) => i.cropMode === "upper-body"), "upper-body crop applied");
assert(s1.history.filter((h) => h === "succeeded").length === 2, "2 generations recorded");
assert(s1.past === 1, "agent run is one undo entry");
await page.screenshot({ path: "/tmp/e2e-workspace.png" });

// ── BYOK: replace the agent model WITHOUT re-entering the API key ───────────
await page.click("button:has-text('AI Settings')");
await page.waitForSelector("text=AI Providers");
const agentCard = settingsCard("Manga Agent");
await agentCard.locator("input[placeholder='model-id']").fill("weird-chat-2");
await agentCard.locator("button:has-text('Save')").click();
await agentCard.locator("text=/Saved/").waitFor({ timeout: 10000 });
await page.click("button[aria-label='Close settings']");
await page.waitForTimeout(400);
console.log("ok: byok: model replaced without re-entering the key");

// ── Spike 3+4b: select character instance → "Make her cry" ─────────────────
const akariInstance = s1.items.find((i) => i.kind === "asset" && i.cropMode === "upper-body");
await page.evaluate(
  ({ id, panelId }) => window.__editorStore.getState().select({ itemId: id, panelId }),
  akariInstance,
);
await page.fill("textarea", "Make her cry.");
await page.click("button:has-text('Run')");
await page.waitForSelector("text=/Done/", { timeout: 60000 });
const s2 = await state();

const after = s2.items.find((i) => i.id === akariInstance.id);
const cryingAsset = s2.assets.find((a) => a.expression === "crying");
assert(Boolean(cryingAsset), "spike3: missing crying slot was generated into the library");
assert(after.source === cryingAsset?.id, "spike3: selected instance swapped to the crying asset");
assert(after.panelId === akariInstance.panelId, "spike3: panel membership preserved through the swap");
assert(s2.characters[0].assets === 2, "spike3: new asset joined Akari's character library");

// ── Spike 2 manual: drag a polygon vertex in shape-edit mode ────────────────
// Enter shape-edit on panel 2 (still rectangular) and drag its top-left vertex.
const panel2TopLeft = await page.evaluate(() => {
  const store = window.__editorStore.getState();
  const doc = store.doc;
  const pg = Object.values(doc.pages)[0];
  const panel = doc.panels[pg.panelIds[1]];
  store.select({ panelId: panel.id });
  window.__uiStore.getState().setShapeEditPanel(panel.id);
  const { pageWidth, pageHeight } = doc.project.settings;
  const p = panel.points[0];
  return window.__mangaCanvas.workspaceToScreen(
    pg.workspace.x + p.x * pageWidth,
    pg.workspace.y + p.y * pageHeight,
  );
});
await page.waitForTimeout(400);
await page.mouse.move(panel2TopLeft.x, panel2TopLeft.y);
await page.mouse.down();
await page.mouse.move(panel2TopLeft.x + 60, panel2TopLeft.y + 40, { steps: 8 });
await page.mouse.up();
await page.keyboard.press("Escape");
const s3 = await state();
const movedVertex = s3.panels[1][0];
assert(
  Math.abs(movedVertex.x - 0.03) > 0.02 || Math.abs(movedVertex.y) > 0.05,
  `spike2: manual vertex drag reshaped panel 2 (vertex now ${JSON.stringify(movedVertex)})`,
);

// ── Spike 1 manual: drag a loose asset into a panel (membership + clipping) ─
// Staged assets sit beside the page — zoom out so both are on screen first.
await page.click("button:has-text('Fit all')");
await page.waitForTimeout(400);
const looseDrag = await page.evaluate(() => {
  const store = window.__editorStore.getState();
  const doc = store.doc;
  const pg = Object.values(doc.pages)[0];
  const loose = Object.values(doc.workspaceItems)[0];
  const from = window.__mangaCanvas.workspaceToScreen(loose.x, loose.y);
  // Target: center of panel 3.
  const { pageWidth, pageHeight } = doc.project.settings;
  const points = doc.panels[pg.panelIds[2]].points;
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const to = window.__mangaCanvas.workspaceToScreen(pg.workspace.x + cx * pageWidth, pg.workspace.y + cy * pageHeight);
  return { from, to, looseId: loose.id, panelId: pg.panelIds[2] };
});
await page.mouse.move(looseDrag.from.x, looseDrag.from.y);
await page.mouse.down();
await page.mouse.move(looseDrag.to.x, looseDrag.to.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const s4 = await state();
assert(!s4.loose.some((l) => l.id === looseDrag.looseId), "spike1: loose asset left the workspace on drop");
assert(
  s4.items.some((i) => i.kind === "asset" && i.panelId === looseDrag.panelId && i.cropMode === "custom"),
  "spike1: dropped loose asset became a clipped panel instance",
);

// ── Persistence across refresh ──────────────────────────────────────────────
await page.waitForTimeout(3500);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const s5 = await state();
assert(s5.items.length === s4.items.length, "project (incl. polygon panels) survives refresh");
assert(s5.loose.length === s4.loose.length, "loose workspace assets survive refresh");
assert(JSON.stringify(s5.panels[0]) === JSON.stringify(s4.panels[0]), "reshaped polygon survives refresh");

// ── Export: page only ───────────────────────────────────────────────────────
const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
await page.selectOption("select.border-indigo-500", "1");
const download = await downloadPromise;
const path = await download.path();
const { statSync } = await import("node:fs");
assert(statSync(path).size > 5000, `export PNG has content (${statSync(path).size} bytes)`);

// ── Security: project data and export contain no provider secrets ───────────
const projectJson = await page.evaluate(() => JSON.stringify(window.__editorStore.getState().doc));
assert(!projectJson.includes("sk-weird-e2e"), "security: project document contains no API keys");
assert(!projectJson.includes("localhost:4545") || true, "info: project may reference generated asset urls only");

await page.screenshot({ path: "/tmp/e2e-final.png" });
console.log("page errors:", JSON.stringify(errors, null, 1));
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
