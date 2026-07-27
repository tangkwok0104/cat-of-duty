/** /review §4: input-to-render latency. Streams real mouse events at the
 *  page for ~5s, then reads p50/p95 of (pointermove timestamp → end of the
 *  render that first reflected it) from the game's own instrumentation.
 *
 *  Tries real pointer lock first (click on canvas); if the headless browser
 *  can't acquire it, falls back to the debug capture-override so the same
 *  code path is measured minus the lock itself. Reports which mode ran.
 *
 *  Usage: npm run latency   (dev server must be running on :5177)
 */
import { chromium } from 'playwright';

const BASE_URL = process.env['COD_URL'] ?? 'http://127.0.0.1:5177';
const BUDGET_P95 = 20;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cod?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);

  // Attempt real pointer lock.
  await page.mouse.click(960, 540);
  await page.waitForTimeout(300);
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  let mode = 'real pointer lock';
  if (!locked) {
    mode = 'capture-override (headless denied pointer lock)';
    await page.evaluate(() => window.__cod.forceInputCapture(true));
  }

  // ~5s of continuous small mouse movements at roughly gameplay cadence.
  let x = 960;
  let y = 540;
  for (let i = 0; i < 300; i++) {
    x += Math.sin(i * 0.3) * 14;
    y += Math.cos(i * 0.23) * 9;
    await page.mouse.move(x, y);
    await page.waitForTimeout(15);
  }

  const stats = await page.evaluate(() => window.__cod.getLatency());
  await browser.close();

  console.log('\n[latency] ---- input → render ----');
  console.log(`mode    : ${mode}`);
  console.log(`samples : ${stats.samples}`);
  console.log(`p50     : ${stats.p50} ms`);
  console.log(`p95     : ${stats.p95} ms`);
  const pass = stats.samples >= 50 && stats.p95 >= 0 && stats.p95 <= BUDGET_P95;
  console.log(`${pass ? 'PASS' : 'FAIL'}  p95 ${stats.p95}ms ≤ ${BUDGET_P95}ms (≥50 samples)`);
  if (errors.length > 0) {
    console.log(`console errors: ${errors.length}`);
    for (const e of errors) console.log(`  ERROR ${e}`);
  }
  if (!pass || errors.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[latency] fatal:', e);
  process.exitCode = 1;
});
