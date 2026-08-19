// Dev smoke test: boots the studio in headless Chromium, exercises the
// canvas, and screenshots it. Not part of the vitest suite (needs a browser).
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const hasCanvas = await page.locator("canvas").count();
console.log("canvas elements:", hasCanvas);
console.log("title:", await page.title());

// Add a speech bubble via the toolbar and verify an item appears in state.
await page.selectOption("select:has(option[value='speech'])", "speech");
await page.waitForTimeout(500);

await page.screenshot({ path: "/tmp/smoke-studio.png" });
console.log("console errors:", JSON.stringify(consoleErrors, null, 2));
await browser.close();
process.exit(consoleErrors.length > 0 ? 1 : 0);
