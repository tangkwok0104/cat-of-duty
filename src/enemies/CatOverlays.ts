import {
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Scene,
} from 'three';
import type { CatData, GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import { MAX_FIELD_CATS } from './EnemyConfig';

/** Enemy damage feedback: world-space HP bars above damaged cats, plus
 *  floating damage numbers on hit (playtest ask: headshots weren't reading
 *  as double damage, and there was no health feedback at all).
 *
 *  Purely presentational — owns its own scene objects, reads GameState +
 *  EventBus, writes nothing back (no colliders, no state mutation). Safe to
 *  freeze cats or restart without any special-casing elsewhere.
 *
 *  Both pools are Sprites (auto-billboard toward the camera — zero camera
 *  plumbing needed) with a per-instance CanvasTexture. HP bars redraw their
 *  canvas only when hp actually changes (dirty-flag); damage numbers redraw
 *  once at spawn. Steady combat costs zero canvas work beyond hits landing. */

const MAX_BARS = MAX_FIELD_CATS; // never more cats alive than this at once
const MAX_NUMBERS = 24;

const BAR_CANVAS_W = 64;
const BAR_CANVAS_H = 8;
const BAR_WORLD_W = 0.6;
const BAR_WORLD_H = 0.075;
/** Above the cat's group origin (y=0 ground). Clears the 0.95×scale head
 *  ball + helmet crown (CatVisual's HEAD_HITBOX_Y contract). Same size for
 *  every archetype, including the heavy — the FILL fraction tells the
 *  story, not the bar's footprint. */
const BAR_HEIGHT_ABOVE = 1.25;

/** Matches CatVisual's HEAD_HITBOX_Y — damage numbers spawn from the head
 *  regardless of which part was actually hit (reads cleaner than spawning
 *  low on a leg/torso hit and keeps bursts from tangling in the legs). */
const HEAD_Y = 0.95;

const NUM_CANVAS_W = 128;
const NUM_CANVAS_H = 64;
const NUM_WORLD_W = 0.46;
const NUM_WORLD_H = 0.23;
const NUM_RISE = 0.6; // metres over the float
const NUM_DURATION = 0.7; // seconds
const NUM_FADE_START = 0.6; // fraction of duration where fade-out begins (last 40%)
const NUM_POP_TIME = 0.08; // seconds of the spawn scale-pop
const NUM_JITTER = 0.32; // metres, so a burst doesn't stack into one blob
const HEADSHOT_SCALE = 1.4;
const KILL_SCALE = 1.15; // stacks on top of the headshot scale if both apply

/** Distance compensation: world-space sprites shrink with range, so a hit on
 *  a far cat gave unreadably small feedback (playtest: far hits unreadable).
 *  factor = max(1, dist / DIST_REF) grows the sprite's world scale linearly
 *  past DIST_REF metres, capped per pool so it never overwhelms the frame at
 *  extreme range. Composes multiplicatively with the existing pop/headshot/
 *  kill multipliers — never replaces them. */
const DIST_REF = 9; // metres — factor is 1 (no change) at/inside this range
const NUM_DIST_CAP = 3.2;
const BAR_DIST_CAP = 2.2;

const COLOR_OK = new Color(0x9ee493); // --c-ok
const COLOR_ACCENT = new Color(0xffb02e); // --c-accent
const COLOR_DANGER = new Color(0xff4b3a); // --c-danger
const BAR_BACKING = 'rgba(11, 13, 9, 0.85)'; // --c-bg, near-opaque
const _barColorScratch = new Color(); // hpColor() return value — read immediately, never stored

const NUM_COLOR_BODY = '#e9e6d7'; // --c-text (HUD bone/cream)
const NUM_COLOR_HEAD = '#ffb02e'; // --c-accent
const NUM_COLOR_KILL = '#ff4b3a'; // --c-danger
const NUM_FONT = 'bold 34px "SF Mono", ui-monospace, "Cascadia Mono", Menlo, monospace';
const NUM_STROKE = 'rgba(11, 13, 9, 0.85)'; // dark halo so text reads over bright fur

interface CanvasSprite {
  sprite: Sprite;
  material: SpriteMaterial;
  texture: CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function buildCanvasSprite(w: number, h: number): CanvasSprite {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('CatOverlays: 2D canvas context unavailable');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.visible = false;
  return { sprite, material, texture, canvas, ctx };
}

/** Fraction of max hp → green/amber/red (two-segment lerp through the same
 *  tokens the HUD's own hp readouts use). Returns a shared scratch Color —
 *  callers must read it before the next call, never store the reference. */
function hpColor(frac: number): Color {
  if (frac >= 0.5) return _barColorScratch.copy(COLOR_ACCENT).lerp(COLOR_OK, (frac - 0.5) * 2);
  return _barColorScratch.copy(COLOR_DANGER).lerp(COLOR_ACCENT, frac * 2);
}

/** Plain loop, not Array.find — called from the per-frame bar step, and a
 *  named module function (not an inline arrow) allocates nothing per call. */
function findCatById(cats: CatData[], id: number): CatData | undefined {
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i]!;
    if (c.id === id) return c;
  }
  return undefined;
}

/** Distance-compensation scale factor for a sprite at (x, y, z): 1 (no
 *  change) inside DIST_REF, growing linearly past it and clamped to `cap`
 *  so extreme-range hits don't blow the sprite up past legibility. */
function distFactor(
  viewerX: number,
  viewerY: number,
  viewerZ: number,
  x: number,
  y: number,
  z: number,
  cap: number,
): number {
  const dx = x - viewerX;
  const dy = y - viewerY;
  const dz = z - viewerZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Math.min(cap, Math.max(1, dist / DIST_REF));
}

interface HpBarSlot extends CanvasSprite {
  catId: number; // -1 = free
  lastDrawnHp: number; // NaN = never drawn (forces the first paint)
}

interface DamageSlot extends CanvasSprite {
  active: boolean;
  startedAt: number; // seconds, same clock as frameUpdate's nowS
  baseX: number;
  baseY: number;
  baseZ: number;
  scaleW: number; // pre-pop world width for this instance (varies w/ headshot/kill)
  scaleH: number;
}

export class CatOverlays {
  private readonly group = new Group();
  private readonly bars: HpBarSlot[] = [];
  private readonly barFree: number[] = []; // stack of free slot indices
  private readonly numbers: DamageSlot[] = [];
  private numberCursor = 0;
  private stateRef: GameState | null = null;
  /** Shared clock for spawn timestamps — the same `nowS` every system in
   *  the render loop gets, not a fresh performance.now() call, so a number
   *  spawned mid-frame (during WeaponSystem's fixedStep) never reads a
   *  negative age against this frame's frameUpdate. */
  private lastFrameNowS = 0;

  constructor(scene: Scene) {
    for (let i = 0; i < MAX_BARS; i++) {
      const cs = buildCanvasSprite(BAR_CANVAS_W, BAR_CANVAS_H);
      cs.sprite.scale.set(BAR_WORLD_W, BAR_WORLD_H, 1);
      this.group.add(cs.sprite);
      this.bars.push({ ...cs, catId: -1, lastDrawnHp: Number.NaN });
      this.barFree.push(i);
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const cs = buildCanvasSprite(NUM_CANVAS_W, NUM_CANVAS_H);
      this.group.add(cs.sprite);
      this.numbers.push({
        ...cs,
        active: false,
        startedAt: 0,
        baseX: 0,
        baseY: 0,
        baseZ: 0,
        scaleW: NUM_WORLD_W,
        scaleH: NUM_WORLD_H,
      });
    }
    scene.add(this.group);

    bus.on('enemy:hit', ({ id, part, damage, killed }) => {
      const state = this.stateRef;
      if (!state) return;
      const cat = state.cats.find((c) => c.id === id);
      if (!cat) return;
      this.spawnDamageNumber(cat.x, cat.y + HEAD_Y * cat.scale, cat.z, damage, part === 'head', killed);
    });
    bus.on('game:restart', () => this.restart());
  }

  frameUpdate(state: GameState, nowS: number): void {
    this.stateRef = state;
    this.lastFrameNowS = nowS;
    // Viewer = capsule center + eye offset (matches CatSystem's own LoS-eye
    // computation) — read-only, same fields, no interpolation needed for a
    // per-frame scale factor.
    const p = state.player;
    const viewerX = p.currX;
    const viewerY = p.currY + p.eyeOffset;
    const viewerZ = p.currZ;
    this.stepBars(state, viewerX, viewerY, viewerZ);
    this.stepNumbers(nowS, viewerX, viewerY, viewerZ);
  }

  private stepBars(state: GameState, viewerX: number, viewerY: number, viewerZ: number): void {
    // Release bars whose cat no longer needs one (dead, despawned, or —
    // this game has no heal, but the check costs nothing — back to full).
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i]!;
      if (bar.catId === -1) continue;
      const cat = findCatById(state.cats, bar.catId);
      if (!cat || cat.phase !== 'alive' || cat.hp >= cat.maxHp) {
        bar.catId = -1;
        bar.sprite.visible = false;
        this.barFree.push(i);
        continue;
      }
      const barY = cat.y + BAR_HEIGHT_ABOVE * cat.scale;
      bar.sprite.position.set(cat.x, barY, cat.z);
      const factor = distFactor(viewerX, viewerY, viewerZ, cat.x, barY, cat.z, BAR_DIST_CAP);
      bar.sprite.scale.set(BAR_WORLD_W * factor, BAR_WORLD_H * factor, 1);
      if (cat.hp !== bar.lastDrawnHp) {
        this.drawBar(bar, cat.hp / cat.maxHp);
        bar.lastDrawnHp = cat.hp;
      }
    }
    // Claim a bar for any newly-damaged cat that doesn't have one yet. The
    // pool is sized to MAX_FIELD_CATS, so this can never run dry.
    for (const cat of state.cats) {
      if (cat.phase !== 'alive' || cat.hp >= cat.maxHp || cat.hp <= 0) continue;
      let hasBar = false;
      for (const bar of this.bars) {
        if (bar.catId === cat.id) {
          hasBar = true;
          break;
        }
      }
      if (hasBar) continue;
      const slotIndex = this.barFree.pop();
      if (slotIndex === undefined) continue; // shouldn't happen at the field cap
      const bar = this.bars[slotIndex]!;
      bar.catId = cat.id;
      bar.sprite.visible = true;
      const barY = cat.y + BAR_HEIGHT_ABOVE * cat.scale;
      bar.sprite.position.set(cat.x, barY, cat.z);
      const factor = distFactor(viewerX, viewerY, viewerZ, cat.x, barY, cat.z, BAR_DIST_CAP);
      bar.sprite.scale.set(BAR_WORLD_W * factor, BAR_WORLD_H * factor, 1);
      bar.lastDrawnHp = Number.NaN;
      this.drawBar(bar, cat.hp / cat.maxHp);
      bar.lastDrawnHp = cat.hp;
    }
  }

  private drawBar(bar: HpBarSlot, frac: number): void {
    const ctx = bar.ctx;
    ctx.clearRect(0, 0, BAR_CANVAS_W, BAR_CANVAS_H);
    ctx.fillStyle = BAR_BACKING;
    ctx.fillRect(0, 0, BAR_CANVAS_W, BAR_CANVAS_H);
    const pad = 1;
    const innerW = BAR_CANVAS_W - pad * 2;
    const innerH = BAR_CANVAS_H - pad * 2;
    const clamped = Math.min(1, Math.max(0, frac));
    const c = hpColor(clamped);
    ctx.fillStyle = `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
    ctx.fillRect(pad, pad, innerW * clamped, innerH);
    bar.texture.needsUpdate = true;
  }

  private spawnDamageNumber(
    x: number,
    y: number,
    z: number,
    damage: number,
    headshot: boolean,
    killed: boolean,
  ): void {
    const slot = this.numbers[this.numberCursor]!;
    this.numberCursor = (this.numberCursor + 1) % this.numbers.length;

    let color = NUM_COLOR_BODY;
    let scaleMult = 1;
    if (headshot) {
      color = NUM_COLOR_HEAD;
      scaleMult *= HEADSHOT_SCALE;
    }
    if (killed) {
      color = NUM_COLOR_KILL;
      scaleMult *= KILL_SCALE;
    }
    this.drawNumber(slot, Math.round(damage).toString(), color);

    slot.baseX = x + (Math.random() - 0.5) * NUM_JITTER;
    slot.baseY = y;
    slot.baseZ = z + (Math.random() - 0.5) * NUM_JITTER;
    slot.scaleW = NUM_WORLD_W * scaleMult;
    slot.scaleH = NUM_WORLD_H * scaleMult;
    slot.startedAt = this.lastFrameNowS;
    slot.active = true;
    slot.material.opacity = 1;
    slot.sprite.visible = true;
    slot.sprite.position.set(slot.baseX, slot.baseY, slot.baseZ);
  }

  private drawNumber(slot: DamageSlot, text: string, color: string): void {
    const ctx = slot.ctx;
    ctx.clearRect(0, 0, NUM_CANVAS_W, NUM_CANVAS_H);
    ctx.font = NUM_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = NUM_STROKE;
    ctx.strokeText(text, NUM_CANVAS_W / 2, NUM_CANVAS_H / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, NUM_CANVAS_W / 2, NUM_CANVAS_H / 2);
    slot.texture.needsUpdate = true;
  }

  private stepNumbers(nowS: number, viewerX: number, viewerY: number, viewerZ: number): void {
    for (const slot of this.numbers) {
      if (!slot.active) continue;
      const t = nowS - slot.startedAt;
      if (t >= NUM_DURATION) {
        slot.active = false;
        slot.sprite.visible = false;
        continue;
      }
      const p = t / NUM_DURATION;
      const eased = 1 - (1 - p) * (1 - p) * (1 - p); // ease-out cubic
      const y = slot.baseY + NUM_RISE * eased;
      slot.sprite.position.set(slot.baseX, y, slot.baseZ);

      const pop = t < NUM_POP_TIME ? 0.7 + 0.3 * (t / NUM_POP_TIME) : 1;
      const factor = distFactor(viewerX, viewerY, viewerZ, slot.baseX, y, slot.baseZ, NUM_DIST_CAP);
      slot.sprite.scale.set(slot.scaleW * pop * factor, slot.scaleH * pop * factor, 1);

      slot.material.opacity =
        p > NUM_FADE_START ? Math.max(0, 1 - (p - NUM_FADE_START) / (1 - NUM_FADE_START)) : 1;
    }
  }

  private restart(): void {
    this.barFree.length = 0;
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i]!;
      bar.catId = -1;
      bar.lastDrawnHp = Number.NaN;
      bar.sprite.visible = false;
      this.barFree.push(i);
    }
    for (const slot of this.numbers) {
      slot.active = false;
      slot.sprite.visible = false;
    }
  }
}
