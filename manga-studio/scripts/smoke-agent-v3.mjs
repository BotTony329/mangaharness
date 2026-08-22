// Smoke: Agent V3 panel survives a run with no model connected (503 path).
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3109";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => {
  // The 503 network log IS the expected no-model path, not an app error.
  if (msg.type() === "error" && !/status of 503/.test(msg.text())) consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// Create a project if the launcher is shown.
const createBtn = page.locator("button:has-text('Create Project')").first();
if (await createBtn.count()) {
  await createBtn.click();
  await page.waitForTimeout(800);
  await page.locator("button:has-text('Create')").last().click();
  await page.waitForTimeout(3000);
}

// Open the Agent panel if a tab exists.
const agentTab = page.locator("button:has-text('Agent'), [role='tab']:has-text('Agent')").first();
if (await agentTab.count()) { await agentTab.click(); await page.waitForTimeout(500); }

const textarea = page.locator("textarea").first();
console.log("agent textarea visible:", await textarea.count());
if (await textarea.count()) {
  await textarea.fill("Create a two-panel scene where Momo shouts \"Wait!\"");
  const runBtn = page.locator("button:has-text('Run')").first();
  if (await runBtn.count()) {
    const disabled = await runBtn.isDisabled();
    console.log("run button disabled (no model):", disabled);
    if (!disabled) {
      await runBtn.click();
      await page.waitForTimeout(4000);
      const body = await page.textContent("body");
      console.log("graceful no-model message:", /Connect an AI model|No agent model|connect/i.test(body ?? ""));
    }
  }
}
await page.screenshot({ path: "/tmp/smoke-agent-v3.png" });
console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
process.exit(consoleErrors.length > 0 ? 1 : 0);
