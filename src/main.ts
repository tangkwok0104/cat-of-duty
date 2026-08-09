import { createGameState, PLAYER_SPAWN } from './core/GameState';
import { Loop } from './core/Loop';
import { Input } from './core/Input';
import { bus } from './core/EventBus';
import { loadHdri, loadPbrSet, TOTAL_LOAD_UNITS } from './core/Assets';
import { createRenderer, hardwareString } from './render/Renderer';
import { RenderSystem } from './render/RenderSystem';
import { Lighting } from './render/Lighting';
import { PostFX } from './render/PostFX';
import { QualityManager } from './render/QualityManager';
import { PhysicsSystem } from './physics/PhysicsSystem';
import { PlayerController } from './player/PlayerController';
import { CameraFeel } from './player/CameraFeel';
import { Health } from './player/Health';
import { WeaponSystem } from './weapons/WeaponSystem';
import { CatSystem } from './enemies/CatSystem';
import { CatOverlays } from './enemies/CatOverlays';
import { Pickups } from './gameplay/Pickups';
import { WeaponPickups } from './gameplay/WeaponPickups';
import { Hud } from './ui/Hud';
import { Menu } from './ui/Menu';
import { SoundBus } from './audio/SoundBus';
import { buildGreyBoxRoom } from './levels/GreyBoxRoom';
import { StatsOverlay } from './debug/StatsOverlay';
import { PerfRun } from './debug/PerfRun';
import { TuningPanel } from './debug/TuningPanel';
import { installDebugApi } from './debug/DebugApi';
import type { QualityTier } from './core/GameState';

async function boot(): Promise<void> {
  const canvas = document.getElementById('game-canvas');
  const bootScreen = document.getElementById('boot-screen');
  const bootBar = document.getElementById('boot-bar-fill');
  const bootStatus = document.getElementById('boot-status');
  if (!(canvas instanceof HTMLCanvasElement) || !bootScreen || !bootBar || !bootStatus) {
    throw new Error('index.html is missing required elements');
  }

  let loaded = 0;
  const progress = (label: string): void => {
    loaded++;
    bootBar.style.transform = `scaleX(${Math.min(1, loaded / TOTAL_LOAD_UNITS)})`;
    bootStatus.textContent = `LOADING ${label.toUpperCase()}`;
  };

  const state = createGameState();
  const renderer = createRenderer(canvas);
  state.hardware = hardwareString(renderer);
  const renderSys = new RenderSystem(renderer);
  const lighting = new Lighting(renderSys.scene, renderSys.camera);
  const postfx = new PostFX(renderer, renderSys.scene, renderSys.camera);
  renderSys.attach(lighting, postfx);
  const quality = new QualityManager(state, renderer, lighting, postfx);

  // Assets (13 units) — HDRI and the three PBR sets load in parallel.
  const [hdri, floor, wall, crate] = await Promise.all([
    loadHdri(progress),
    loadPbrSet('concrete_floor_worn_001', 5, 5, progress),
    loadPbrSet('plastered_wall', 11, 1.6, progress),
    loadPbrSet('worn_planks', 1, 1, progress),
  ]);
  lighting.applyEnvironment(renderer, renderSys.scene, hdri);
  buildGreyBoxRoom(renderSys.scene, { floor, wall, crate }, state);

  // Physics (unit 14) — needs level collider specs, hence after level build.
  const physics = new PhysicsSystem();
  await physics.init(state);
  progress('physics');

  // Pre-compile every material now — the first shot must not pay a
  // shader-compile hitch mid-combat.
  renderer.compile(renderSys.scene, renderSys.camera);

  const input = new Input(canvas);
  const player = new PlayerController(input);
  const cameraFeel = new CameraFeel();
  const health = new Health();
  const weapon = new WeaponSystem(input, physics, renderSys.camera, renderSys.scene);
  weapon.arm(state);
  postfx.addBloomMeshes(weapon.bloomMeshes);
  const cats = new CatSystem(renderSys.scene);
  postfx.addBloomMeshes(cats.bloomMeshes); // projectile glow spheres
  // HP bars + floating damage numbers — flat UI-ish sprites, deliberately
  // NOT bloomed (bloom would blow out the small canvas text/bars).
  const catOverlays = new CatOverlays(renderSys.scene);
  const pickups = new Pickups(renderSys.scene);
  postfx.addBloomMeshes(pickups.bloomMeshes); // health/ammo glow octahedra
  const weaponPickups = new WeaponPickups(renderSys.scene);
  postfx.addBloomMeshes(weaponPickups.bloomMeshes); // arsenal/station rings
  const hud = new Hud();
  const sound = new SoundBus();
  canvas.addEventListener('click', () => sound.unlock()); // autoplay policy
  // Best score survives sessions.
  try {
    state.score.best = Number(localStorage.getItem('cod-best') ?? 0) || 0;
  } catch {
    /* private mode */
  }
  bus.on('player:died', () => {
    const s = state.score;
    hud.fillDeathStats(s.score, s.best, s.kills, s.wave, s.shots, s.hits);
  });
  // Hit-stop on kills: 40ms world-freeze, camera stays live. Headshots get
  // 70ms — headroom on the emphasis kill (research: 40-80ms band).
  bus.on('enemy:hit', ({ killed, part }) => {
    if (killed) state.hitStopUntil = performance.now() + (part === 'head' ? 70 : 40);
  });
  const stats = new StatsOverlay(state, () => quality.tierName());
  const perfRun = new PerfRun(renderSys, physics);
  const tuningPanel = new TuningPanel(state);
  installDebugApi(state, renderSys, physics, quality, perfRun, input, physics, {
    // Harness: own everything AND remove the ground guns — a leftover
    // pickup could auto-switch weapons mid-assertion.
    grantAllWeapons: () => {
      weapon.grantAllWeapons();
      weaponPickups.debugDespawnWeapons();
    },
  });

  input.onKeyDown('KeyQ', () => {
    const next = ((state.quality.tier + 1) % 5) as QualityTier;
    quality.setTier(next, false);
  });
  input.onKeyDown('KeyT', () => physics.resetCrates());
  input.onKeyDown('F1', () => tuningPanel.toggle());
  // 1–4 route through an ownership check: unowned slots shake their HUD
  // chip instead of switching (WeaponSystem also guards independently).
  const trySwitch = (slot: number): void => {
    if (state.weapon.owned[slot] !== true) {
      hud.denySwitch(slot);
      return;
    }
    weapon.requestSwitch(slot, performance.now() / 1000);
  };
  input.onKeyDown('Digit1', () => trySwitch(0));
  input.onKeyDown('Digit2', () => trySwitch(1));
  input.onKeyDown('Digit3', () => trySwitch(2));
  input.onKeyDown('Digit4', () => trySwitch(3));
  // R routes by context: dead = full restart, alive = reload.
  input.onKeyDown('KeyR', () => {
    if (state.health.dead) {
      bus.emit('game:restart', {});
      state.playerTeleport = { ...PLAYER_SPAWN, yaw: PLAYER_SPAWN.yaw, pitch: 0 };
    } else {
      weapon.requestReload(performance.now() / 1000);
    }
  });

  // Main menu overlay: DEPLOY/RESUME + settings; shows whenever the pointer
  // is free (and the death card isn't up).
  const menu = new Menu(state, quality, {
    lock: () => {
      sound.unlock();
      input.requestLock();
    },
    setVolume: (v) => sound.setVolume(v),
  });

  // Fixed order matters: player intent → health regen → cat AI → physics
  // (which applies player movement and mirrors cat colliders).
  let wavesArmed = false;
  let deathBlend = 0;
  const loop = new Loop(state, [player, health, cats, physics, pickups, weaponPickups], (alpha, frameMs) => {
    const dt = frameMs / 1000;
    const now = performance.now();
    perfRun.beforeRender();
    player.frameLook(state); // raw mouse → yaw/pitch, same frame
    cameraFeel.frameUpdate(state, dt);
    weapon.frameUpdate(state, dt, now / 1000);
    cats.frameUpdate(state, now / 1000);
    catOverlays.frameUpdate(state, now / 1000);
    pickups.frameUpdate(now / 1000);
    weaponPickups.frameUpdate(now / 1000);
    renderSys.render(alpha, state);
    input.completeFrame(performance.now()); // closes input→render latency
    hud.frame(state, dt, now);
    sound.tick(state.health.hp / 100, state.health.dead);
    // First lock-in arms the first wave (also under the harness override).
    if (!wavesArmed && (input.locked || input.captureOverride)) {
      wavesArmed = true;
      cats.startWaves();
    }
    // Death drains colour; respawn restores it.
    const deathTarget = state.health.dead ? 1 : 0;
    if (Math.abs(deathBlend - deathTarget) > 0.001) {
      deathBlend += (deathTarget - deathBlend) * Math.min(1, 5 * dt);
      postfx.setDesaturation(deathBlend);
    }
    quality.observe(frameMs, now);
    stats.frame(frameMs);
    perfRun.afterRender(state, frameMs);
    menu.update(input.locked, input.captureOverride);
  });

  // GPU context loss: stop cleanly and tell the player, instead of a frozen
  // black canvas. (Full in-place restore is a later milestone.)
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    loop.stop();
    bootScreen.classList.remove('hidden');
    bootStatus.textContent = 'RENDERER SIGNAL LOST — RELOAD PAGE';
    bootStatus.style.color = 'var(--c-danger)';
  });

  loop.start();

  state.ready = true; // window.__cod.ready reads this — single source of truth
  bootScreen.classList.add('hidden');
}

boot().catch((err: unknown) => {
  console.error('[cod] boot failed:', err);
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = 'BOOT FAILURE — CHECK CONSOLE';
    status.style.color = 'var(--c-danger)';
  }
});
