# SELF-REVIEW PROTOCOL

## 1. BUILD
`npm run build` and `npx tsc --noEmit`. Zero errors, zero warnings.

## 2. RUNTIME
Load headless via Playwright. Zero console errors, zero unhandled rejections,
zero failed requests. Fix before continuing.

## 3. SEE YOUR OWN WORK
Run scripts/capture.ts — 1920x1080 PNGs to /screenshots/M<n>/ at the vantage
points in scripts/shots.json, plus one mid-combat frame.

OPEN AND LOOK AT every PNG. Critique each: lighting blown or crushed?
Materials flat? HUD readable against the scene? Silhouettes legible?
Would this embarrass you in a portfolio? Fix the top 3 issues, re-capture.

## 4. INPUT LATENCY  (from M1 onward — non-negotiable)
Timestamp each pointermove; timestamp the frame that first reflects it.
Report p50 / p95 input-to-render latency. Budget: p95 under 20ms.
Confirm in writing: no mouse smoothing, no acceleration, no rotation
interpolation. Camera delta = mouse delta x sensitivity, same frame.

## 5. PERFORMANCE
scripts/perf.ts — 600 frames of gameplay-like motion.
Report avg / p95 / p99 frame time, frame-time variance, draw calls, triangles,
JS heap growth after warmup.
Budget: p95 under 16.6ms, p99 under 25ms, <150 draws, <500k tris, zero heap
growth. State explicitly which hardware this ran on.

## 6. LOOP INTEGRITY  (from M2 onward)
Drive the full loop via Playwright input: lock pointer, move, fire, kill a cat,
take damage, die, restart. Assert each step actually happened by reading game
state, not by assuming. Any step that can't be asserted is a failing step.

## 7. ACCEPTANCE TABLE
Every requirement of the milestone as a line item: PASS / PARTIAL / MISSING.
List the partials and missings by name with one line on what's absent.
No optimistic grading.

## 8. REPORT — exactly this, nothing more

  MILESTONE: M<n>
  STATUS: <complete | blocked>
  BUILD: <clean | n errors>
  INPUT LATENCY: <p50>/<p95>ms — smoothing: <none | describe>
  PERF: <avg>/<p95>/<p99>ms, var <n>, <n> draws, <n> tris — on <hardware>
  LOOP INTEGRITY: <n>/<n> steps asserted
  ACCEPTANCE: <n> pass / <n> partial / <n> missing
    PARTIAL: <name — what's missing>
    MISSING: <name — why>
  SCREENSHOTS: /screenshots/M<n>/ — <one line verdict>
  FIXED THIS PASS: <bullets>
  KNOWN ISSUES: <bullets or "none">
  DECISIONS MADE: <bullets, each with the alternative rejected>
  DEFERRED: <bullets — things I wanted to build but didn't>
  NEXT: <first task of M<n+1>>

Then STOP.
