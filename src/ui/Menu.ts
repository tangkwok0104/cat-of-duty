import type { GameState, QualityTier } from '../core/GameState';
import type { QualityControl } from '../core/Capabilities';
import { preloadCritical } from '../core/Assets';
import { openFieldReport } from './FieldReport';
import { openTopCats } from './TopCats';
import { openFriendPanel } from './FriendPanel';
import { parseRoomFromUrl } from '../net/Rooms';

const REPO_URL = 'https://github.com/tangkwok0104/cat-of-duty';

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
    // ?room=ABCD boot: open FriendPanel pre-filled and auto-joining (once a
    // callsign exists — FriendPanel itself gates on that). Runs once, here,
    // since this constructor only ever runs once at boot.
    const roomCode = parseRoomFromUrl();
    if (roomCode) openFriendPanel(roomCode);
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="menu-art" aria-hidden="true">
        <img class="menu-art-img" src="/assets/gen/ui/menu-keyart.png" alt="" />
      </div>
      <div class="menu-scrim" aria-hidden="true"></div>
      <div class="menu-content">
        <img class="menu-logo" src="/assets/gen/ui/logo.svg" alt="Cat of Duty" />
        <div class="menu-sub">TACTICAL FELINE OPERATIONS</div>
        <div class="menu-card">
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
          <div class="menu-topcats-row">
            <button type="button" class="menu-topcats-btn" id="menu-topcats">TOP CATS ▸</button>
            <button type="button" class="menu-topcats-btn menu-friend-btn" id="menu-friend">
              PLAY WITH A FRIEND <span class="beta-tag">BETA</span>
            </button>
          </div>
          <div class="menu-hint">WASD MOVE · SHIFT SPRINT · CTRL CROUCH · SPACE JUMP · 1-4 GUNS · R RELOAD</div>
          <div class="menu-footer">
            <button type="button" class="menu-footer-link" id="footer-fieldreport">FIELD REPORT</button>
            <span class="menu-footer-sep" aria-hidden="true">·</span>
            <a class="menu-footer-link" href="/privacy.html" target="_blank" rel="noopener">PRIVACY</a>
            <span class="menu-footer-sep" aria-hidden="true">·</span>
            <a class="menu-footer-link" href="/terms.html" target="_blank" rel="noopener">TERMS</a>
            <span class="menu-footer-sep" aria-hidden="true">·</span>
            <a class="menu-footer-link" href="${REPO_URL}" target="_blank" rel="noopener">SOURCE</a>
          </div>
        </div>
      </div>`;

    const fieldReportBtn = this.root.querySelector('#footer-fieldreport');
    fieldReportBtn?.addEventListener('click', () => openFieldReport());
    const topCatsBtn = this.root.querySelector('#menu-topcats');
    topCatsBtn?.addEventListener('click', () => openTopCats());
    const friendBtn = this.root.querySelector('#menu-friend');
    friendBtn?.addEventListener('click', () => openFriendPanel());

    const deployBtn = this.root.querySelector('#menu-deploy') as HTMLButtonElement | null;
    deployBtn?.addEventListener('click', () => {
      this.deployed = true;
      this.cb.lock();
    });
    // Gate the first DEPLOY on the critical asset set (rigged cat + clips +
    // rifle + paw) so the first enemy a stranger meets is the real cat, not
    // the untextured proxy (wave-5 QA finding). ~1.5MB post-compression, so
    // this reads as a blink of "LOADING" on any reasonable connection.
    if (deployBtn) {
      deployBtn.disabled = true;
      preloadCritical((done, total) => {
        if (!deployBtn.disabled) return; // already released
        deployBtn.textContent = `LOADING ${Math.round((done / total) * 100)}%`;
      })
        .then(() => {
          deployBtn.disabled = false;
          deployBtn.textContent = this.deployed ? 'RESUME' : 'DEPLOY';
        })
        .catch(() => {
          // Never strand the player on a menu — worst case they meet the
          // proxy cat like everyone did before wave 6.
          deployBtn.disabled = false;
          deployBtn.textContent = 'DEPLOY';
        });
    }

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
