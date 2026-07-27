# M2 — VERTICAL SLICE

Build the ugliest possible COMPLETE version of Cat of Duty. Every system
present, none of them deep. This is a scope-limited milestone: the risk is
building too much, not too little.

## DEFINITION OF DONE

I load the page. I click to lock the pointer. I see a gun in my hands. A cat
runs at me. I aim at it and shoot. It reacts, then dies. A hit marker and a
sound confirm it. Another cat spawns. If cats reach me I take damage. At zero
health I die and can restart with one key. My kill count is on screen the
whole time.

If any sentence above is untrue, the milestone is not done.

## BUILD THIS

**Weapon (one, no choice yet)**
- Viewmodel: a cat paw holding a rifle, or a placeholder box if no asset is
  in /assets yet. Attached to the camera with position offset. Must be visible.
- Left click fires. Hitscan raycast from camera center. Fire rate ~600 RPM.
- Ammo: 30 mag. R reloads with a 2s timer — no animation, just a timer and a
  HUD state.
- Recoil: camera kicks up on fire, recovers. Simple, not a pattern yet.
- Muzzle flash: a light + a quad, 50ms. Impact: a small particle burst.

**Aiming**
- Right click ADS: FOV lerps from 75 to 55 over 150ms, viewmodel moves to
  center, crosshair hides. That's all ADS means this milestone.
- Crosshair: 4 lines, spreads when moving/firing, tightens when still.

**Cats (enemies)**
- Placeholder is fine: a capsule with ears, or a Quaternius cat if one is in
  /assets. It must read as a cat-shaped thing at 20m.
- Behaviour: spawn at a ring of points, walk straight at the player, avoid
  each other with simple separation. No navmesh, no pathfinding, no cover.
- Health 100. Headshot 2x via a second collider on the head. Flinch on hit.
- On death: fall over or scale to zero with a puff. Despawn after 2s.
- On reaching the player: 10 damage, 1s cooldown.

**Player state**
- Health 100, regenerates after 5s without damage.
- Death: screen desaturates, "PRESS R" appears, R restarts without page reload.

**HUD (functional, not pretty yet)**
- Ammo `30 / 90`, health bar, kill count, crosshair, hitmarker, damage vignette.
- Hitmarker: white X on hit, red X + higher pitch on kill. This is the single
  most important feedback element in the game — get it crisp.

**Spawner**
- 1 cat at a time, then 2, then 3, up to 6. New wave when the field is clear.

## EXPLICITLY OUT OF SCOPE — DO NOT BUILD
Multiple weapons. Weapon switching. Loadout screen. Reload animation. Sprint
mechanics beyond what M1 built. Navmesh or A*. Ragdolls. Minimap. Killfeed.
Menus. Settings screen. Level art. New post-processing. Sound design beyond
one shot / one hit / one kill / one death sound. Adversarial review passes.

Anything on this list that you feel strongly about: write it in PROGRESS.md
under "Deferred" and keep building.

## TIME BOX
If a sub-feature isn't working after two attempts, stub it with the crudest
version that satisfies the definition of done, log it, and move on. A stubbed
death animation is a pass. A missing one is a fail.

## WHEN DONE
Run /review. Then stop — I am going to play this myself before you continue.
