# Cat of Duty — Brand

Independent project brand (not 67Lab DNA). Direction chosen at M0 and enforced
for the project's lifetime. Tokens live in `src/ui/tokens.css` — components
reference tokens, never raw values.

## Direction: "Mil-Spec, With a Wink"

A parody military shooter that plays its chrome straight. The UI looks like
genuine tactical equipment — stencil headings, mono data readouts, amber
phosphor accents — and lets the cats be the joke. We never wink twice: no
comic fonts, no cartoon borders, no emoji (SVG icons only, ever).

## Palette

| Token | Value | Use |
|---|---|---|
| `--c-bg` | `#0b0d09` | field black-olive, app background |
| `--c-surface` / `--c-surface-2` | `#131610` / `#1b1f16` | panels, elevation steps |
| `--c-text` | `#e9e6d7` | bone — primary text |
| `--c-muted` | `#8f947c` | sage — labels, secondary |
| `--c-accent` | `#ffb02e` | tactical amber — data, highlights, energy |
| `--c-danger` | `#ff4b3a` | alert red — damage, warnings |
| `--c-ok` | `#9ee493` | confirm green — sparingly |

Amber is the voice of the interface; red is reserved for consequence. Never
use amber and red at equal weight in one component.

## Type

- **Display** (`--font-display`): condensed grotesque, wide letterspacing
  (0.15–0.42em), uppercase. Titles, headings, big numbers.
- **HUD/data** (`--font-hud`): monospace, tabular numerals. Readouts, stats,
  ammo, timers.
- Scale is a minor third (`--fs-xs` … `--fs-display`). No off-scale sizes.

## Chrome

- Panels: `--panel-bg` (55% black-olive) + `backdrop-filter: blur(6px)` +
  1px amber border at 15% — readable on bright sky and dark corners alike.
  Never solid opaque slabs.
- Spacing: 8px grid (`--s1`…`--s6`), 4px half-step allowed (`--s05`).
- Radius: 3px. Military equipment is not rounded.
- Motion: `--ease-out` for entrances, `--ease-snap` for feedback hits;
  transform/opacity only. 120/260/600ms tiers.

## In-world accents

Emissive amber strip-lights and red signal panels are the in-world extension
of the palette — the world and the HUD share one color language.
