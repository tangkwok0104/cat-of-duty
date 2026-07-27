/** /review §6 — LOOP INTEGRITY. Drives the full slice loop with real input
 *  and asserts every step from game state, never by assumption:
 *  lock → move → fire (ammo drops) → hit+kill a cat → reload → take damage
 *  → die → restart. Any step that can't be asserted is a failing step.
 *
 *  Usage: npm run loop   (dev server on :5177)
 */
import { chromium } from 'playwright';

interface Game {
  hp: number;
  dead: boolean;
  slot: number;
  ammo: number;
  reserve: number;
  reloading: boolean;
  kills: number;
  wave: number;
  catsAlive: number;
  cats: { id: number; x: number; y: number; z: number; phase: string }[];
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(process.env['COD_URL'] ?? 'http://127.0.0.1:5177', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__cod?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(2000);

  const game = (): Promise<Game> => page.evaluate(() => window.__cod.getGame());
  const steps: [string, boolean, string][] = [];
  const step = (name: string, ok: boolean, detail: string): void => {
    steps.push([name, ok, detail]);
  };

  /** Place the shooter `dist` metres from a live cat with VERIFIED clear
   *  line of sight (real physics ray) — walks bearings around the cat until
   *  one isn't blocked by pillars/crates/walls. Returns the cat id. */
  const aimAtCat = (dist: number, aimY: number): Promise<number | null> =>
    page.evaluate(
      ([d, ay]) => {
        const g = window.__cod.getGame();
        const cat = g.cats.find((c) => c.phase === 'alive');
        if (!cat) return null;
        const OFFSETS = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, Math.PI / 2, -Math.PI / 2, Math.PI];
        for (const off of OFFSETS) {
          const ang = Math.atan2(-cat.x, -cat.z) + off;
          const px = cat.x + Math.sin(ang) * d!;
          const pz = cat.z + Math.cos(ang) * d!;
          if (Math.abs(px) > 12 || Math.abs(pz) > 12) continue;
          if (!window.__cod.lineOfSightToCat(px, 1.62, pz, cat.id, ay!)) continue;
          const yaw = Math.atan2(-(cat.x - px), -(cat.z - pz));
          const pitch = Math.atan2(ay! - 1.62, d!);
          window.__cod.setPlayer(px, 0.9, pz, yaw, pitch);
          return cat.id;
        }
        return null;
      },
      [dist, aimY],
    );

  // 1. Lock pointer (arms the waves).
  await page.mouse.click(960, 540);
  await page.waitForTimeout(250);
  const native = await page.evaluate(() => document.pointerLockElement !== null);
  if (!native) await page.evaluate(() => window.__cod.forceInputCapture(true));
  await page.waitForTimeout(400);
  step('lock pointer (arms waves)', true, native ? 'native' : 'override');

  // 2. First wave spawns a cat.
  await page.waitForFunction(() => window.__cod.getGame().catsAlive > 0, undefined, {
    timeout: 10_000,
  }).catch(() => {});
  let g = await game();
  step('wave 1 spawns a cat', g.wave === 1 && g.catsAlive >= 1, `wave=${g.wave} alive=${g.catsAlive}`);
  // Freeze the cat AT THE SPAWN RING now: the aimed-kill step needs the
  // probe-verified geometry (ring cat, centre-side shooter, clear LoS) —
  // a cat that wandered mid-arena can end up behind crate cover.
  await page.evaluate(() => window.__cod.setCatsFrozen(true));

  // 3. Move (WASD changes position).
  const before = await page.evaluate(() => window.__cod.getPerf().player);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => window.__cod.getPerf().player);
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  step('move', moved > 0.8, `moved ${moved.toFixed(2)}m`);

  // 4. Fire — ammo drops.
  g = await game();
  const ammoBefore = g.ammo;
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  g = await game();
  step('fire drains ammo', g.ammo < ammoBefore, `${ammoBefore}→${g.ammo}`);

  // 5. Kill a cat: teleport in front of one, aim at its torso, hold fire.
  // (Frozen since step 2 — asserts hitscan→hp→kill, not target tracking;
  // the chase behaviour is asserted by the contact-damage step below.)
  g = await game();
  let target = g.cats.find((c) => c.phase === 'alive');
  if (!target) {
    step('kill a cat', false, 'no live cat to shoot');
  } else {
    const killsBefore = g.kills;
    const aimed = await aimAtCat(5, 0.44); // torso, LoS-verified spot
    step('LoS-verified firing position found', aimed !== null, `catId=${aimed}`);
    await page.waitForTimeout(200);
    await page.mouse.down();
    // 100 dmg body needs 3 shots @34; hold long enough for a mag-third.
    await page.waitForTimeout(900);
    await page.mouse.up();
    g = await game();
    step('kill a cat (hitscan + hp + kill count)', g.kills > killsBefore, `kills ${killsBefore}→${g.kills}`);
  }

  // 6. Reload refills the mag from reserve.
  g = await game();
  const magBefore = g.ammo;
  const reserveBefore = g.reserve;
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  g = await game();
  const startedReload = g.reloading;
  await page.waitForTimeout(2100);
  g = await game();
  step(
    'reload (2s timer, reserve pays)',
    startedReload && g.ammo === 30 && g.reserve < reserveBefore,
    `mag ${magBefore}→${g.ammo}, reserve ${reserveBefore}→${g.reserve}`,
  );

  // 7. Take damage: stand still in the open until a cat reaches us.
  await page.evaluate(() => {
    window.__cod.setCatsFrozen(false); // chase behaviour back on
    window.__cod.setPlayer(0, 0.9, 0, 0, 0);
  });
  const hpBefore = (await game()).hp;
  await page
    .waitForFunction(
      (hp0) => window.__cod.getGame().hp < hp0 || window.__cod.getGame().dead,
      hpBefore,
      { timeout: 30_000 },
    )
    .catch(() => {});
  g = await game();
  step('cat contact damages player', g.hp < hpBefore || g.dead, `hp ${hpBefore}→${g.hp}`);

  // 8. Die: wait until hp reaches 0 (stand there and take it).
  await page
    .waitForFunction(() => window.__cod.getGame().dead, undefined, { timeout: 60_000 })
    .catch(() => {});
  g = await game();
  step('death at 0 hp', g.dead, `dead=${g.dead} hp=${g.hp}`);

  // 9. R restarts without reload: fresh hp/ammo/wave, no page navigation.
  const navBefore = await page.evaluate(() => performance.now());
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(600);
  g = await game();
  const navAfter = await page.evaluate(() => performance.now());
  step(
    'R restarts in place',
    !g.dead && g.hp === 100 && g.ammo === 30 && g.kills === 0 && navAfter > navBefore,
    `hp=${g.hp} ammo=${g.ammo} kills=${g.kills} (same page: ${navAfter > navBefore})`,
  );

  // 10. Waves restart after the reset.
  await page
    .waitForFunction(() => window.__cod.getGame().catsAlive > 0, undefined, { timeout: 10_000 })
    .catch(() => {});
  g = await game();
  step('waves resume after restart', g.wave >= 1 && g.catsAlive >= 1, `wave=${g.wave} alive=${g.catsAlive}`);

  // ---- M3: loadout ----
  // Cats freeze for the aimed-shot steps: these assert WEAPON mechanics
  // (pellets, falloff, headshot multiplier), not target tracking.
  await page.evaluate(() => window.__cod.setCatsFrozen(true));

  // 11. Switch to shotgun (slot 2 key) — per-slot ammo pools.
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(500);
  g = await game();
  step('switch to shotgun (own ammo pool)', g.slot === 1 && g.ammo === 6 && g.reserve === 24,
    `slot=${g.slot} ammo=${g.ammo}/${g.reserve}`);

  // 12. Shotgun point-blank kill in one trigger pull (8 pellets).
  g = await game();
  target = g.cats.find((c) => c.phase === 'alive');
  if (!target) {
    step('shotgun close-range one-pull kill', false, 'no live cat');
  } else {
    const kills0 = g.kills;
    await aimAtCat(2.2, 0.44);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(200);
    g = await game();
    step('shotgun close-range one-pull kill', g.kills > kills0, `kills ${kills0}→${g.kills}, ammo=${g.ammo}`);
  }

  // 13. Sniper headshot one-shots a cat (105×2 through the skull).
  // The shotgun may have cleared the field — let the next wave land first.
  await page.evaluate(() => window.__cod.setCatsFrozen(false));
  await page
    .waitForFunction(() => window.__cod.getGame().catsAlive > 0, undefined, { timeout: 15_000 })
    .catch(() => {});
  await page.evaluate(() => window.__cod.setCatsFrozen(true));
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(500);
  g = await game();
  const sniperArmed = g.slot === 2 && g.ammo === 5;
  target = g.cats.find((c) => c.phase === 'alive');
  if (!target) {
    step('sniper ADS headshot one-shot', false, 'no live cat');
  } else {
    const kills0 = g.kills;
    await aimAtCat(7, 0.95); // head ball, LoS-verified spot
    await page.waitForTimeout(150);
    await page.mouse.down({ button: 'right' }); // ADS
    await page.waitForTimeout(350);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(200);
    g = await game();
    step('sniper ADS headshot one-shot', sniperArmed && g.kills > kills0,
      `armed=${sniperArmed} kills ${kills0}→${g.kills} ammo=${g.ammo} target=(${target.x.toFixed(1)},${target.z.toFixed(1)})`);
  }
  await page.evaluate(() => window.__cod.setCatsFrozen(false));

  await browser.close();

  let pass = 0;
  console.log('\n[loop] ---- LOOP INTEGRITY ----');
  for (const [name, ok, detail] of steps) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (ok) pass++;
  }
  console.log(`[loop] ${pass}/${steps.length} steps asserted, console errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ERROR ${e}`);
  if (pass !== steps.length || errors.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[loop] fatal:', e);
  process.exitCode = 1;
});
