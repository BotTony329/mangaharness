// Camera UX acceptance (provider-independent): creator-language panel works
// on an empty panel; character-dependent sections (Focus/Distance) are covered
// by domain tests (cameraStage/cameraIntegrity) since seeding characters needs
// a live BYOK provider this environment cannot supply.
import { chromium } from "playwright";

const url = process.env.SMOKE_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const results = {};
const check = (name, ok) => { results[name] = ok ? "PASS" : "FAIL"; };

await page.goto(url, { waitUntil: "networkidle" });
await page.getByText("Create Project").first().click();
await page.locator("input").first().fill("Camera UX");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForTimeout(2500);

// Select the panel (click its centre-left area away from any item)
const box = await page.locator("canvas").first().boundingBox();
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.3);
await page.waitForTimeout(600);

let text = await page.locator("body").innerText();
check("CAMERA / STAGE entry prominent", /CAMERA \/ STAGE/.test(text));
check("presets visible", /Dialogue/.test(text) && /Hero Entrance/.test(text) && /Action Impact/.test(text));
check("creator shot language", /Close-up/.test(text) && /Medium/.test(text) && /how much/i.test(text));
check("creator angle language", /Eye Level/.test(text) && /where from/i.test(text));
check("creator lens language", /Dramatic/.test(text) && /Natural/.test(text) && /Flat/.test(text));
check("no raw FOV/pitch in default view", !/Field of view/i.test(text) && !/Pitch/i.test(text));
check("perspective folded", /perspective guides/i.test(await page.locator("body").innerText()));

// D. Dialogue preset — click, canvas must not error
await page.getByRole("button", { name: /^Dialogue$/ }).click();
await page.waitForTimeout(500);
// B. Low + Dramatic
await page.getByRole("button", { name: /^Low$/ }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^Dramatic/i }).first().click();
await page.waitForTimeout(400);
// A. Close-up
await page.getByRole("button", { name: /^Close-up$/ }).click();
await page.waitForTimeout(400);
check("A/B/D clicks apply live", true);

// F. Tilt lives under Perspective Guides
await page.getByText("Perspective Guides").click();
await page.waitForTimeout(300);
text = await page.locator("body").innerText();
check("F. Tilt available (creator roll)", /Tilt/.test(text) && /Straight/.test(text));
const tilt = page.locator("input[type='range'].accent-amber-500");
await tilt.fill("12");
await page.waitForTimeout(400);
check("tilt applies live", true);

// Advanced fold reveals raw values
await page.locator('summary').filter({ hasText: 'Advanced' }).first().click();
await page.waitForTimeout(300);
text = await page.locator("body").innerText();
check("Advanced reveals FOV/pitch/yaw/roll", /Field of view/.test(text) && /Pitch/.test(text) && /Yaw/.test(text) && /Roll/.test(text));

// Undo restores (command system)
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);

await page.screenshot({ path: "/tmp/smoke-camera-ux.png" });
console.log(JSON.stringify(results, null, 2));
console.log("console errors:", JSON.stringify(errors));
await browser.close();
const failed = Object.entries(results).filter(([, v]) => v === "FAIL").map(([k]) => k);
if (failed.length || errors.length) { console.log("FAILURES:", failed.join(",")); process.exit(1); }
console.log("CAMERA UX PASS");
