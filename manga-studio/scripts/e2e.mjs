// Full-loop E2E against the dev server with fake providers (see
// fake-providers.mjs): agent prompt → plan → generation → composition →
// persistence (refresh) → export. Verifies the acceptance scenario without
// real API credentials.
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

const state = () =>
  page.evaluate(() => {
    const store = window.__editorStore.getState();
    const doc = store.doc;
    return {
      pages: Object.keys(doc.pages).length,
      panels: Object.values(doc.pages)[0].panelIds.length,
      items: Object.values(doc.items).map((i) => i.kind),
      assets: Object.values(doc.assets).map((a) => ({ category: a.category, url: a.storageUrl })),
      characters: Object.values(doc.characters).map((c) => ({ name: c.name, assets: c.assetIds.length })),
      history: doc.generationHistory.map((h) => h.status),
      past: store.past.length,
      cropModes: Object.values(doc.items)
        .filter((i) => i.kind === "asset")
        .map((i) => i.cropMode),
    };
  });

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Fresh project for a deterministic run.
await page.evaluate(async () => {
  indexedDB.deleteDatabase("manga-studio");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// ── 1. Run the Manga Agent ──────────────────────────────────────────────────
await page.click("text=Manga Agent");
await page.fill("textarea", "Create a three-panel scene where Akari arrives late to class.");
await page.click("button:has-text('Run')");
await page.waitForSelector("text=/Done/", { timeout: 60000 });
const afterAgent = await state();
console.log("after agent:", JSON.stringify(afterAgent, null, 1));

const assert = (cond, label) => {
  if (!cond) {
    errors.push(`ASSERT FAILED: ${label}`);
    console.error("FAIL:", label);
  } else console.log("ok:", label);
};

assert(afterAgent.panels === 3, "layout switched to 3 panels");
assert(afterAgent.characters.some((c) => c.name === "Akari" && c.assets >= 1), "Akari created with generated asset");
assert(afterAgent.assets.some((a) => a.category === "background"), "background generated into library");
assert(afterAgent.items.filter((k) => k === "asset").length === 3, "3 asset instances placed");
assert(afterAgent.items.includes("bubble"), "speech bubble added");
assert(afterAgent.items.includes("effect"), "effect added");
assert(afterAgent.cropModes.includes("upper-body"), "upper-body crop applied");
assert(afterAgent.history.filter((s) => s === "succeeded").length === 2, "2 generations recorded");
assert(afterAgent.past === 1, "agent run is one undo entry");
await page.screenshot({ path: "/tmp/e2e-after-agent.png" });

// ── 2. Undo/redo round-trip ─────────────────────────────────────────────────
await page.keyboard.press("Control+z");
const afterUndo = await state();
assert(afterUndo.items.length === 0 && afterUndo.panels === 4, "one undo reverts the whole agent run");
await page.keyboard.press("Control+Shift+z");
const afterRedo = await state();
assert(afterRedo.items.length === afterAgent.items.length, "redo restores the run");

// ── 3. Persistence across refresh ───────────────────────────────────────────
await page.waitForTimeout(3500); // allow autosave debounce
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const afterReload = await state();
assert(afterReload.items.length === afterAgent.items.length, "project survives refresh");
assert(afterReload.assets.length === afterAgent.assets.length, "generated assets survive refresh");

// ── 4. Export PNG ───────────────────────────────────────────────────────────
const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
await page.selectOption("select.border-indigo-500", "1");
const download = await downloadPromise;
const path = await download.path();
const { statSync } = await import("node:fs");
assert(statSync(path).size > 5000, `export PNG has content (${statSync(path).size} bytes)`);
console.log("export saved:", download.suggestedFilename());

await page.screenshot({ path: "/tmp/e2e-final.png" });
console.log("page errors:", JSON.stringify(errors, null, 1));
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
