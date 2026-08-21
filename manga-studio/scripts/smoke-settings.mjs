// macOS smoke: open AI Settings, screenshot protocol-first UI + Background Removal card.
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Launcher screen: create a project to enter the Studio.
await page.getByText("Create Project", { exact: false }).first().click();
await page.waitForTimeout(800);
await page.locator("input").first().fill("Smoke Test");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForTimeout(2500);

await page.getByText("AI Settings", { exact: false }).first().click();
await page.waitForTimeout(800);

const body = await page.locator("body").innerText();
// Protocol picker lives behind Advanced; open it before asserting options.
await page.getByText("Advanced — API standard").first().click();
await page.waitForTimeout(300);
const body2 = await page.locator("body").innerText();
const checks = {
  "default view hides protocol": !/API STANDARD/i.test(body.split(/ADVANCED/i)[0] ?? ""),
  "API Standard label": /API standard/i.test(body2),
  "OpenAI-compatible option": /OpenAI-compatible/i.test(body2),
  "Anthropic Messages option": /Anthropic Messages/i.test(body2),
  "Gemini Native option": /Gemini Native/i.test(body2),
  "Custom JSON option": /Custom JSON/i.test(body2),
  "Background Removal card": /background removal/i.test(body),
  "Primary built-in": /Primary/i.test(body) && /built-in/i.test(body),
  "Fallback collapsed": /Configure fallback \(optional\)/i.test(body),
  "No Custom/Preset tabs": !/Presets?/.test(body),
};
console.log(JSON.stringify(checks, null, 2));

await page.screenshot({ path: "/tmp/smoke-ai-settings.png" });
console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
if (failed.length || consoleErrors.length) {
  console.log("FAILED:", failed.join(", "));
  process.exit(1);
}
console.log("SMOKE OK");
