import { chromium } from 'playwright';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4123', { waitUntil: 'networkidle' });

// 1. create project
const createBtn = page.getByRole('button', { name: 'Create Project' });
await createBtn.click();
const nameInput = page.locator('input[type="text"], input:not([type])').first();
await nameInput.fill('Smoke Layers');
await page.getByRole('button', { name: /create/i }).last().click();
await page.waitForTimeout(1200);

// helper: put content into panel 1 via store? Use UI: click a panel on canvas then use toolbar? Simplest: use store through page.evaluate
const state = await page.evaluate(() => {
  const store = window.__editorStore ?? null;
  return { hasStore: Boolean(store) };
});
console.log('store hook:', JSON.stringify(state));
console.log('body text has Pages?:', await page.locator('body').innerText().then(t => t.slice(0, 200)));
await page.screenshot({ path: '/tmp/km-1.png' });
console.log('console errors:', errors.length, errors.slice(0,3));
await browser.close();
