import { createGameState } from './core/GameState';
import { Loop } from './core/Loop';
import { Input } from './core/Input';
import { loadHdri, loadPbrSet, TOTAL_LOAD_UNITS } from './core/Assets';
import { createRenderer, hardwareString } from './render/Renderer';
import { RenderSystem } from './render/RenderSystem';
import { Lighting } from './render/Lighting';
import { PostFX } from './render/PostFX';
import { QualityManager } from './render/QualityManager';
import { PhysicsSystem } from './physics/PhysicsSystem';
import { PlayerController } from './player/PlayerController';
import { CameraFeel } from './player/CameraFeel';
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

  // "Click to engage" prompt: visible whenever the player camera is live but
  // the pointer isn't locked. Toggled only on change — no per-frame DOM churn.
  let promptShown = false;
  const updatePrompt = (): void => {
    const show = state.ready && !input.locked && state.cameraMode === 'player';
    if (show !== promptShown) {
      promptShown = show;
      lockPrompt.classList.toggle('hidden', !show);
    }
  };

  // Player intent runs BEFORE physics each fixed step (jump/coyote decisions
  // feed the same step's character-controller move).
  const loop = new Loop(state, [player, physics], (alpha, frameMs) => {
    perfRun.beforeRender();
    player.frameLook(state); // raw mouse → yaw/pitch, same frame
    cameraFeel.frameUpdate(state, frameMs / 1000);
    renderSys.render(alpha, state);
    input.completeFrame(performance.now()); // closes input→render latency
    quality.observe(frameMs, performance.now());
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
