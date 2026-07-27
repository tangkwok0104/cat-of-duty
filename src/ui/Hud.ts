import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';

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

  constructor() {
    const root = document.getElementById('hud-root');
    if (!root) throw new Error('hud-root missing');
    this.root = root;
    this.build();

    bus.on('enemy:hit', ({ killed }) => this.hitmarker(killed));
    bus.on('player:damaged', () => {
      this.vignette = 1;
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

    // Bottom-left: health.
    const health = make('hud-health', 'hud-health', this.root);
    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    const fill = document.createElement('div');
    fill.className = 'hp-fill';
    bar.append(fill);
    health.append(bar);
    this.els['hp-fill'] = fill;

    // Bottom-right: ammo.
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
    make('damage-vignette', 'damage-vignette', this.root);

    // Death screen.
    const death = make('death-screen', 'death-screen hidden-death', this.root);
    death.innerHTML =
      '<div class="death-title">K.I.A.</div>' +
      '<div class="death-sub">PRESS R TO REDEPLOY</div>';
  }

  private hitmarker(kill: boolean): void {
    const m = this.els['hitmarker'];
    if (!m) return;
    m.classList.remove('hm-play', 'hm-kill');
    void m.offsetWidth; // restart the CSS animation
    if (kill) m.classList.add('hm-kill');
    m.classList.add('hm-play');
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

    // Damage vignette ease-out.
    if (this.vignette > 0) {
      this.vignette = Math.max(0, this.vignette - dt * 1.6);
      this.els['damage-vignette']?.style.setProperty(
        'opacity',
        String(this.vignette * 0.85),
      );
    }

    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const ammoText = String(w.ammo);
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      const mag = this.els['ammo-mag'];
      if (mag) {
        mag.textContent = ammoText;
        mag.classList.toggle('ammo-low', w.ammo <= 5);
      }
    }
    const reserveEl = this.els['ammo-reserve'];
    if (reserveEl) reserveEl.textContent = ` / ${w.reserve}`;
    this.els['hud-reload']?.classList.toggle('reload-on', w.reloading);

    const hpW = Math.round(state.health.hp);
    if (hpW !== this.lastHpWidth) {
      this.lastHpWidth = hpW;
      this.els['hp-fill']?.style.setProperty('transform', `scaleX(${hpW / 100})`);
      this.els['hp-fill']?.classList.toggle('hp-low', hpW <= 30);
    }

    const kills = this.els['score-kills'];
    if (kills) kills.textContent = `KILLS ${state.score.kills}`;
    const wave = this.els['score-wave'];
    if (wave) {
      wave.textContent = state.score.wave > 0 ? `WAVE ${state.score.wave} · ${state.score.catsAlive} HOSTILE` : 'STANDBY';
    }
  }
}
