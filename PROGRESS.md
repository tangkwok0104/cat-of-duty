# PROGRESS — Cat of Duty

## Roadmap (v2, adopted 2026-07-28 — vertical-slice-first)

| Milestone | Content | Status |
|---|---|---|
| M0 | Scaffold | ✅ approved |
| M1 | Player controller | ✅ complete, pending approval |
| M2 | **VERTICAL SLICE — playable game** (`/slice`) | ✅ complete |
| M3 | Weapons: 3-gun loadout, ADS, recoil, reload | — |
| M4 | Cats: real models, animation, AI, hitboxes | — |
| M5 | HUD + feedback polish | — |
| M6 | Level art + environment pass | — |
| M7 | Game loop: menus, waves, scoring, settings | — |
| M8 | Polish + performance | — |

North star: `CLAUDE.md`. Milestone commands: `/slice`, `/review`.

## M2 — Vertical Slice (playable game)

**Status: complete.** Full loop live: click → wave of cats → shoot →
hitmarker+sound → kill → next wave → take damage → die → R restarts in place.
Loop-integrity harness: **10/10 steps asserted from game state**, zero console
errors. Perf in combat: 65 draws / 2.1k tris / p95 9.3ms / heap Δ 0.

- Weapon: box-rifle viewmodel with paw (placeholder until /assets), hitscan
  600RPM/34dmg (head ×2), 30-mag + R reload (2s), recoil spring (additive
  pitch — aim returns), star muzzle flash + light, pooled impact particles,
  bullets shove dynamic crates.
- ADS: RMB, FOV→55 over 150ms, viewmodel centres, crosshair hides.
- Cats: capsule+ears+vest placeholder (reads at 20m), ring spawns far from
  player, seek + separation (no navmesh by spec), flinch on hit, keel-over
  death + eye-glow fade, despawn 2s, claw 10dmg/1s in reach.
- Waves 1→2→…→6, next when field clear; toast + HOSTILE counter.
- Player: 100hp, regen after 5s, death desaturation + K.I.A. screen, R
  restart with full state reset (no page reload).
- HUD: crosshair spread (move/fire/ADS), hitmarker white-hit/red-kill,
  ammo/health/kills/wave, damage vignette, all tokens + transform/opacity.
- Audio: five WebAudio-synthesized sounds (shot/hit/kill/hurt/death +
  reload/dry clicks) — original, license-clean; Howler takes over when real
  files land. Gesture-gated (browser policy) — needs one human ear-check.
- Deferred per slice spec: navmesh, ragdolls, killfeed, minimap, menus,
  reload animation, weapon switching (M3), real cat models (M4).
- Cats may clip through crates (straight-line pursuit is the spec'd slice
  behaviour) — noted for M4 steering.

## M1 — Player Controller

**Status: complete, pending approval.** Branch `m0-scaffold` (same working
branch; rename/merge on approval). Play: `npm run dev` → click to lock →
WASD/Shift/Ctrl/Space. `F1` opens the live feel-tuning panel.

### Done

- Pointer-lock mouse look: raw `movementX/Y × sensitivity` applied to
  yaw/pitch the same frame — no smoothing, no acceleration, no interpolation
  anywhere in the path. Denied-lock promise rejections handled (post-ESC
  cooldown clicks no longer error).
- WASD + sprint (forward-gated) + crouch (real capsule resize with headroom
  check before standing) + jump. Rapier kinematic character controller:
  autostep 0.35m, slope limit 50°, snap-to-ground, pushes dynamic crates.
- Coyote time (120ms) + jump buffering (100ms), both tunable.
- Camera feel: speed-driven head bob with ease-in/out envelope, spring-damped
  landing punch, smooth crouch eye-height transitions — all additive view
  offsets, never touching the mouse's yaw/pitch.
- Movement character: hard accel (~90ms to full speed), harder braking
  (~60ms to stop), modest air control — crisp, not floaty, not icy.
- Tweakpane feel-tuning panel (F1) bound live to every movement/look/feel
  value — tune "feels bad"→"feels right" in one sitting.
- "CLICK TO ENGAGE" prompt with key hints; player-view spawn framed with a
  clear sightline (spawn moved off the SE pillar it originally faced).
- Input-to-render latency instrumentation in the input layer + `npm run
  latency` harness; perf harness upgraded (p99, std dev, GPU hardware string).
- Controller harness (`.tmp/feel-M1.ts`): 9/10 assertions from real
  keyboard/mouse events, verified against game state (walk speed/direction,
  sprint delta, instant stop, crouch+stand, jump apex+landing, mouse-steered
  movement, wall containment). The 1 fail: native pointer lock is denied in
  headless Chromium (environment, not code) — mechanics verified via the
  harness capture-override; native lock needs one manual click-test at
  approval.

### Measured (Apple M5 Pro via ANGLE Metal, 1920×1080, ULTRA)

- Input→render latency: p50 0.9ms / p95 1.7ms (300 samples), budget 20ms
- Frames: avg 8.33ms / p95 9.2 / p99 9.3 / worst 9.4 / σ 0.38ms (vsync 120Hz)
- 50 draw calls, 1.1k tris, heap Δ 0.00MB over 600 frames
- Iris Xe target still unverified — margins are wide; re-check at M2 content

### Stubbed / deferred

- Step-up and slope limit are configured but unproven — the grey-box has no
  low ledges or ramps; the slice's arena will exercise both.
- Coyote/jump-buffer verified by code + tunable, not timing-asserted in the
  harness (500ms-resolution polls can't catch a 120ms window reliably).
- `/assets` packs (Quaternius cats, Kenney guns, sounds) not yet downloaded —
  the v2 goal file assigns this as the parallel human task; slice falls back
  to placeholders if empty.
- Sprint FOV kick, weapon sway (M3 territory), damage states — not built.

### Decisions

- **Camera rotation is never interpolated** (position is) — rotation lag is
  perceivable as input lag; position interpolation is what fixed-timestep
  physics needs. Alternative (interpolate both) rejected: mushy aim.
- **Manual gravity (-22) + jump velocity on a kinematic capsule** instead of
  a dynamic body — FPS-standard, fully deterministic, no physics fighting.
  Alternative (dynamic body + forces) rejected: floaty, hard to tune.
- **Crate reset moved Q→T… R freed** — v2 slice reserves R for reload/restart.
- **Crouch resizes the collider** (with stand-up headroom raycast) rather
  than eye-height-only fake crouch — real gameplay difference under fire in
  M2+. Alternative rejected as a lie the slice would expose.

## M0 — Scaffold

**Status: complete, approved.**
Branch: `m0-scaffold`. Playable with `npm run dev` → http://127.0.0.1:5177.

### Done

- Vite 8 + TypeScript strict (`noUncheckedIndexedAccess`, zero errors, zero
  unjustified warnings). Split tsconfig: game code sees DOM types only,
  scripts see Node types only.
- Engine loop (`core/Loop.ts`): fixed 60Hz physics timestep with accumulator,
  spiral-of-death guard, interpolated rendering (alpha blend of prev/curr
  physics snapshots in preallocated Float32Arrays — hot path allocation-free).
- Rapier physics (`physics/PhysicsSystem.ts`): dynamic-imported (code-split,
  2.2MB WASM chunk parses parallel to renderer boot), static colliders driven
  by level data in GameState, 6 dynamic crates, `R` re-drops them.
- Render pipeline (visual bar from M0, not deferred):
  - HDR linear chain → N8AO (half-res) → selective bloom (emissives only,
    HDR threshold ≥1) → ACES filmic tone map → vignette + film grain → SMAA.
  - `outputColorSpace` sRGB; albedo textures sRGB, data maps linear.
  - CSM 2-cascade sun (2048px, bias tuned) matched to the HDRI sun; Poly
    Haven HDRI via PMREM for IBL — no flat ambient anywhere.
  - Full PBR materials (albedo/normal/rough/AO) on every visible surface.
  - InstancedMesh for walls, pillars, static crates, dynamic crates, strips.
- Adaptive quality (`render/QualityManager.ts`): 3s rolling frame-time window
  steps ULTRA→HIGH→MED→LOW→MIN — one lever per step in contract order
  (shadow res → AO → bloom → render scale last), 4s cooldown, guards against
  boot-hitch and sparse-window false positives. Steps down only — never
  oscillates back up mid-fight. Manual override via `Q` sets `auto=false`.
- Grey-box arena: 26×26m, 4 pillars, static crate cover clusters (colliders
  carry the visuals' yaw), emissive amber strips flush-mounted with warm
  point-light spill, bezeled red signal panel (in-world brand accents, bloom
  targets).
- Stats overlay (DOM, design tokens): fps / avg ms / p95 ms / draw calls /
  triangles / quality tier / JS heap.
- Boot screen with progress bar (doubles as pre-M6 menu surface).
- Harness: `scripts/capture.ts` (5 vantage points from `shots.json`, 1920×1080,
  console/network assertions, locked quality tier), `scripts/perf.ts`
  (600-frame orbit run, budget verdicts), both on ANGLE-Metal GPU headless.
- Brand defined (`BRAND.md`), tokens in `src/ui/tokens.css`. Assets logged in
  `CREDITS.md` (all CC0, Poly Haven).

### Measured (this machine: Apple Silicon, 1920×1080, ULTRA tier)

- avg 8.33ms / p95 8.9ms / worst 9.4ms — vsync-bound at 120Hz, real cost lower
- 46 draw calls (all passes: shadow + AO + main + post), 1.1k tris
- Heap Δ 0.00MB across 600 frames post-warmup (medians identical)
- **Caveat:** target hardware is Iris Xe; this machine is faster. Margin is
  large (46/150 draws, 1.1k/500k tris) but Iris Xe must be re-verified when
  real content lands (M2+).

### Stubbed / not in M0 (scheduled)

- Player controller, pointer lock, WASD (M1)
- GLB level loading, KTX2/Draco pipeline, LODs (M2 — no models exist yet,
  textures are raw JPG until the compression pipeline lands with real assets)
- Weapons, enemies, gameplay HUD, menus, audio (M3–M6); Howler installed idle
- Free-cam debug module (camera poses come via debug API for now)
- WebGL context-loss recovery (logged as known issue)

### Known issues

- Feel-test honesty (per protocol, "any no is a bug"): a stranger would not
  know what to do in 10s — nothing is playable yet beyond debug keys. This is
  M0 scope, resolved progressively M1+ (movement) and M5 (HUD affordances).
- WebGL context loss: handled with a clean stop + "RENDERER SIGNAL LOST —
  RELOAD PAGE" surface; full in-place restore deferred.
- `rapier3d-compat@0.19.3` logs one internal deprecation warning (its own
  wasm-bindgen init call). Upstream issue; public API offers no object form.
- Crate texture tiling repeats visibly across crates (same UV tile). Variety
  pass scheduled with real assets (M2).
- Wall plaster reads soft at long range (1k texture over 26m). Acceptable in
  grey-box; real level geometry replaces it in M2.

### Decisions (judgement calls + the alternative)

- **PCFShadowMap instead of spec'd PCFSoftShadowMap** — three r185 deprecated
  PCFSoft and silently falls back to PCF; we set the fallback explicitly to
  keep a clean console. Alternative: VSMShadowMap (true soft) — rejected for
  CSM light-bleed artifacts. Revisit if shadow edges read harsh in M2 levels.
- **N8AO over postprocessing's SSAOEffect** — GTAO-class quality, half-res
  support, purpose-built postprocessing integration. Alternative kept simple
  SSAO; rejected on quality.
- **Tone mapping in post chain, renderer at NoToneMapping** — keeps AO/bloom
  in linear HDR (selective bloom thresholds on true emissive intensity).
  Alternative (renderer ACES + LDR chain) silently breaks bloom selectivity.
- **2 CSM cascades, not 3-4** — 26m room; cascade 2 already covers the far
  wall. Scales up when M2 levels grow. Alternative (single tight map) doesn't
  scale to outdoor M2 content.
- **Adaptive quality never steps back up** — oscillation mid-combat is worse
  than a conservative tier. Manual reset available. Alternative: hysteresis
  ladder; revisit if players complain about sticky LOW.
- **Boot screen doubles as the M0 "menu" screenshot** — no fake menu built
  just for a screenshot; the real menu arrives in M6.
- **Big-Job protocol harness** (`finalize_task.sh` SVG/feedback/legal checks)
  not run: those gates target deployed web SaaS. This project's own
  self-review protocol (build/runtime/screenshots/perf/feel/acceptance) is
  the harness of record for milestones.

### Review

- 5-lens adversarial panel (graphics correctness, TS/architecture, physics,
  art direction, acceptance audit) run at M0 close: 33 findings, 17 fixed
  same-pass (incl. a latent InstancedMesh frustum-culling bug, collider yaw
  mismatch, and a bloom toggle that saved no GPU), rest triaged/documented.
  Details in `.tmp/review-M0.md`. All gates re-run green after fixes.
