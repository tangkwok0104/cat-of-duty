import type { GameState, CatArchetype } from '../core/GameState';
import { bus } from '../core/EventBus';
import { ARCHETYPES } from '../enemies/EnemyConfig';
import { WEAPONS } from '../weapons/WeaponConfig';

const REFRESH_MS = 100;

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
    bus.on('wave:started', ({ wave }) => this.waveToast(wave));
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

    // Top-right: kills + wave.
    const score = make('hud-score', 'hud-score', this.root);
    const kills = document.createElement('div');
    kills.className = 'score-kills';
    const wave = document.createElement('div');
    wave.className = 'score-wave';
    score.append(kills, wave);
    this.els['score-kills'] = kills;
    this.els['score-wave'] = wave;

    make('wave-toast', 'wave-toast', this.root);
    make('acquire-toast', 'acquire-toast', this.root);
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

  private waveToast(wave: number): void {
    const t = this.els['wave-toast'];
    if (!t) return;
    t.textContent = `WAVE ${wave}`;
    t.classList.remove('toast-play');
    void t.offsetWidth;
    t.classList.add('toast-play');
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

    // Minimap: 27m arena → 148px square. Player arrow rotates with yaw.
    const MM = 148 / 27;
    const arrow = this.els['mm-player'];
    if (arrow) {
      const mx = (state.player.currX + 13.5) * MM;
      const mz = (state.player.currZ + 13.5) * MM;
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
          `translate(${((cat.x + 13.5) * MM).toFixed(1)}px, ${((cat.z + 13.5) * MM).toFixed(1)}px)`,
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
    const ammoText = String(slotAmmo);
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      const mag = this.els['ammo-mag'];
      if (mag) {
        mag.textContent = ammoText;
        mag.classList.toggle('ammo-low', slotAmmo <= 5);
        mag.classList.remove('ammo-tick'); // pop on every change
        void mag.offsetWidth;
        mag.classList.add('ammo-tick');
      }
    }
    const reserveEl = this.els['ammo-reserve'];
    if (reserveEl) reserveEl.textContent = ` / ${slot?.reserve ?? 0}`;
    this.els['hud-reload']?.classList.toggle('reload-on', w.reloading);

    const hpW = Math.round(state.health.hp);
    if (hpW !== this.lastHpWidth) {
      this.lastHpWidth = hpW;
      this.els['hp-fill']?.style.setProperty('transform', `scaleX(${hpW / 100})`);
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
  }
}
