/** Self-review §4 harness: 600 frames of gameplay-like camera motion,
 *  headless, then budget verdicts.
 *
 *  Usage: npm run perf [-- M0]   (dev server must be running on :5177)
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MILESTONE = process.argv[2] ?? 'M0';
const BASE_URL = process.env['COD_URL'] ?? 'http://127.0.0.1:5177';
const FRAMES = 600;

const BUDGET = {
  p95Ms: 16.6,
  drawCalls: 150,
  triangles: 500_000,
  heapGrowthMB: 5, // "zero growth" with GC-noise tolerance
};

interface PerfResult {
  frames: number;
  warmupFrames: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  heapStartMB: number;
  heapEndMB: number;
  heapGrowthMB: number;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  console.log(`[perf] loading ${BASE_URL} …`);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cod?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(2000); // shader compile + JIT warmup outside the run

  console.log(`[perf] running ${FRAMES} frames …`);
  await page.evaluate((frames) => window.__cod.startPerfRun(frames), FRAMES);
  await page.waitForFunction(() => window.__cod.perfResult !== null, undefined, {
    timeout: 120_000,
  });
  const result = (await page.evaluate(() => window.__cod.perfResult)) as PerfResult;
  await browser.close();

  const outDir = resolve(ROOT, '.tmp');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `perf-${MILESTONE}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n[perf] ---- results (post-warmup) ----');
  console.log(`avg frame  : ${result.avgMs} ms`);
  console.log(`p95 frame  : ${result.p95Ms} ms`);
  console.log(`worst frame: ${result.worstMs} ms`);
  console.log(`draw calls : ${result.drawCalls}`);
  console.log(`triangles  : ${result.triangles}`);
  console.log(`heap       : ${result.heapStartMB} → ${result.heapEndMB} MB (Δ ${result.heapGrowthMB})`);
  console.log(`saved      : ${outPath}`);

  const verdicts: [string, boolean][] = [
    [`p95 ${result.p95Ms}ms ≤ ${BUDGET.p95Ms}ms`, result.p95Ms <= BUDGET.p95Ms],
    [`draws ${result.drawCalls} ≤ ${BUDGET.drawCalls}`, result.drawCalls <= BUDGET.drawCalls],
    [`tris ${result.triangles} ≤ ${BUDGET.triangles}`, result.triangles <= BUDGET.triangles],
    [
      `heap Δ ${result.heapGrowthMB}MB ≤ ${BUDGET.heapGrowthMB}MB`,
      result.heapGrowthMB <= BUDGET.heapGrowthMB,
    ],
  ];
  console.log('\n[perf] ---- budget ----');
  let failed = false;
  for (const [label, ok] of verdicts) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed = true;
  }
  if (consoleErrors.length > 0) {
    console.log(`\n[perf] console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR ${e}`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[perf] fatal:', err);
  process.exitCode = 1;
});
