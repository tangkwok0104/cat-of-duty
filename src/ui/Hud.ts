import type { GameState, CatArchetype } from '../core/GameState';
import { bus } from '../core/EventBus';
import { ARCHETYPES } from '../enemies/EnemyConfig';
import { WEAPONS } from '../weapons/WeaponConfig';
import { effectiveMaxHp } from '../player/Health';

const REFRESH_MS = 100;
// Minimap world→pixel: half-extent of the play area plus a small margin so
// wall-hugging dots don't clip the map edge. Bump this one number when the
// arena resizes again.
const MM_HALF_EXTENT = 19.5;
const MM_SCALE = 148 / (MM_HALF_EXTENT * 2);

// Original cat-parody streak labels — approved copy, exact strings.
const STREAK_LABELS: Record<1 | 2 | 3, string> = {
  1: 'DOUBLE SWAT',
  2: 'CLAW FRENZY',
  3: 'APEX PREDATOR',
};

type PromoId = 'claws' | 'pockets' | 'lives';

// Promotion chip catalog for display only — key hint, label, and per-level
// cost. These 9 numbers duplicate the economy spec (the purchase logic that
// actually spends TUNA lives elsewhere); if the schedule ever changes, keep
// both in sync. Max level 3 for all three.
const PROMO_CATALOG: {
  id: PromoId;
  key: string;
  label: string;
  levelKey: 'clawsLvl' | 'pocketsLvl' | 'livesLvl';
  costs: readonly [number, number, number];
}[] = [
  { id: 'claws', key: 'Z', label: 'CLAW SHARPENING', levelKey: 'clawsLvl', costs: [50, 75, 100] },
  { id: 'pockets', key: 'X', label: 'DEEP POCKETS', levelKey: 'pocketsLvl', costs: [40, 60, 80] },
  { id: 'lives', key: 'V', label: 'NINE LIVES', levelKey: 'livesLvl', costs: [60, 90, 120] },
];

/** Slice HUD: crosshair with live spread, ammo, health bar, kills/wave,
 *  hitmarker (white hit / red kill), damage vignette, death screen.
 *  DOM + tokens; every animation is transform/opacity only. */
export class Hud {
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private lastRefresh = 0;
  private spread = 8; // px, eased toward target
  private vignette = 0; // 0..1 eased out
  private lastAmmoText = '';
  private lastHpWidth = -1;
  private scopedShown = false;
  private hpTrail = 100; // delayed damage trail (eases down after hits)
  private weaponName = 'PAWS-15';
  private lowHpShown = -1;
  // Damage direction: attacker position + remaining display time.
  private dmgFromX = 0;
  private dmgFromZ = 0;
  private dmgTtl = 0;
  // Intermission banner: countdown is derived from a stored deadline each
  // throttled refresh — no setInterval, no per-tick event spam.
  private breatherDeadline = 0;
  private breatherWave = 0;

  constructor() {
    const root = document.getElementById('hud-root');
    if (!root) throw new Error('hud-root missing');
    this.root = root;
    this.build();

    bus.on('enemy:hit', ({ killed, part }) => {
      this.hitmarker(killed, part === 'head');
    });
    // Killfeed reads the victim's name off enemy:killed — the cat may
    // already be gone from state.cats by the time the entry renders.
    bus.on('enemy:killed', ({ archetype, headshot }) => this.killfeed(archetype, headshot));
    bus.on('weapon:switched', ({ name }) => {
      this.weaponName = name;
      const el = this.els['weapon-name'];
      if (el) el.textContent = name;
      // Chip owned/active states refresh from GameState in frame() — the
      // slot event alone can't know ownership.
    });
    bus.on('weapon:acquired', ({ slot, name }) => this.acquireToast(slot, name));
    bus.on('player:damaged', ({ fromX, fromZ }) => {
      this.vignette = 1;
      this.dmgFromX = fromX;
      this.dmgFromZ = fromZ;
      this.dmgTtl = 1.2;
    });
    bus.on('player:died', () => this.setDead(true));
    bus.on('game:restart', () => this.setDead(false));
    bus.on('wave:started', ({ wave, special }) => {
      this.waveToast(wave, special);
      this.hideBreather();
    });
    bus.on('wave:cleared', ({ wave, breatherS }) => this.showBreather(wave, breatherS));
    // Fires only on tier RISE (never per kill) — no debounce/queue needed,
    // the pop just plays immediately on each rise within the combo window.
    bus.on('score:streak', ({ tier, combo }) => this.streakPop(tier, combo));
    // Promotion chips: purchase flashes the chip, denial shakes it. The pip
    // fill / cost / affordability text itself refreshes off GameState in the
    // throttled frame() block — same idiom as the arsenal pips above.
    bus.on('upgrade:purchased', ({ id }) => this.flashPromoChip(id));
    bus.on('upgrade:denied', ({ id }) => this.denyPromoChip(id));
  }

  private build(): void {
    const make = (id: string, cls: string, parent: HTMLElement): HTMLElement => {
      const el = document.createElement('div');
      el.id = id;
      el.className = cls;
      parent.append(el);
      this.els[id] = el;
      return el;
    };

    // Crosshair: 4 lines around centre, spread via CSS var.
    const cross = make('crosshair', 'crosshair', this.root);
    for (const dir of ['t', 'b', 'l', 'r']) {
      const line = document.createElement('span');
      line.className = `cross-line cross-${dir}`;
      cross.append(line);
    }

    // Hitmarker X.
    const marker = make('hitmarker', 'hitmarker', this.root);
    marker.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5 5 L10 10 M19 5 L14 10 M5 19 L10 14 M19 19 L14 14" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';

    // Bottom-left: health (trail layer eases down behind the live fill).
    const health = make('hud-health', 'hud-health', this.root);
    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    const trail = document.createElement('div');
    trail.className = 'hp-trail';
    const fill = document.createElement('div');
    fill.className = 'hp-fill';
    bar.append(trail, fill);
    health.append(bar);
    this.els['hp-fill'] = fill;
    this.els['hp-trail'] = trail;

    // Minimap: bottom-left above health; player arrow + hostile dots.
    const minimap = make('minimap', 'minimap', this.root);
    const arrow = document.createElement('div');
    arrow.className = 'mm-player';
    minimap.append(arrow);
    this.els['mm-player'] = arrow;
    for (let i = 0; i < 8; i++) {
      const dot = document.createElement('div');
      dot.className = 'mm-cat';
      minimap.append(dot);
      this.els[`mm-cat-${i}`] = dot;
    }

    // Damage direction wedge (rotates around the crosshair).
    const dmg = make('dmg-dir', 'dmg-dir', this.root);
    dmg.innerHTML =
      '<svg viewBox="0 0 40 40" aria-hidden="true">' +
      '<path d="M20 2 L27 12 L13 12 Z" fill="currentColor"/></svg>';

    // Kill-chain streak pop: centered below the crosshair, above the
    // killfeed's vertical band. Text is set per-fire in streakPop().
    make('streak-pop', 'streak-pop', this.root);

    // Low-health vignette (persistent while wounded) + killfeed column.
    make('lowhp-vignette', 'lowhp-vignette', this.root);
    make('killfeed', 'killfeed', this.root);

    // Bottom-right: weapon name + slot chips + ammo. Chips carry arsenal
    // state: owned = lit, active = accent, unowned = dimmed hint.
    const weaponRow = make('hud-weapon', 'hud-weapon', this.root);
    const wName = document.createElement('span');
    wName.className = 'weapon-name';
    const pips = document.createElement('span');
    pips.className = 'weapon-pips';
    for (let i = 0; i < WEAPONS.length; i++) {
      const pip = document.createElement('span');
      pip.className = 'weapon-pip';
      pip.textContent = String(i + 1);
      pips.append(pip);
      this.els[`pip-${i}`] = pip;
    }
    weaponRow.append(wName, pips);
    this.els['weapon-name'] = wName;

    const ammo = make('hud-ammo', 'hud-ammo', this.root);
    const mag = document.createElement('span');
    mag.className = 'ammo-mag';
    const reserve = document.createElement('span');
    reserve.className = 'ammo-reserve';
    ammo.append(mag, reserve);
    this.els['ammo-mag'] = mag;
    this.els['ammo-reserve'] = reserve;
    const reload = make('hud-reload', 'hud-reload', this.root);
    reload.textContent = 'REARMING';
    // Sits in the same slot as #hud-reload — never shown together (REARMING
    // only plays while w.reloading is true; this only plays while ammo===0
    // && !reloading), so sharing the position is safe and keeps the prompt
    // right where the player's eye already is.
    make('hud-reload-prompt', 'hud-reload-prompt', this.root);

    // Top-right: kills + wave + TUNA (upgrade currency, wave 8 economy).
    const score = make('hud-score', 'hud-score', this.root);
    const kills = document.createElement('div');
    kills.className = 'score-kills';
    const wave = document.createElement('div');
    wave.className = 'score-wave';
    const tuna = document.createElement('div');
    tuna.className = 'score-tuna';
    score.append(kills, wave, tuna);
    this.els['score-kills'] = kills;
    this.els['score-wave'] = wave;
    this.els['score-tuna'] = tuna;

    make('wave-toast', 'wave-toast', this.root);
    make('acquire-toast', 'acquire-toast', this.root);
    // Persistent breather countdown — distinct lifecycle from wave-toast
    // (that one fires-and-fades; this one lives for the whole breather).
    make('intermission-banner', 'intermission-banner', this.root);

    // Promotion chips: a sibling of the banner, not a child — the banner's
    // countdown text is set via .textContent each throttled tick, which
    // would wipe any children living inside it. Shown/hidden together with
    // the banner (see showBreather/hideBreather); pip fill + cost text +
    // afford state refresh from GameState every throttled frame.
    const chips = make('promo-chips', 'promo-chips', this.root);
    for (const def of PROMO_CATALOG) {
      const chip = document.createElement('div');
      chip.className = 'promo-chip';
      const top = document.createElement('div');
      top.className = 'promo-chip-top';
      const key = document.createElement('span');
      key.className = 'promo-key';
      key.textContent = `[${def.key}]`;
      const label = document.createElement('span');
      label.className = 'promo-label';
      label.textContent = def.label;
      const sep = document.createElement('span');
      sep.className = 'promo-sep';
      sep.textContent = '·'; // middle dot
      const cost = document.createElement('span');
      cost.className = 'promo-cost';
      cost.textContent = String(def.costs[0]);
      top.append(key, label, sep, cost);
      const pipsRow = document.createElement('div');
      pipsRow.className = 'promo-pips';
      for (let i = 0; i < 3; i++) {
        const pip = document.createElement('span');
        pip.className = 'promo-pip';
        pipsRow.append(pip);
        this.els[`promo-${def.id}-pip-${i}`] = pip;
      }
      chip.append(top, pipsRow);
      chips.append(chip);
      this.els[`promo-${def.id}`] = chip;
      this.els[`promo-${def.id}-cost`] = cost;
    }

    make('damage-vignette', 'damage-vignette', this.root);

    // Sniper scope overlay: circular mask + star reticle, shown when scoped.
    // Crosshair arms + mil-dot ticks stay inside the glass radius (r=31,
    // matches .scope-mask's fade) so nothing pokes onto the black vignette.
    // Every stroke is drawn twice — a wider --c-bg backer under a thinner
    // --c-text line on top — so the reticle reads on bright sky.
    const scope = make('scope-overlay', 'scope-overlay scope-hidden', this.root);
    const reticleArms =
      'M50 21 V45.5 M50 54.5 V79 M21 50 H45.5 M54.5 50 H79 ' +
      'M48.6 41H51.4 M48.6 34H51.4 M48.6 27H51.4 ' +
      'M48.6 59H51.4 M48.6 66H51.4 M48.6 73H51.4 ' +
      'M41 48.6V51.4 M34 48.6V51.4 M27 48.6V51.4 ' +
      'M59 48.6V51.4 M66 48.6V51.4 M73 48.6V51.4';
    const starPoints =
      '51,50 52.263,52.263 50,51 47.737,52.263 49,50 47.737,47.737 50,49 52.263,47.737';
    scope.innerHTML =
      '<div class="scope-mask"></div>' +
      '<svg class="scope-reticle" viewBox="0 0 100 100" aria-hidden="true">' +
      '<circle class="scope-rim scope-outline" cx="50" cy="50" r="31" fill="none" stroke-width="0.7"/>' +
      `<path class="scope-outline" d="${reticleArms}" stroke-width="0.62" stroke-linecap="butt"/>` +
      '<circle class="scope-rim scope-ink" cx="50" cy="50" r="31" fill="none" stroke-width="0.35"/>' +
      `<path class="scope-ink" d="${reticleArms}" stroke-width="0.3" stroke-linecap="butt"/>` +
      `<polygon class="scope-star" points="${starPoints}"/>` +
      '</svg>';

    // Death screen with end-of-run stats.
    const death = make('death-screen', 'death-screen hidden-death', this.root);
    death.innerHTML =
      '<div class="death-title">K.I.A.</div>' +
      '<div class="death-stats">' +
      '<div class="ds-row"><span>SCORE</span><span id="ds-score">0</span></div>' +
      '<div class="ds-row"><span>BEST</span><span id="ds-best">0</span></div>' +
      '<div class="ds-row"><span>KILLS</span><span id="ds-kills">0</span></div>' +
      '<div class="ds-row"><span>WAVE REACHED</span><span id="ds-wave">0</span></div>' +
      '<div class="ds-row"><span>ACCURACY</span><span id="ds-acc">0%</span></div>' +
      '</div>' +
      '<div class="death-sub">PRESS R TO REDEPLOY</div>';
    for (const id of ['ds-score', 'ds-best', 'ds-kills', 'ds-wave', 'ds-acc']) {
      const el = death.querySelector(`#${id}`);
      if (el instanceof HTMLElement) this.els[id] = el;
    }
  }

  /** Fill the death card the moment the run ends. */
  fillDeathStats(score: number, best: number, kills: number, wave: number, shots: number, hits: number): void {
    const set = (id: string, v: string): void => {
      const el = this.els[id];
      if (el) el.textContent = v;
    };
    set('ds-score', String(score));
    set('ds-best', String(best));
    set('ds-kills', String(kills));
    set('ds-wave', String(wave));
    set('ds-acc', shots > 0 ? `${Math.round((hits / shots) * 100)}%` : '—');
  }

  private hitmarker(kill: boolean, headshot: boolean): void {
    const m = this.els['hitmarker'];
    if (!m) return;
    m.classList.remove('hm-play', 'hm-kill', 'hm-head');
    void m.offsetWidth; // restart the CSS animation
    if (kill) m.classList.add('hm-kill');
    if (headshot) m.classList.add('hm-head'); // rotated X — reads instantly
    m.classList.add('hm-play');
  }

  private killfeed(archetype: CatArchetype, headshot: boolean): void {
    const feed = this.els['killfeed'];
    if (!feed) return;
    const entry = document.createElement('div');
    entry.className = 'kf-entry';
    const weapon = document.createElement('span');
    weapon.className = 'kf-weapon';
    weapon.textContent = this.weaponName;
    const sep = document.createElement('span');
    sep.className = 'kf-sep';
    sep.textContent = headshot ? '⌖' : '▸';
    if (headshot) sep.classList.add('kf-hs');
    const victim = document.createElement('span');
    victim.className = 'kf-victim';
    victim.textContent = ARCHETYPES[archetype].name;
    entry.append(weapon, sep, victim);
    feed.prepend(entry);
    while (feed.children.length > 4) feed.lastChild?.remove();
    setTimeout(() => {
      entry.classList.add('kf-out');
      setTimeout(() => entry.remove(), 400);
    }, 3200);
  }

  /** Pressed the key for a gun not yet found: shake its chip — quiet "not
   *  yours yet" feedback, no error-sound spam (main routes this). */
  denySwitch(slot: number): void {
    const pip = this.els[`pip-${slot}`];
    if (!pip) return;
    pip.classList.remove('pip-deny');
    void pip.offsetWidth; // restart the CSS animation
    pip.classList.add('pip-deny');
  }

  private acquireToast(slot: number, name: string): void {
    const t = this.els['acquire-toast'];
    if (!t) return;
    t.textContent = `${name} ACQUIRED — [${slot + 1}]`;
    t.classList.remove('toast-play');
    void t.offsetWidth;
    t.classList.add('toast-play');
  }

  /** Kill-chain tier rise: legible within a frame of the kill, no queueing —
   *  a fast second rise just restarts the animation on the new text. */
  private streakPop(tier: 1 | 2 | 3, combo: number): void {
    const el = this.els['streak-pop'];
    if (!el) return;
    el.textContent = `${STREAK_LABELS[tier]} ×${combo}`;
    el.classList.remove('pop-play', 'streak-tier-1', 'streak-tier-2', 'streak-tier-3');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(`streak-tier-${tier}`, 'pop-play');
  }

  /** `special` = every-5th heavy-drop wave (pre-announced in wave:started) —
   *  same rise-and-fade toast, danger-red variant with a callout string. */
  private waveToast(wave: number, special: boolean): void {
    const t = this.els['wave-toast'];
    if (!t) return;
    t.textContent = special ? `⚠ HEAVY DROP — WAVE ${wave}` : `WAVE ${wave}`;
    t.classList.toggle('toast-danger', special);
    t.classList.remove('toast-play');
    void t.offsetWidth;
    t.classList.add('toast-play');
  }

  /** Pip fill + next-level cost + afford state, read fresh from GameState
   *  each throttled tick — same "state is truth" idiom as the arsenal pips. */
  private refreshPromoChips(state: GameState): void {
    const tuna = state.upgrades.tuna;
    for (const def of PROMO_CATALOG) {
      const chip = this.els[`promo-${def.id}`];
      const costEl = this.els[`promo-${def.id}-cost`];
      if (!chip || !costEl) continue;
      const lvl = state.upgrades[def.levelKey];
      const maxed = lvl >= 3;
      // lvl is always 0-2 here (maxed is the >=3 case above) so the index is
      // always in range — the `?? 0` only satisfies noUncheckedIndexedAccess,
      // it never actually fires.
      const nextCost = maxed ? 0 : (def.costs[lvl] ?? 0);
      const affordable = !maxed && tuna >= nextCost;
      chip.classList.toggle('promo-maxed', maxed);
      chip.classList.toggle('promo-affordable', affordable);
      chip.classList.toggle('promo-unaffordable', !maxed && !affordable);
      costEl.textContent = maxed ? 'MAX' : String(nextCost);
      for (let i = 0; i < 3; i++) {
        this.els[`promo-${def.id}-pip-${i}`]?.classList.toggle('promo-pip-filled', i < lvl);
      }
    }
  }

  /** Purchase landed: quick accent flash on the chip. */
  private flashPromoChip(id: PromoId): void {
    const chip = this.els[`promo-${id}`];
    if (!chip) return;
    chip.classList.remove('promo-flash');
    void chip.offsetWidth; // restart the CSS animation
    chip.classList.add('promo-flash');
  }

  /** Purchase rejected (no tuna / maxed / intermission closed): reuses the
   *  arsenal chip's deny-shake pattern so the two feedbacks read as one
   *  language. */
  private denyPromoChip(id: PromoId): void {
    const chip = this.els[`promo-${id}`];
    if (!chip) return;
    chip.classList.remove('promo-deny');
    void chip.offsetWidth; // restart the CSS animation
    chip.classList.add('promo-deny');
  }

  /** Field just cleared: arm the countdown and play the banner in. The
   *  number itself is refreshed from breatherDeadline in the throttled
   *  block below — this only handles the show + reappear animation. */
  private showBreather(wave: number, breatherS: number): void {
    this.breatherDeadline = performance.now() + breatherS * 1000;
    this.breatherWave = wave;
    const el = this.els['intermission-banner'];
    if (!el) return;
    el.textContent = `WAVE ${wave} CLEARED — NEXT WAVE IN ${Math.ceil(breatherS)}`;
    el.classList.add('ib-visible');
    el.classList.remove('ib-play');
    void el.offsetWidth; // restart the reappear animation
    el.classList.add('ib-play');
    this.els['promo-chips']?.classList.add('promo-visible');
  }

  private hideBreather(): void {
    this.breatherDeadline = 0;
    this.els['intermission-banner']?.classList.remove('ib-visible');
    this.els['promo-chips']?.classList.remove('promo-visible');
  }

  private setDead(dead: boolean): void {
    this.els['death-screen']?.classList.toggle('hidden-death', !dead);
  }

  /** Per rendered frame (cheap eases) + throttled text refresh. */
  frame(state: GameState, dt: number, now: number): void {
    // Crosshair spread target: base + movement + firing, collapses in ADS.
    const w = state.weapon;
    const moving = state.player.speed2D;
    const sinceShot = now / 1000 - w.lastShotAt;
    const fireBloom = sinceShot < 0.25 ? (0.25 - sinceShot) * 90 : 0;
    const target = state.health.dead
      ? 0
      : Math.max(4, 7 + moving * 2.4 + fireBloom) * (1 - w.ads);
    this.spread += (target - this.spread) * Math.min(1, 18 * dt);
    const cross = this.els['crosshair'];
    if (cross) {
      cross.style.setProperty('--spread', `${this.spread.toFixed(1)}px`);
      cross.style.opacity = w.ads > 0.5 || state.health.dead ? '0' : '1';
    }

    // Scope overlay follows the weapon's scoped flag.
    if (w.scoped !== this.scopedShown) {
      this.scopedShown = w.scoped;
      this.els['scope-overlay']?.classList.toggle('scope-hidden', !w.scoped);
    }

    // Damage vignette ease-out.
    if (this.vignette > 0) {
      this.vignette = Math.max(0, this.vignette - dt * 1.6);
      this.els['damage-vignette']?.style.setProperty(
        'opacity',
        String(this.vignette * 0.85),
      );
    }

    // Health trail: eases down toward the live bar after damage; snaps up
    // on regen (a trail above the bar is meaningless).
    const hp = state.health.hp;
    if (this.hpTrail < hp) this.hpTrail = hp;
    else if (this.hpTrail > hp) this.hpTrail += (hp - this.hpTrail) * Math.min(1, 2.5 * dt);
    this.els['hp-trail']?.style.setProperty('transform', `scaleX(${this.hpTrail / 100})`);

    // Damage direction: track the attacker while the indicator lives (it
    // stays correct as the player turns).
    const dmgEl = this.els['dmg-dir'];
    if (dmgEl && this.dmgTtl > 0) {
      this.dmgTtl -= dt;
      const p = state.player;
      const bearing = Math.atan2(-(this.dmgFromX - p.currX), -(this.dmgFromZ - p.currZ));
      const rel = bearing - p.yaw;
      dmgEl.style.setProperty(
        'transform',
        `translate(-50%, -50%) rotate(${(-rel * 180) / Math.PI}deg)`,
      );
      dmgEl.style.setProperty('opacity', String(Math.min(1, this.dmgTtl * 1.6)));
    } else if (dmgEl && dmgEl.style.opacity !== '0') {
      dmgEl.style.setProperty('opacity', '0');
    }

    // Minimap (throttled with the text refresh below).

    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    // Minimap: arena → 148px square (MM_SCALE/MM_HALF_EXTENT above).
    // Player arrow rotates with yaw.
    const arrow = this.els['mm-player'];
    if (arrow) {
      const mx = (state.player.currX + MM_HALF_EXTENT) * MM_SCALE;
      const mz = (state.player.currZ + MM_HALF_EXTENT) * MM_SCALE;
      arrow.style.setProperty(
        'transform',
        `translate(${mx.toFixed(1)}px, ${mz.toFixed(1)}px) rotate(${((-state.player.yaw * 180) / Math.PI).toFixed(1)}deg)`,
      );
    }
    for (let i = 0; i < 8; i++) {
      const dot = this.els[`mm-cat-${i}`];
      if (!dot) continue;
      const cat = state.cats[i];
      if (cat && cat.phase === 'alive') {
        // Threat tint: rusher neutral, gunner amber, heavy red. Dot slots
        // are reused across cats, so re-check the class each refresh.
        const cls =
          cat.archetype === 'heavy'
            ? 'mm-cat mm-heavy'
            : cat.archetype === 'gunner'
              ? 'mm-cat mm-gunner'
              : 'mm-cat';
        if (dot.className !== cls) dot.className = cls;
        dot.style.setProperty('opacity', '1');
        dot.style.setProperty(
          'transform',
          `translate(${((cat.x + MM_HALF_EXTENT) * MM_SCALE).toFixed(1)}px, ${((cat.z + MM_HALF_EXTENT) * MM_SCALE).toFixed(1)}px)`,
        );
      } else {
        dot.style.setProperty('opacity', '0');
      }
    }

    // Slot chips: owned = lit, active = accent, unowned = dimmed. Read from
    // state each refresh so restarts (ownership reset) can't desync them.
    for (let i = 0; i < WEAPONS.length; i++) {
      const pip = this.els[`pip-${i}`];
      if (!pip) continue;
      const owned = w.owned[i] === true;
      pip.classList.toggle('pip-owned', owned);
      pip.classList.toggle('pip-active', owned && w.slot === i);
    }

    const slot = w.slots[w.slot];
    const slotAmmo = slot?.ammo ?? 0;
    const slotReserve = slot?.reserve ?? 0;
    const cfg = WEAPONS[w.slot] ?? WEAPONS[0]!;
    const mag = this.els['ammo-mag'];
    if (mag) {
      // Mag-fraction classes (not an absolute count) so this scales across
      // guns with very different mag sizes (shotgun 6 vs smg 50). Computed
      // every throttled refresh, independent of the text-change gate below,
      // so switching weapons re-evaluates against the new gun's mag size
      // even when the raw ammo digit happens to be unchanged.
      const frac = slotAmmo / cfg.mag;
      mag.classList.toggle('ammo-warn', frac <= 0.35);
      mag.classList.toggle('ammo-critical', frac <= 0.15 || slotAmmo === 0);
    }
    const ammoText = String(slotAmmo);
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      if (mag) {
        mag.textContent = ammoText;
        mag.classList.remove('ammo-tick'); // pop on every change
        void mag.offsetWidth;
        mag.classList.add('ammo-tick');
      }
    }
    const reserveEl = this.els['ammo-reserve'];
    if (reserveEl) reserveEl.textContent = ` / ${slotReserve}`;
    this.els['hud-reload']?.classList.toggle('reload-on', w.reloading);

    // Reload prompt: mutually exclusive with REARMING (that only shows
    // while w.reloading is true).
    const promptEl = this.els['hud-reload-prompt'];
    if (promptEl) {
      if (slotAmmo === 0 && !w.reloading && slotReserve > 0) {
        promptEl.textContent = 'RELOAD [R]';
        promptEl.classList.remove('prompt-urgent');
        promptEl.classList.add('prompt-on');
      } else if (slotAmmo === 0 && slotReserve === 0) {
        promptEl.textContent = 'FIND AMMO';
        promptEl.classList.add('prompt-urgent', 'prompt-on');
      } else {
        promptEl.classList.remove('prompt-on', 'prompt-urgent');
      }
    }

    // Intermission countdown: derived from the stored deadline, not a timer.
    if (this.breatherDeadline > 0) {
      const remainingS = Math.max(0, (this.breatherDeadline - now) / 1000);
      const banner = this.els['intermission-banner'];
      if (banner) {
        banner.textContent = `WAVE ${this.breatherWave} CLEARED — NEXT WAVE IN ${Math.ceil(remainingS)}`;
      }
    }
    // Unconditionally (not just while the banner is up): pips/costs must
    // also reset the moment a death-restart zeroes the levels (QA FAIL #7 —
    // chips showed stale pips after R until the next intermission).
    this.refreshPromoChips(state);

    // Divide by the EFFECTIVE cap, not 100 — with NINE LIVES raising max hp
    // to 125, a /100 bar reads full from 100-125 and hides real damage.
    const hpMax = effectiveMaxHp(state);
    const hpW = Math.round(state.health.hp);
    if (hpW !== this.lastHpWidth) {
      this.lastHpWidth = hpW;
      this.els['hp-fill']?.style.setProperty('transform', `scaleX(${hpW / hpMax})`);
      this.els['hp-fill']?.classList.toggle('hp-low', hpW <= 30);
    }
    // Low-health vignette intensity steps (avoid style churn per frame).
    const lowHp = state.health.dead ? 0 : Math.max(0, Math.round((1 - state.health.hp / 40) * 10));
    if (lowHp !== this.lowHpShown) {
      this.lowHpShown = lowHp;
      this.els['lowhp-vignette']?.style.setProperty('opacity', String(lowHp * 0.075));
    }

    const s = state.score;
    const kills = this.els['score-kills'];
    if (kills) {
      const combo = now / 1000 < s.comboEndsAt && s.combo > 1 ? ` ×${s.combo}` : '';
      kills.textContent = `${s.score}${combo}`;
    }
    const wave = this.els['score-wave'];
    if (wave) {
      wave.textContent =
        s.wave > 0
          ? `WAVE ${s.wave} · ${s.catsAlive} HOSTILE · ${s.kills} KILLS`
          : 'STANDBY';
    }
    const tuna = this.els['score-tuna'];
    if (tuna) tuna.textContent = `TUNA ${state.upgrades.tuna}`;
  }
}
