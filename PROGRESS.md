# PROGRESS — Cat of Duty

## Roadmap (v2, adopted 2026-07-28 — vertical-slice-first)

| Milestone | Content | Status |
|---|---|---|
| M0 | Scaffold | ✅ approved |
| M1 | Player controller | ✅ complete, pending approval |
| M2 | **VERTICAL SLICE — playable game** (`/slice`) | ✅ complete |
| M3 | Weapons: 3-gun loadout, ADS, recoil, reload | ✅ complete |
| M4 | Cats: real models, animation, AI, hitboxes | ✅ procedural version shipped (archetypes, ranged AI, articulated bodies) — real GLB models still blocked on /assets |
| M5 | HUD + feedback polish | ✅ complete |
| M6 | Level art + environment pass | ⚠ combat-space pass shipped (platform/stairs/cover) — art textures still blocked on /assets |
| M7 | Game loop: menus, waves, scoring, settings | ✅ complete |
| M8 | Polish + performance | ✅ partial (shake, hit-stop, budgets green; final pass after M4/M6) |

North star: `CLAUDE.md`. Milestone commands: `/slice`, `/review`.

## SHIPPED (2026-08-10) — https://cat-of-duty.vercel.app

Deployed to Vercel production (project `cat-of-duty`, account tangkwok0104).
`main` branch created at the shipped tip. Verified live: 200 + rendered menu
screenshot. Stats overlay now hidden on non-local hosts (F3 toggles); menu
hint fixed to "1-4 GUNS".

## Wave 6 (2026-08-10 overnight) — payload: 140MB → 15MB, wave-1 real cat, wedge fix

**Payload** (`.tmp/optimize-glbs.mjs`, originals in `.tmp/gen/originals/` +
git history): the 7 cat animation GLBs each carried a full duplicate of the
skinned mesh + 2048 texture — stripped to skeleton + clip only (7.6MB →
0.04MB each). All meshes meshopt-compressed + quantized, textures 1024 WebP
(catsoldier 7.1→0.39MB, rifle 11→0.66MB, props ~10→0.4MB). Total
`public/assets` 140MB → 15MB. MeshoptDecoder wired in Assets.ts (the new
files REQUIRE it). Rig verified structurally (1 skin/26 nodes/anims intact)
and visually (crisp tabby, clean stride, no quantization artifacts).

**Wave-1 real cat** (wave-5 QA finding): DEPLOY button now gates on
`preloadCritical` (cat + all clips + rifle + paw, ~1.5MB post-compression)
with a LOADING % readout — a stranger's first enemy is the real cat, never
the untextured proxy. Fallback releases the button on any load failure.

**Cat-wedging bug (wave-5 regression, mine).** First compressed-asset loop
run failed 10/14; a single-sample A/B (originals passed once) pointed at
the assets — WRONG, both were flake. A 40s position-sampling probe caught
the truth: cats from the new ±17 corner spawns aim exactly through the
±6,±6 pillars, and straight-line seek + collider push-out wedges them at
r≈9.3 forever (player-facing bug: waves stall). Fix = class fix in
CatSystem seek: wedge detector (intended vs actual displacement, 0.7s
threshold) + 0.8s tangential detour, side fixed per cat (persistent
same-side rounding always clears a convex box; alternating can ping-pong).
Lesson logged: a flaky failure needs N runs before an A/B means anything.

Gates: tsc ×2, build green, loop 14/14 **×3 consecutive** (flake class
demands repetition), HUD/auto-reload/banner asserts 8/8, cat visual pass.
Deployed.

## Combat Wave 5 (2026-08-10 overnight) — the playtest-feedback wave

All of Anson's playtest complaints, built by a 5-builder workflow on
disjoint files, verified by gates + adversarial visual QA (screenshots in
`screenshots/wave5-feedback/`):

- **"Never know what floor objects are"** → every pickup type has a floating
  canvas-sprite label + icon (HEALTH cross / AMMO bullets / gun names from
  config / AMMO STATION crate), new `gameplay/PickupLabel.ts`; per-kind spin
  speeds differentiate health (1.0) vs ammo (1.8 rad/s). Labels never
  bloomed, never parented to spinning meshes.
- **"No enlarge when shooting far"** → CatOverlays distance compensation:
  scale × max(1, dist/9m), numbers capped 3.2×, bars 2.2× — QA measured
  ~12px at 18.5m vs ~8-9px pure perspective; readable at range, unchanged
  inside 9m.
- **"Cats floating, not running"** → root cause was CatVisual.ts:492 driving
  leg cadence from the spawn-time cruise-speed constant while real
  displacement diverged (separation pushes, gunner strafe, obstacle snaps).
  Now: EMA-smoothed real displacement speed (0.18s) / (locoMps × cat.scale)
  with clamp; visual-only body yaw blends toward actual movement heading
  (8 rad/s) when >0.8 m/s, back to face-player when slow/windup/overlay.
  Heavy's 1.35× stride mismatch fixed by the scale factor.
- **"Low ammo notification"** → mag-fraction HUD states: amber ≤35%, pulsing
  red ≤15%/empty, RELOAD [R] / FIND AMMO prompts (reads mag size from
  WeaponConfig, no duplicated numbers).
- **"Auto-reload"** → empty-mag trigger pull auto-reloads when reserve > 0
  (same requestReload path; manual R untouched — harness exact-ammo asserts
  intact). QA asserted reloading flips true from state without R.
- **"Never end shooting and rest"** → WAVE_BREATHER 1.5s → 7s; `wave:cleared`
  now carries `breatherS`; persistent HUD banner counts down "WAVE N CLEARED
  — NEXT WAVE IN s" (deadline-derived in frame(), no timers). QA saw 6→2
  counting between +1s and +5s shots, recurring every wave.
- **"Arena small"** → 26×26 → 38×38 (ROOM_HALF 19): interior layout kept as
  mid-field, ~7 new cover pieces in the outer ring, spawn ring scaled to
  ±17-17.5, ARENA_CLAMP 18.3, minimap rescaled (single derived constant),
  harness LoS search bounds ±12 → ±18 in lockstep.

Gates: tsc 0 ×2 configs, build green, loop 14/14 ×2 with 0 console errors,
perf mid-combat wave 5: 120 fps, 8.70 ms p95, 145 draws, 361k tris — no
regression despite the bigger arena. Visual QA: 7/7 PASS.

Known follow-ups: (1) wave-1's instant spawn beats the GLB load → first cat
is the untextured proxy (fix funded in wave 6 loading work — "first cat must
be the real cat"); (2) outer-ring corners still sparse (level-art debt);
(3) builder-caught RTK gotcha reconfirmed — bare `npx tsc` returned a fake
clean summary, `rtk proxy` surfaced the real error (verification through RTK
is not verification).

## Combat Wave 4C — damage feedback, weapon audio, paw viewmodel, diet cat (2026-08-09)

(Session crashed mid-verification; all gates re-run clean on resume.)

**Enemy damage feedback** (`enemies/CatOverlays.ts`, new): pooled
world-space HP bars above damaged cats (canvas sprites, redraw only on
hp change, green→amber→red through the HUD's own color tokens) +
floating damage numbers on hit (spawn at head height regardless of hit
part, rise+fade 0.7 s, jittered so bursts don't stack, headshot 1.4× in
accent amber, kill 1.15× in danger red). Purely presentational — reads
GameState/EventBus, writes nothing back; deliberately NOT bloomed.
Playtest ask this answers: headshots weren't reading as 2×, and cats
had no visible health at all.

**Weapon audio integration** (SoundBus +303): the 8 recorded weapon
samples wired in — per-gun shots via a profile→sample map (incl. smg),
reload foley, dryfire click, concrete impact on the new
`weapon:impact` event (WeaponSystem emits at the decal point on static
geometry hits), projectile whoosh layered UNDER the existing zap so
"incoming fire" still reads the same. Central gain mix table
(player shots 0.9 loudest by design → impact texture 0.35 quietest);
±4% detune on gunshots (vs ±3% default) so 900 rpm SMG retrigger
doesn't read as a loop; per-sample retrigger floors with an SMG
override. **Silent-generation guard**: decode-time peak check
(MIN_SAMPLE_PEAK 0.01) auto-gates broken generations to their synth
fallbacks — caught 4 of 8 (shot-smg, reload, impact-concrete,
projectile-whoosh, all −41 to −57 dBFS). Logged in CREDITS.md;
regenerate via a real SFX pipeline later. Audio never silently missing
or silently broken.

**Paw viewmodel**: `paw.glb` grip prop loaded once, cloned onto each
gun via per-gun `viewModel.paw` transform in WeaponConfig (opt-out per
gun by omission); attached to the gun group so it inherits
sway/recoil/dip and the scope-hides-viewmodel toggle for free. HIP
anchor moved outward/down (0.17,−0.15 → 0.3,−0.3) for a proper
corner-anchored FPS silhouette.

**Diet cat**: `catsoldier.glb` swapped for a lower-poly re-export of
the same generation — 25,866 → 10,417 tris, bones/bbox/clips/texture
verified identical by rig diff (`.tmp/lite-rig-diff-debug2.log`).
Original preserved in git history.

Gates (re-run post-crash): tsc clean both configs, vite build green,
loop-integrity 14/14 ×2 with 0 console errors, SoundBus probe PASS
(all 14 samples decode, 4 correctly auto-gated), CatOverlays screenshot
QA 0 errors. Perf mid-combat wave 5, 5 cats + heavy, ULTRA on the dev
M5 Pro: 120 fps, 8.34 ms avg / 8.80 ms p95, 131 draws, 343k tris,
heap 215 MB — frame time better than pre-swap. Needs one human pass:
sound mix levels on real headphones (gain table values are
first-listen starting points).

## Combat Wave 4B — Arsenal (2026-08-09)

Progression: runs start RIFLE-ONLY (`WeaponState.owned`, reset on
restart); the rest of the roster is fixed glowing ground pickups
(`gameplay/WeaponPickups.ts`, pattern-matched to Pickups): SCRATCH-12 at
(-8,6.5) by the SW sandbags, LONGWHISKER on the platform top (climb
reward), new PURR-90 SMG at (-5.5,3.2) by the west cover wall. Pickup =
real gun GLB (~0.5 m, spin+bob) over a cool-blue emissive ring
(bloom-registered). Walk-over: own the slot, full mag + 2 spare mags,
AUTO-SWITCH, `weapon:acquired` (HUD toast "X ACQUIRED — [n]" + SoundBus
3-note riff). Duplicate = +1 mag reserve, no switch. PURR-90: slot 3/key
4, auto 900 rpm, 16 dmg (2× head), mag 50/100, 2.2 s reload, short
falloff (12→32 m), spread 2.0°/0.35°, tiny per-shot kicks, tracers,
higher-pitch rifle synth ('smg' profile). Two ammo stations at (10,8) /
(-9,-9) — crate GLB @0.25 + amber ring, +1 mag reserve for every owned
gun (capped at reserveStart), despawn → blink back in after 45 s. HUD
slot chips 1-4: socket (unowned) / lit (owned) / amber box (active);
pressing an unowned key shakes its chip. Keys 1-4 route through an
ownership check in main. Harness: `__cod.grantAllWeapons()` (owns all,
full ammo, despawns ground guns so no auto-switch mid-assertion) called
after lock AND after the R-restart step; all 14 steps unchanged and
passing (14/14, 0 console errors). tsc clean both configs. Screenshots:
`screenshots/wave4b-arsenal/`. Perf unchanged (≈80-104 fps, ~90-107
draws at ULTRA on the dev Mac). Judgment calls: ammo stations live in
WeaponPickups (not Pickups) to keep the drop pool untouched; station
top-ups cap at reserveStart (protects harness exact-ammo asserts);
`weapon:fired` profile union in core/EventBus widened with 'smg'
(required for the per-gun sound contract).

## Combat Wave 4A (2026-08-09) — animation + voice + reticle polish

Death clips per style (shot = backward arch, headshot = forward slam),
hit-react replaces the tilt jolt, melee plays the strike slice of the
kung-fu clip (full clip had root motion that would slide the mesh — caught
by clip scrub), rushers sprint via the in-place run clip (>2.2 m/s), clip
priority death>melee>hit>locomotion on a two-slot overlay layer. New
events: enemy:spawned / enemy:melee / wave:cleared. Real cat vocals:
6 MP3 samples decode after gesture-unlock, ±3% detune, 250ms throttle,
synth fallbacks kept — windup chirp, death yowl (layered), heavy spawn
growl, melee meow (every 3rd a hiss), victory meow on wave clear. Sniper
scope: mil-spec star reticle (mil-dot arms, 45° star, outlined for bright
sky). Viewmodels shrunk ~23% + inward yaw — barrel now points at the
crosshair. Gates: tsc 0 (both tsconfigs), build green, loop 14/14 ×2,
perf no regression (orbit p95 17.3 vs 18.1 baseline; combat identical).
Needs one human pass: run-clip foot-slide feel + sound mix levels.

## Combat Wave 3 (2026-08-09) — GLB integration (the visual transformation)

Real gun viewmodels (rifle/shotgun/sniper GLBs; per-gun transforms
data-driven in WeaponConfig.viewModel, ADS re-centered by zeroing per-gun
x; shotgun ADS pitched 0.38 to fight its thin-cylinder silhouette — known
compromise). Arena dressed: 2 wall posters (a caught-and-fixed async temp-
quaternion bug had one facing into the wall), 2 sandbag stacks + 2 ammo
crates with synchronous colliders. Enemies are now SkeletonUtils clones of
the rigged cat soldier: master mesh from catsoldier.glb + walk/idle clips
retargeted from the proxy-mesh clip files (spec deviation, correct — clip
files carry low-poly proxies), scale contract head-centre→0.95 (measured
0.8513, baseScale 1.1159), mixer walk/idle crossfade on displacement,
windup eye-flare via bone-parented emissive spheres, archetype tints
(gunner brown/heavy slate — tint must multiply emissive too, the GLB is
self-lit). Three real bugs fixed by the builder's screenshot loop
(three/addons double-bundle broke instanceof; tint invisible; cm-scale
bones shrank eyes 100×). Gates: tsc 0, build green, loop 14/14 ×2 (hitbox
math intact), combat draws 255→120. Over-budget notes: combat tris 524.9k
vs 500k (~5%) and p95 ~4-9% over — cat remesh (25.9k→~10k tris) queued as
a pure asset swap; viewmodel scale polish queued.

## Combat Wave 2 (2026-08-09) — loot drops + honest visual QA

Pickups (`gameplay/Pickups.ts`): 30% drop on kill, health (+25, only when
hp<70 at roll / hp<100 to collect) or ammo (one mag of the active gun, only
when reserve below start-cap), pooled ×16, bloom-lit octahedrons, 2m magnet
0.6m collect, useless pickups stay inert, 20s despawn with blink, synth
collect ding (ammo a fifth up). Freeze-safe for the harness; restart clears.
Gates: tsc 0, build green, loop 14/14 ×2.

**Visual QA verdict (screenshots, eyeballed — the honest part):** the
procedural cats read as blobby bowling pins up close; heavy's helmet plate
floats above the head; vest arm-box artifact on rusher. Functional layer
(walk desync, telegraphs, per-type palette) works, silhouettes don't.
Superseded by the generated-GLB cat path below rather than polished.
Perf finding: in-combat draws hit 232–305 vs 150 budget (7 casters/cat ×
CSM) → shadow-caster trim to torso+head landed; orbit-mode p95 miss in the
same gate run attributed to parallel Playwright contention (identical
draws/tris/heap vs the 9.2ms run earlier) — re-verify serialized.

## Generated-asset pipeline (2026-08-09) — Higgsfield → GLB

M4/M6's asset blockade is broken without the human download: images
generated on the project owner's Higgsfield account (Recraft V4.1 utility
for product shots, Nano Banana for the character), lifted to GLB via Meshy
image-to-3D (textured + PBR). Landed in `public/assets/gen/`, logged in
CREDITS.md: PAWS-15 / SCRATCH-12 / LONGWHISKER viewmodel meshes, sandbag +
ammo-crate props, two parody propaganda posters (ENLIST MEOW! / LOOSE
WHISKERS SINK SHIPS), and an auto-rigged bipedal cat soldier (A-pose,
skeleton baked). Walk (clip 30) + idle (clip 0) animation variants baking
server-side. Render-inspection of all six GLBs in progress before any
integration; guns/props/posters integrate first, cat swap only if the rig
passes eyeball QA. ~185 credits spent of 2,395.

Three enemy archetypes, data-driven in `enemies/EnemyConfig.ts` (same typed-TS
pattern as WeaponConfig): **RUSHER** (fast melee), **GUNNER** (holds ~7m,
strafes, 0.45s eye-flare + chirp telegraph, then a 3-shot burst of dodgeable
14m/s glowing projectiles — deliberately not hitscan: seeing death coming is
the fairness contract), **HEAVY** (260hp, 1.35× scale, 25dmg claw, ×2 score).
Deterministic wave composition (gunners at 3, first heavy at 5, field cap 8);
waves 1–2 stay pure base rushers so harness aim math holds. Projectiles:
pooled 64, allocation-free, level-geometry LoS + collision, bloom-registered;
damage wedge points at the shooter. All cats now push out of static colliders
(no more pillar clipping). CatVisual rewritten: articulated 7-mesh procedural
cats — diagonal-trot gait, tail sway, windup crouch+flare, keel-over death —
with silhouette identity (gunner shoulder-blaster, heavy helmet plate).
Arena: NE raised platform (1.2m, two 0.3m-step stairs — autostep climbs
them) + two angled waist-high cover walls; spawn ring/sightline verified
clear. HUD: killfeed archetype names, per-type minimap tints. Audio: windup
chirp + fired zap (synth, original). Gates: tsc 0, build green, loop 14/14
×2, perf 83 draws / 13.4k tris / p95 9.2ms / heap Δ 0.

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

## M3 — Weapons (2026-07-28 overnight autopilot)

Data-driven loadout in `weapons/WeaponConfig.ts` (typed TS data module — the
judgment call vs raw JSON; same declarative shape, compiler-guarded):
**PAWS-15** (auto 600rpm, learnable rise-right recoil pattern, tracers),
**SCRATCH-12** (8×14 pellets — a clean point-blank blast one-pulls a base cat;
12dmg left 4hp survivors, probe-caught), **LONGWHISKER** (105dmg, ADS-gated,
scope overlay, penetrates one surface). Per-gun: 2D recoil patterns with
spring recovery (additive — aim returns), cone spread per pellet, distance
falloff, ADS FOV/time, reload, switch dip (1/2/3), positional sway + idle
breathing, shells/tracers/decals (all pooled, allocation-free), per-gun synth
shot flavours. Sniper at full ADS hides the viewmodel and shows a HUD scope
(the centered gun otherwise sat inside the near plane — screenshot-caught).

## M5 — HUD + feedback polish

Killfeed (weapon ▸ victim, HS-flagged), minimap (player arrow + hostile
dots), damage-direction wedge that tracks the attacker as you turn, delayed
hp damage-trail, low-health vignette + synth heartbeat (cadence rises as hp
falls), headshot hitmarker (X snaps 45°), ammo tick-pop. Harness hardening:
aimed-shot steps now use physics-raycast LoS-verified shooter placement
(pillar-clip flake class eliminated — 14/14 ×3 consecutive).

## M7 — Game loop

DEPLOY/RESUME menu over the idling arena with settings — sensitivity, FOV,
quality (AUTO + 5 fixed tiers, macOS segmented), volume — persisted to
localStorage with validation. Score system: 100/kill ×1.5 headshot × combo
(chain kills within 4s, ×1..8), accuracy tracking, K.I.A. stats card (score/
best/kills/wave/accuracy), best-score persistence. R still restarts in place.

## M8 — Polish (partial, continues after M4/M6)

Damage screen-shake (decaying jitter on punch/bob channels — never touches
aim), 40ms hit-stop on kills (physics accumulator freezes, camera stays
live, dropped time never replayed). Shader pre-compile at boot kills the
first-shot hitch. Full battery green: loop 14/14, perf p95 9.8ms / p99
10.3ms / 70 draws / 2.8k tris / heap Δ 0, latency p95 1.1ms.

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
