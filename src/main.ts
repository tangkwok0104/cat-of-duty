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
import { Hud } from './ui/Hud';
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
  const lockPrompt = document.getElementById('lock-prompt');
  if (
    !(canvas instanceof HTMLCanvasElement) ||
    !bootScreen ||
    !bootBar ||
    !bootStatus ||
    !lockPrompt
  ) {
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

  const input = new Input(canvas);
  const player = new PlayerController(input);
  const cameraFeel = new CameraFeel();
  const health = new Health();
  const weapon = new WeaponSystem(input, physics, renderSys.camera, renderSys.scene);
  postfx.addBloomMeshes(weapon.bloomMeshes);
  const cats = new CatSystem(renderSys.scene);
  const hud = new Hud();
  const sound = new SoundBus();
  canvas.addEventListener('click', () => sound.unlock()); // autoplay policy
  const stats = new StatsOverlay(state, () => quality.tierName());
  const perfRun = new PerfRun(renderSys, physics);
  const tuningPanel = new TuningPanel(state);
  installDebugApi(state, renderSys, physics, quality, perfRun, input);

  input.onKeyDown('KeyQ', () => {
    const next = ((state.quality.tier + 1) % 5) as QualityTier;
    quality.setTier(next, false);
  });
  input.onKeyDown('KeyT', () => physics.resetCrates());
  input.onKeyDown('F1', () => tuningPanel.toggle());
  // R routes by context: dead = full restart, alive = reload.
  input.onKeyDown('KeyR', () => {
    if (state.health.dead) {
      bus.emit('game:restart', {});
      state.playerTeleport = { ...PLAYER_SPAWN, yaw: PLAYER_SPAWN.yaw, pitch: 0 };
    } else {
      weapon.requestReload(performance.now() / 1000);
    }
  });

  // "Click to engage" prompt: visible whenever the player camera is live but
  // the pointer isn't locked. Toggled only on change — no per-frame DOM churn.
  let promptShown = false;
  const updatePrompt = (): void => {
    const show =
      state.ready &&
      !input.locked &&
      !input.captureOverride && // harness play = effectively locked
      state.cameraMode === 'player';
    if (show !== promptShown) {
      promptShown = show;
      lockPrompt.classList.toggle('hidden', !show);
    }
  };

  // Fixed order matters: player intent → health regen → cat AI → physics
  // (which applies player movement and mirrors cat colliders).
  let wavesArmed = false;
  let deathBlend = 0;
  const loop = new Loop(state, [player, health, cats, physics], (alpha, frameMs) => {
    const dt = frameMs / 1000;
    const now = performance.now();
    perfRun.beforeRender();
    player.frameLook(state); // raw mouse → yaw/pitch, same frame
    cameraFeel.frameUpdate(state, dt);
    weapon.frameUpdate(state, dt, now / 1000);
    cats.frameUpdate(state, now / 1000);
    renderSys.render(alpha, state);
    input.completeFrame(performance.now()); // closes input→render latency
    hud.frame(state, dt, now);
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
    updatePrompt();
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
  updatePrompt();
}

boot().catch((err: unknown) => {
  console.error('[cod] boot failed:', err);
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = 'BOOT FAILURE — CHECK CONSOLE';
    status.style.color = 'var(--c-danger)';
  }
});
