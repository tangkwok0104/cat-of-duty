/** Self-review §2+§3 harness: load the game headless, assert a clean console,
 *  then capture the fixed vantage points from shots.json as 1920×1080 PNGs.
 *
 *  Usage: npm run capture [-- M0]   (dev server must be running on :5177)
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Shot {
  name: string;
  note: string;
  pos: [number, number, number];
  lookAt: [number, number, number];
  settleMs?: number;
  boot?: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MILESTONE = process.argv[2] ?? 'M0';
const BASE_URL = process.env['COD_URL'] ?? 'http://127.0.0.1:5177';
const OUT_DIR = resolve(ROOT, 'screenshots', MILESTONE);

async function main(): Promise<void> {
  const { shots } = JSON.parse(
    readFileSync(resolve(ROOT, 'scripts', 'shots.json'), 'utf8'),
  ) as { shots: Shot[] };
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.failure()?.errorText ?? '?'} ${req.url()}`);
  });

  console.log(`[capture] loading ${BASE_URL} …`);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cod?.ready === true, undefined, {
    timeout: 60_000,
  });
  console.log('[capture] game ready');
  await page.waitForTimeout(1500); // let physics settle + shaders warm

  for (const shot of shots) {
    await page.evaluate(
      ([px, py, pz, tx, ty, tz, boot]) => {
        window.__cod.showBoot(Boolean(boot));
        window.__cod.setCamera(px as number, py as number, pz as number, tx as number, ty as number, tz as number);
      },
      [...shot.pos, ...shot.lookAt, shot.boot ? 1 : 0],
    );
    await page.waitForTimeout(shot.settleMs ?? 400);
    const path = resolve(OUT_DIR, `${shot.name}.png`);
    await page.screenshot({ path });
    console.log(`[capture] ${shot.name} → ${path}  (${shot.note})`);
    if (shot.boot) {
      await page.evaluate(() => window.__cod.showBoot(false));
    }
  }

  await browser.close();

  console.log('\n[capture] ---- console report ----');
  console.log(`errors: ${consoleErrors.length}`);
  for (const e of consoleErrors) console.log(`  ERROR ${e}`);
  console.log(`warnings: ${consoleWarnings.length}`);
  for (const w of consoleWarnings) console.log(`  WARN ${w}`);
  console.log(`failed requests: ${failedRequests.length}`);
  for (const r of failedRequests) console.log(`  FAIL ${r}`);

  if (consoleErrors.length > 0 || failedRequests.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('[capture] fatal:', err);
  process.exitCode = 1;
});
