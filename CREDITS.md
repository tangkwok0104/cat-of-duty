# Asset Credits

Nothing here is copied from Call of Duty or any other commercial game. Log
every asset here as it is added.

Two groups, and they carry different terms — see
[`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md) for the full statement:

- **Poly Haven textures + HDRI — CC0**, free to reuse.
- **Everything under `public/assets/gen/` — generated on the project owner's
  own accounts, rights reserved.** Not covered by the repository's code
  license and not offered for reuse.

| Asset | Type | Source | License |
|---|---|---|---|
| `kloppenheim_06_puresky_1k.hdr` | HDRI environment | https://polyhaven.com/a/kloppenheim_06_puresky | CC0 |
| `concrete_floor_worn_001` (diff/nor_gl/rough/ao 1k) | PBR texture set (floor) | https://polyhaven.com/a/concrete_floor_worn_001 | CC0 |
| `plastered_wall` (diff/nor_gl/rough/ao 1k) | PBR texture set (walls/pillars) | https://polyhaven.com/a/plastered_wall | CC0 |
| `worn_planks` (diff/nor_gl/rough/ao 1k) | PBR texture set (crates) | https://polyhaven.com/a/worn_planks | CC0 |
| `public/assets/gen/posters/enlist-meow.png` | Wall poster (parody propaganda) | Generated via Higgsfield (Recraft V4.1) on project owner's account, 2026-08-09 | Original generated content |
| `public/assets/gen/posters/loose-whiskers.png` | Wall poster (parody propaganda) | Generated via Higgsfield (Recraft V4.1) on project owner's account, 2026-08-09 | Original generated content |
| `public/assets/gen/models/shotgun.glb` | SCRATCH-12 viewmodel mesh | Generated via Higgsfield (Recraft V4.1 image → Meshy image-to-3D) on project owner's account, 2026-08-09 | Original generated content |
| `public/assets/gen/models/rifle.glb` | PAWS-15 viewmodel mesh | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/models/sniper.glb` | LONGWHISKER viewmodel mesh | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/models/sandbags.glb` | Arena prop | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/models/crate.glb` | Arena prop (ammo crate) | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/models/catsoldier.glb` | Cat soldier character (auto-rigged) | Generated via Higgsfield (Nano Banana image → Meshy image-to-3D + rigging) on project owner's account, 2026-08-09. Swapped 2026-08-09 for a lower-poly re-export of the same generation (25,866 → 10,417 tris; bones, bbox, clips and 2048px texture verified identical by rig diff). Original 25.9k-tri file preserved in git history. | Original generated content |
| `public/assets/gen/models/catsoldier-walk.glb` | Cat soldier + walk clip (Meshy action 30) | Same pipeline + Meshy 3D-rigging, 2026-08-09 | Original generated content |
| `public/assets/gen/models/catsoldier-idle.glb` | Cat soldier + idle clip (Meshy action 0) | Same pipeline + Meshy 3D-rigging, 2026-08-09 | Original generated content |
| `public/assets/gen/models/catsoldier-death-back.glb` / `-death-fwd.glb` | Death clips (Meshy actions 183/184) | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/models/catsoldier-hit.glb` / `-attack.glb` / `-run.glb` | Hit-react / melee swipe / in-place run clips (Meshy actions 178/96/657) | Same pipeline, 2026-08-09 | Original generated content |
| `public/assets/gen/audio/*.mp3` (6: battle meow, hiss, death yowl, heavy growl, alert chirp, victory meow) | Cat vocal SFX | Generated via Higgsfield (Mirelo text-to-audio) on project owner's account, 2026-08-09 | Original generated content |
| `public/assets/gen/audio/*.mp3` (8: per-gun shots ×4, reload, dryfire, concrete impact, projectile whoosh) | Weapon SFX | Same pipeline, 2026-08-09; the 4 that generated near-silent (shot-smg, reload, impact-concrete, projectile-whoosh) regenerated 2026-08-10 with transient-focused prompts — peaks now −0.6 to −10dBFS (ffmpeg-verified; reload +24dB and impact +14dB normalization applied). SoundBus's decode-time MIN_SAMPLE_PEAK gate + synth fallbacks remain as the safety net. Mix levels still owed one human ear pass. | Original generated content |
| `public/assets/gen/models/smg.glb` | PURR-90 viewmodel mesh | Recraft V4.1 image → Meshy image-to-3D, 2026-08-09 | Original generated content |
| `public/assets/gen/ui/menu-keyart.png` + `logo.svg` | Menu key art + stencil logo | Nano Banana / Recraft V4.1 vector, 2026-08-09 | Original generated content |
| `public/assets/gen/models/paw.glb` | Cat paw + forearm viewmodel grip prop (all 4 guns) | Same pipeline (generated image → Meshy image-to-3D), 2026-08-09 | Original generated content |

> 2026-08-10 payload pass: every model above re-encoded in place (gltf-transform — clip files stripped to skeleton+animation only, meshes meshopt-compressed + quantized, textures resized to 1024 WebP). Same source generations, same licenses; pre-compression originals preserved in git history.
