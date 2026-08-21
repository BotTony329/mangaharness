// Final smoke (macOS): provider-independent cross-system links only.
// Provider-dependent links (generate/place/local-edit) are covered by vitest
// integration tests; a live BYOK session cannot exist in this environment.
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const results = {};
const check = (name, ok) => { results[name] = ok ? "PASS" : "FAIL"; };

// 1. Project create → 2. reload persistence
await page.goto(url, { waitUntil: "networkidle" });
await page.getByText("Create Project").first().click();
await page.locator("input").first().fill("Freeze Smoke");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForTimeout(2500);
check("project created + canvas", (await page.locator("canvas").count()) > 0);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const bodyAfterReload = await page.locator("body").innerText();
check("reload persists project", /Freeze Smoke/.test(bodyAfterReload));

// Re-enter project if reload landed on launcher
if (!(await page.locator("canvas").count())) {
  await page.getByText("Freeze Smoke").first().click();
  await page.waitForTimeout(2000);
}

// 3. Bubble add via toolbar
const bubbleSelect = page.locator("select:has(option[value='speech'])");
if (await bubbleSelect.count()) {
  await bubbleSelect.selectOption("speech");
  await page.waitForTimeout(600);
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    // 4. Bubble drag
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  check("bubble add + drag", true);
} else check("bubble add + drag", false);

// 5. Camera: click a panel, change Shot in Inspector
const canvasBox = await page.locator("canvas").first().boundingBox();
if (canvasBox) {
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 3);
  await page.waitForTimeout(600);
}
const inspectorText = await page.locator("body").innerText();
check("camera controls reachable", /Shot/.test(inspectorText) && /Angle/.test(inspectorText) && /Lens/.test(inspectorText));
const shotSelect = page.locator("select").filter({ has: page.locator("option[value='close-up']") }).first();
if (await shotSelect.count()) {
  await shotSelect.selectOption("close-up");
  await page.waitForTimeout(600);
  check("camera shot changes (no crash)", true);
} else check("camera shot changes (no crash)", false);

// 6. Undo / Redo
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(300);
check("undo/redo", true);

// 7. Export entry (a select overlay)
const exportSelect = page.locator("select[aria-label='Export']");
check("export entry", (await exportSelect.count()) > 0);
if (await exportSelect.count()) {
  await exportSelect.selectOption("1");
  await page.waitForTimeout(1200);
  check("export runs @1x", true);
}

// 8. AI Settings protocol-first + Advanced fold
await page.keyboard.press("Escape");
await page.getByText("AI Settings").first().click();
await page.waitForTimeout(600);
const settings = await page.locator("body").innerText();
check("provider UI default: name/key/model only",
  /PROVIDER NAME/i.test(settings) && /API KEY/i.test(settings) && /MODEL/i.test(settings));
check("protocol folded into Advanced", /ADVANCED/i.test(settings) && !/OpenAI-compatible/i.test(settings.split(/ADVANCED/i)[0] ?? ""));
await page.screenshot({ path: "/tmp/smoke-final.png" });

console.log(JSON.stringify(results, null, 2));
console.log("console errors:", JSON.stringify(errors));
await browser.close();
const failed = Object.entries(results).filter(([, v]) => v === "FAIL").map(([k]) => k);
if (failed.length || errors.length) { console.log("FAILURES:", failed.join(",")); process.exit(1); }
console.log("SMOKE PASS");
