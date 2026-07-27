import type { GameState, QualityTier } from '../core/GameState';
import type { QualityControl } from '../core/Capabilities';

export interface MenuCallbacks {
  /** Request pointer lock (deploy/resume). */
  lock(): void;
  setVolume(v: number): void;
}

interface StoredSettings {
  sensitivity: number;
  fov: number;
  quality: number; // -1 = auto
  volume: number;
}

const STORE_KEY = 'cod-settings';

/** Main menu overlay: DEPLOY/RESUME + settings (sensitivity, FOV, quality,
 *  volume), persisted to localStorage. Shown whenever the pointer is free
 *  and the player is alive; the game world idles behind it. */
export class Menu {
  private root: HTMLElement;
  private visible = true;
  private deployed = false;
  private volume = 0.32;

  constructor(
    private readonly state: GameState,
    private readonly quality: QualityControl,
    private readonly cb: MenuCallbacks,
  ) {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('hud-root missing');
    this.root = document.createElement('div');
    this.root.id = 'menu-overlay';
    host.append(this.root);
    this.build();
    this.load();
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="menu-card">
        <svg class="menu-mark" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M10 34 L10 16 L16 22 L24 12 L32 22 L38 16 L38 34 Z"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
          <circle cx="19" cy="27" r="1.8" fill="currentColor"/>
          <circle cx="29" cy="27" r="1.8" fill="currentColor"/>
        </svg>
        <div class="menu-title">CAT OF DUTY</div>
        <div class="menu-sub">TACTICAL FELINE OPERATIONS</div>
        <button id="menu-deploy" class="menu-btn" type="button">DEPLOY</button>
        <div class="menu-settings">
          <label class="menu-row">
            <span>SENSITIVITY</span>
            <input id="set-sens" type="range" min="5" max="60" step="1" />
            <span id="set-sens-v" class="menu-val"></span>
          </label>
          <label class="menu-row">
            <span>FIELD OF VIEW</span>
            <input id="set-fov" type="range" min="60" max="110" step="1" />
            <span id="set-fov-v" class="menu-val"></span>
          </label>
          <label class="menu-row">
            <span>QUALITY</span>
            <span id="set-qual" class="menu-seg"></span>
          </label>
          <label class="menu-row">
            <span>VOLUME</span>
            <input id="set-vol" type="range" min="0" max="100" step="5" />
            <span id="set-vol-v" class="menu-val"></span>
          </label>
        </div>
        <div class="menu-hint">WASD MOVE · SHIFT SPRINT · CTRL CROUCH · SPACE JUMP · 1/2/3 GUNS · R RELOAD</div>
      </div>`;

    this.root.querySelector('#menu-deploy')?.addEventListener('click', () => {
      this.deployed = true;
      this.cb.lock();
    });

    const sens = this.root.querySelector('#set-sens') as HTMLInputElement | null;
    sens?.addEventListener('input', () => {
      this.state.tuning.sensitivity = Number(sens.value) / 10000;
      this.refresh();
      this.save();
    });
    const fov = this.root.querySelector('#set-fov') as HTMLInputElement | null;
    fov?.addEventListener('input', () => {
      this.state.tuning.baseFov = Number(fov.value);
      this.refresh();
      this.save();
    });
    const vol = this.root.querySelector('#set-vol') as HTMLInputElement | null;
    vol?.addEventListener('input', () => {
      this.volume = Number(vol.value) / 100;
      this.cb.setVolume(this.volume);
      this.refresh();
      this.save();
    });

    // Quality: segmented control (AUTO + 5 fixed tiers), macOS style.
    const seg = this.root.querySelector('#set-qual');
    if (seg) {
      const options = ['AUTO', 'ULTRA', 'HIGH', 'MED', 'LOW', 'MIN'];
      options.forEach((label, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'seg-chip';
        chip.textContent = label;
        chip.addEventListener('click', () => {
          if (i === 0) this.quality.setTier(0, true);
          else this.quality.setTier((i - 1) as QualityTier, false);
          this.refresh();
          this.save();
        });
        seg.append(chip);
      });
    }
    this.refresh();
  }

  private refresh(): void {
    const q = (sel: string): HTMLElement | null => this.root.querySelector(sel);
    const sens = q('#set-sens') as HTMLInputElement | null;
    if (sens) sens.value = String(Math.round(this.state.tuning.sensitivity * 10000));
    const sv = q('#set-sens-v');
    if (sv) sv.textContent = (this.state.tuning.sensitivity * 1000).toFixed(1);
    const fov = q('#set-fov') as HTMLInputElement | null;
    if (fov) fov.value = String(this.state.tuning.baseFov);
    const fv = q('#set-fov-v');
    if (fv) fv.textContent = `${this.state.tuning.baseFov}°`;
    const vol = q('#set-vol') as HTMLInputElement | null;
    if (vol) vol.value = String(Math.round(this.volume * 100));
    const vv = q('#set-vol-v');
    if (vv) vv.textContent = `${Math.round(this.volume * 100)}%`;
    const chips = this.root.querySelectorAll('.seg-chip');
    chips.forEach((chip, i) => {
      const active = this.state.quality.auto ? i === 0 : i - 1 === this.state.quality.tier;
      chip.classList.toggle('seg-active', active);
    });
  }

  private save(): void {
    const s: StoredSettings = {
      sensitivity: this.state.tuning.sensitivity,
      fov: this.state.tuning.baseFov,
      quality: this.state.quality.auto ? -1 : this.state.quality.tier,
      volume: this.volume,
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<StoredSettings>;
      if (typeof s.sensitivity === 'number' && s.sensitivity > 0.0004 && s.sensitivity < 0.007) {
        this.state.tuning.sensitivity = s.sensitivity;
      }
      if (typeof s.fov === 'number' && s.fov >= 60 && s.fov <= 110) {
        this.state.tuning.baseFov = s.fov;
      }
      if (typeof s.quality === 'number') {
        if (s.quality < 0) this.quality.setTier(0, true);
        else if (s.quality <= 4) this.quality.setTier(s.quality as QualityTier, false);
      }
      if (typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1) {
        this.volume = s.volume;
        this.cb.setVolume(s.volume);
      }
      this.refresh();
    } catch {
      /* corrupted store — defaults win */
    }
  }

  /** Called per frame: overlay shows whenever the pointer is free (and the
   *  player isn't on the death screen, which owns that moment). */
  update(locked: boolean, override: boolean): void {
    const show = !locked && !override && !this.state.health.dead && this.state.cameraMode === 'player';
    if (show !== this.visible) {
      this.visible = show;
      this.root.classList.toggle('menu-hidden', !show);
      if (show && this.deployed) {
        const btn = this.root.querySelector('#menu-deploy');
        if (btn) btn.textContent = 'RESUME';
        this.refresh(); // quality may have auto-stepped while playing
      }
    }
  }
}
