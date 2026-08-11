/** PLAY WITH A FRIEND — M9 Phase 2 lobby UI. Creates/joins a 2-player room
 *  over src/net/Rooms.ts (frozen networking core — this file only drives it
 *  through RoomHandle callbacks, never touches its internals) and hands the
 *  live handle to main.ts the instant the run launches.
 *
 *  Module-level singleton, same shape as FieldReport.ts/TopCats.ts:
 *  `openFriendPanel()` is a plain import any caller can use without holding
 *  a shared reference; `configureFriendPanel()` wires main.ts's lock/launch
 *  callbacks once at boot (same DI shape as FieldReport's `configure`).
 *
 *  POINTER LOCK: requestPointerLock() only succeeds inside a genuine user
 *  gesture. The host's DEPLOY TOGETHER click satisfies that directly —
 *  handle.launch() calls the registered onLaunch callback SYNCHRONOUSLY
 *  (see Rooms.ts), so calling cb.lock() from handleLaunch() below is still
 *  inside that same click's call stack. The GUEST's onLaunch instead fires
 *  off a network broadcast arriving asynchronously — no gesture attached —
 *  so the guest sees a full-screen "CLICK TO DEPLOY" interstitial; ITS
 *  click is the gesture that finally calls cb.lock(). Never call lock()
 *  from onLaunch directly on the guest path.
 *
 *  HANDLE OWNERSHIP AT LAUNCH: Rooms.ts's onState/onLaunch/onPartnerStatus
 *  are single-slot setters, not multi-listener emitters — registering a new
 *  callback replaces the previous one. So the moment this panel hands a
 *  launched RoomHandle to main.ts (onRoomLaunched), it immediately forgets
 *  its own reference (`this.handle = null`) and never calls leave() on it
 *  again — main.ts owns onState/onPartnerStatus for the rest of the run. */

import { createRoom, joinRoom, isValidCode, CODE_LENGTH } from '../net/Rooms';
import type { RoomHandle, RoomState } from '../net/Rooms';

export interface FriendPanelCallbacks {
  /** Same lock() callback Menu.ts's DEPLOY button uses. MUST be called
   *  synchronously within a real user gesture — see the file header. */
  lock(): void;
  /** Fires once, immediately before lock(), handing the live room to
   *  main.ts for the rest of the run (status streaming + the Hud partner
   *  chip). This panel releases its own reference in the same tick. */
  onRoomLaunched(handle: RoomHandle): void;
}

// Same key as Hud.ts/TopCats.ts — kept in sync by name, not by import (see
// Hud.ts's identical note on CALLSIGN_KEY).
const CALLSIGN_KEY = 'cod-callsign';
const CALLSIGN_CHARSET = /[^A-Z0-9_-]/g;
const CALLSIGN_MAX = 12;

// Derived from isValidCode, never hardcoded — Rooms.ts owns the code
// alphabet and doesn't export it. Probing each candidate by repeating it to
// a full-length code asks the frozen API itself which characters are legal,
// so this can never drift from the real alphabet (including its length).
const CODE_CHARSET = new Set(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].filter((c) => isValidCode(c.repeat(CODE_LENGTH))),
);

// Rooms.ts's join promise can hang forever instead of ever settling: for a
// genuinely nonexistent room, the guest's own presence-track fires a sync
// almost immediately, and readRoster()'s "no host visible" branch closes the
// room ('host-left') well before its own intended 4s not-found deadline —
// and once closed=true, that deadline's setTimeout silently bails out
// (`if (settled || closed) return;`) without ever calling reject('not-found').
// Verified empirically (.tmp/debug-notfound.ts: 20s+, promise never settled)
// and confirmed by reading the source; can't fix it there (frozen), so this
// wraps create/join in a race against a synthetic timeout so the UI is never
// stuck on ESTABLISHING LINK forever. If the real promise wins the race
// late, its handle is left immediately rather than silently leaked.
function withTimeout(p: Promise<RoomHandle>, ms: number, timeoutMessage: string): Promise<RoomHandle> {
  return new Promise<RoomHandle>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, ms);
    p.then(
      (handle) => {
        clearTimeout(timer);
        if (settled) {
          handle.leave(); // lost the race — don't leak the channel
          return;
        }
        settled = true;
        resolve(handle);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

type View = 'entry' | 'joining' | 'room' | 'error';
const VIEWS: readonly View[] = ['entry', 'joining', 'room', 'error'];

class FriendPanelUI {
  private overlay: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private cb: FriendPanelCallbacks | null = null;
  private handle: RoomHandle | null = null;
  private latestState: RoomState | null = null;
  private isOpen = false;
  private pendingJoinCode: string | null = null;
  // Bumped on every open/leave — a create/join promise that settles after
  // the user has already backed out is discarded, and if it resolved to a
  // live handle, that handle is left immediately instead of surfacing a
  // room nobody asked to see anymore (same idiom as Hud.ts's submitGen /
  // TopCats.ts's requestSeq).
  private opGen = 0;

  configure(cb: FriendPanelCallbacks): void {
    this.cb = cb;
  }

  /** Pass a room code (e.g. from parseRoomFromUrl()) to pre-fill and
   *  auto-join; omit for the normal CREATE/JOIN entry screen. */
  show(joinCode?: string): void {
    this.ensureBuilt();
    this.pendingJoinCode = joinCode && isValidCode(joinCode) ? joinCode : null;
    this.overlay?.classList.remove('fp-hidden');
    this.isOpen = true;
    this.resetToEntry();
  }

  private hide(): void {
    this.overlay?.classList.add('fp-hidden');
    this.isOpen = false;
  }

  /** X / ESC / backdrop / LEAVE ROOM all converge here: leave the live room
   *  (a harmless no-op if none exists) and return to a clean entry view. */
  private closeAndLeave(): void {
    this.handle?.leave();
    this.handle = null;
    this.hide();
  }

  // ---- build (once) ----

  private ensureBuilt(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.id = 'friendpanel-overlay';
    overlay.className = 'fp-overlay fp-hidden';
    overlay.innerHTML = `
      <div id="fp-panel" class="fp-panel" role="dialog" aria-modal="true" aria-label="Play with a friend">
        <div class="fp-header">
          <div class="fp-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <ellipse cx="12" cy="16" rx="5.5" ry="4.2"/>
              <ellipse cx="5.5" cy="8.5" rx="1.8" ry="2.3"/>
              <ellipse cx="10.5" cy="5.5" rx="1.8" ry="2.4"/>
              <ellipse cx="15.5" cy="5.5" rx="1.8" ry="2.4"/>
              <ellipse cx="18.5" cy="8.5" rx="1.8" ry="2.3"/>
            </svg>
            <span>PLAY WITH A FRIEND</span>
            <span class="beta-tag">BETA</span>
          </div>
          <button type="button" class="fp-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6 L18 18 M18 6 L6 18"/>
            </svg>
          </button>
        </div>

        <div id="fp-view-entry" class="fp-view">
          <div id="fp-callsign-gate" class="fp-block">
            <div class="fp-hint">CALLSIGN REQUIRED BEFORE DEPLOYMENT</div>
            <div class="fp-row">
              <input id="fp-callsign-input" class="fp-input" type="text" maxlength="${CALLSIGN_MAX}"
                placeholder="CALLSIGN" autocomplete="off" spellcheck="false" />
              <button type="button" id="fp-callsign-continue" class="fp-btn fp-btn-primary" disabled>CONTINUE</button>
            </div>
          </div>
          <div id="fp-actions" class="fp-block">
            <button type="button" id="fp-create" class="fp-btn fp-btn-primary fp-create-btn">CREATE ROOM</button>
            <div class="fp-divider"><span>OR</span></div>
            <div class="fp-row">
              <input id="fp-join-code" class="fp-input fp-code-input" type="text" maxlength="${CODE_LENGTH}"
                placeholder="${'X'.repeat(CODE_LENGTH)}" autocomplete="off" spellcheck="false" />
              <button type="button" id="fp-join-btn" class="fp-btn fp-btn-primary" disabled>JOIN</button>
            </div>
          </div>
        </div>

        <div id="fp-view-joining" class="fp-view fp-view-hidden">
          <div class="fp-state fp-state-loading">ESTABLISHING LINK…</div>
        </div>

        <div id="fp-view-room" class="fp-view fp-view-hidden">
          <div class="fp-code-block">
            <div class="fp-code-label">ROOM CODE</div>
            <div id="fp-code-value" class="fp-code-value"></div>
            <button type="button" id="fp-copy-link" class="fp-btn fp-btn-ghost">COPY LINK</button>
            <div id="fp-copy-confirm" class="fp-confirm"></div>
          </div>
          <div class="fp-cards">
            <div class="fp-card">
              <div class="fp-card-label">YOU</div>
              <div id="fp-self-callsign" class="fp-card-callsign"></div>
              <div id="fp-self-ready" class="fp-card-ready"></div>
            </div>
            <div id="fp-card-partner" class="fp-card fp-card-waiting">
              <div class="fp-card-label">PARTNER</div>
              <div id="fp-partner-callsign" class="fp-card-callsign"></div>
              <div id="fp-partner-ready" class="fp-card-ready"></div>
            </div>
          </div>
          <button type="button" id="fp-ready-toggle" class="fp-btn fp-btn-ready">READY UP</button>
          <button type="button" id="fp-deploy-btn" class="fp-btn fp-btn-primary fp-deploy-btn" disabled>DEPLOY TOGETHER</button>
          <div id="fp-deploy-reason" class="fp-reason"></div>
          <div id="fp-await-host" class="fp-reason">AWAITING HOST DEPLOY</div>
          <button type="button" id="fp-leave" class="fp-btn fp-btn-ghost">LEAVE ROOM</button>
        </div>

        <div id="fp-view-error" class="fp-view fp-view-hidden">
          <div id="fp-error-text" class="fp-state fp-state-error"></div>
          <button type="button" id="fp-error-back" class="fp-btn fp-btn-ghost">BACK</button>
        </div>
      </div>
      <button type="button" id="fp-interstitial" class="fp-interstitial fp-interstitial-hidden">
        <div class="fp-interstitial-text">PARTNER LINK ESTABLISHED</div>
        <div class="fp-interstitial-sub">CLICK TO DEPLOY</div>
      </button>`;
    document.body.append(overlay);
    this.overlay = overlay;

    for (const id of [
      'fp-panel',
      'fp-callsign-gate', 'fp-callsign-input', 'fp-callsign-continue',
      'fp-actions', 'fp-create', 'fp-join-code', 'fp-join-btn',
      'fp-view-entry', 'fp-view-joining', 'fp-view-room', 'fp-view-error',
      'fp-code-value', 'fp-copy-link', 'fp-copy-confirm',
      'fp-card-partner', 'fp-self-callsign', 'fp-self-ready', 'fp-partner-callsign', 'fp-partner-ready',
      'fp-ready-toggle', 'fp-deploy-btn', 'fp-deploy-reason', 'fp-await-host', 'fp-leave',
      'fp-error-text', 'fp-error-back', 'fp-interstitial',
    ]) {
      const el = overlay.querySelector(`#${id}`);
      if (el instanceof HTMLElement) this.els[id] = el;
    }

    this.wireEntry();
    this.wireRoom();
    this.wireError();
    this.wireInterstitial();
    this.wireChrome();
  }

  private wireChrome(): void {
    const overlay = this.overlay;
    if (!overlay) return;
    overlay.querySelector('.fp-close')?.addEventListener('click', () => this.closeAndLeave());
    // Backdrop click (outside the panel/interstitial) also leaves.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeAndLeave();
    });
    // Keys typed anywhere inside this modal must never reach the game's
    // window-level hotkeys (R restarts, F opens field report) — a room code
    // can legitimately contain both letters. Same hazard class + same fix
    // as Hud.ts's kia-callsign input and FieldReport's overlay listener.
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeAndLeave();
      }
    });
    // Catches ESC when focus sits outside the overlay entirely (e.g.
    // body-focused right after a backdrop click) — same belt-and-suspenders
    // reasoning as TopCats.ts/FieldReport.ts's identical listener.
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      e.preventDefault();
      this.closeAndLeave();
    });
  }

  private wireEntry(): void {
    const callsignInput = this.els['fp-callsign-input'];
    if (callsignInput instanceof HTMLInputElement) {
      callsignInput.addEventListener('keydown', (e) => {
        e.stopPropagation(); // MUST: R/F hazard — see wireChrome's comment.
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onCallsignContinue();
        }
      });
      callsignInput.addEventListener('input', () => {
        const cleaned = callsignInput.value.toUpperCase().replace(CALLSIGN_CHARSET, '').slice(0, CALLSIGN_MAX);
        if (cleaned !== callsignInput.value) callsignInput.value = cleaned;
        this.updateCallsignContinueState();
      });
    }
    this.els['fp-callsign-continue']?.addEventListener('click', () => this.onCallsignContinue());

    this.els['fp-create']?.addEventListener('click', () => this.attemptCreate());

    const joinInput = this.els['fp-join-code'];
    if (joinInput instanceof HTMLInputElement) {
      joinInput.addEventListener('keydown', (e) => {
        e.stopPropagation(); // MUST — a code can legally contain R or F.
        if (e.key === 'Enter') {
          e.preventDefault();
          if (isValidCode(joinInput.value)) this.attemptJoin(joinInput.value);
        }
      });
      joinInput.addEventListener('input', () => {
        const cleaned = [...joinInput.value.toUpperCase()]
          .filter((c) => CODE_CHARSET.has(c))
          .slice(0, CODE_LENGTH)
          .join('');
        if (cleaned !== joinInput.value) joinInput.value = cleaned;
        this.updateJoinButtonState();
      });
    }
    this.els['fp-join-btn']?.addEventListener('click', () => {
      const input = this.els['fp-join-code'];
      if (input instanceof HTMLInputElement && isValidCode(input.value)) this.attemptJoin(input.value);
    });
  }

  private wireRoom(): void {
    this.els['fp-copy-link']?.addEventListener('click', () => this.onCopyLink());
    this.els['fp-ready-toggle']?.addEventListener('click', () => this.onReadyToggle());
    this.els['fp-deploy-btn']?.addEventListener('click', () => this.handle?.launch());
    this.els['fp-leave']?.addEventListener('click', () => this.closeAndLeave());
  }

  private wireError(): void {
    this.els['fp-error-back']?.addEventListener('click', () => this.resetToEntry());
  }

  private wireInterstitial(): void {
    this.els['fp-interstitial']?.addEventListener('click', () => this.onInterstitialClick());
  }

  // ---- view state ----

  private resetToEntry(): void {
    this.opGen++;
    this.handle?.leave(); // safety net — never orphan a live channel if re-opened unexpectedly
    this.handle = null;
    this.latestState = null;
    this.setView('entry');
    const codeInput = this.els['fp-join-code'];
    if (codeInput instanceof HTMLInputElement) codeInput.value = '';
    this.updateJoinButtonState();
    this.refreshEntryGate();

    const hasCallsign = this.readCallsign().length > 0;
    if (!hasCallsign) this.els['fp-callsign-input']?.focus();
    if (this.pendingJoinCode && hasCallsign) this.attemptJoin(this.pendingJoinCode);
  }

  private setView(view: View): void {
    for (const v of VIEWS) {
      this.els[`fp-view-${v}`]?.classList.toggle('fp-view-hidden', v !== view);
    }
    this.els['fp-panel']?.classList.remove('fp-panel-hidden');
    this.els['fp-interstitial']?.classList.add('fp-interstitial-hidden');
  }

  private showInterstitial(): void {
    this.els['fp-panel']?.classList.add('fp-panel-hidden');
    this.els['fp-interstitial']?.classList.remove('fp-interstitial-hidden');
    this.els['fp-interstitial']?.focus();
  }

  private showError(text: string): void {
    const el = this.els['fp-error-text'];
    if (el) el.textContent = text;
    this.setView('error');
  }

  private refreshEntryGate(): void {
    const hasCallsign = this.readCallsign().length > 0;
    this.els['fp-callsign-gate']?.classList.toggle('fp-block-hidden', hasCallsign);
    this.els['fp-actions']?.classList.toggle('fp-block-hidden', !hasCallsign);
    const input = this.els['fp-callsign-input'];
    if (input instanceof HTMLInputElement) input.value = this.readCallsign();
    this.updateCallsignContinueState();
  }

  // ---- callsign gate ----

  private readCallsign(): string {
    try {
      return localStorage.getItem(CALLSIGN_KEY) ?? '';
    } catch {
      return ''; // private mode
    }
  }

  private saveCallsign(value: string): void {
    try {
      localStorage.setItem(CALLSIGN_KEY, value);
    } catch {
      /* private mode */
    }
  }

  private updateCallsignContinueState(): void {
    const btn = this.els['fp-callsign-continue'];
    const input = this.els['fp-callsign-input'];
    if (btn instanceof HTMLButtonElement && input instanceof HTMLInputElement) {
      btn.disabled = input.value.trim().length === 0;
    }
  }

  private onCallsignContinue(): void {
    const input = this.els['fp-callsign-input'];
    if (!(input instanceof HTMLInputElement)) return;
    const value = input.value.trim();
    if (value.length === 0) return;
    this.saveCallsign(value);
    if (this.pendingJoinCode) {
      this.attemptJoin(this.pendingJoinCode);
    } else {
      this.refreshEntryGate();
    }
  }

  // ---- code join input ----

  private updateJoinButtonState(): void {
    const btn = this.els['fp-join-btn'];
    const input = this.els['fp-join-code'];
    if (btn instanceof HTMLButtonElement && input instanceof HTMLInputElement) {
      btn.disabled = !isValidCode(input.value);
    }
  }

  // ---- create / join ----

  private attemptCreate(): void {
    const gen = ++this.opGen;
    this.setView('joining');
    withTimeout(createRoom(), 6000, 'connect-failed').then(
      (handle) => {
        if (gen !== this.opGen) {
          handle.leave();
          return;
        }
        this.onRoomReady(handle);
      },
      (err: unknown) => {
        if (gen !== this.opGen) return;
        this.showError(this.mapJoinError(err));
      },
    );
  }

  private attemptJoin(code: string): void {
    this.pendingJoinCode = null; // consumed — never auto-retried on BACK
    const gen = ++this.opGen;
    this.setView('joining');
    withTimeout(joinRoom(code), 6000, 'not-found').then(
      (handle) => {
        if (gen !== this.opGen) {
          handle.leave();
          return;
        }
        this.onRoomReady(handle);
      },
      (err: unknown) => {
        if (gen !== this.opGen) return;
        this.showError(this.mapJoinError(err));
      },
    );
  }

  private mapJoinError(err: unknown): string {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'not-found') return 'ROOM NOT FOUND — CHECK THE CODE';
    if (msg === 'full') return 'ROOM FULL — TWO CATS MAX';
    return 'LINK FAILED — CHECK CONNECTION'; // connect-failed, no-identity, or unknown
  }

  // ---- room view ----

  private onRoomReady(handle: RoomHandle): void {
    this.handle = handle;
    this.setView('room');
    handle.onState((s) => this.renderRoomState(s));
    handle.onLaunch(() => this.handleLaunch());
  }

  private renderRoomState(s: RoomState): void {
    this.latestState = s;
    if (s.phase === 'closed') {
      this.handle = null;
      if (s.closedReason === 'host-left') this.showError('HOST DISCONNECTED — ROOM CLOSED');
      else if (s.closedReason === 'ejected-full') this.showError('ROOM FULL — TWO CATS MAX');
      // 'left' = our own deliberate leave — closeAndLeave() already hid the panel.
      return;
    }

    const codeEl = this.els['fp-code-value'];
    if (codeEl) codeEl.textContent = s.code;

    const selfCallsignEl = this.els['fp-self-callsign'];
    if (selfCallsignEl) selfCallsignEl.textContent = this.readCallsign() || '—';
    const selfReadyEl = this.els['fp-self-ready'];
    if (selfReadyEl) {
      selfReadyEl.textContent = s.selfReady ? 'READY' : 'STANDING BY';
      selfReadyEl.classList.toggle('fp-ready-armed', s.selfReady);
    }

    const partnerCard = this.els['fp-card-partner'];
    const partnerCallsignEl = this.els['fp-partner-callsign'];
    const partnerReadyEl = this.els['fp-partner-ready'];
    if (s.partner) {
      partnerCard?.classList.remove('fp-card-waiting');
      if (partnerCallsignEl) partnerCallsignEl.textContent = s.partner.callsign;
      if (partnerReadyEl) {
        partnerReadyEl.textContent = s.partner.ready ? 'READY' : 'STANDING BY';
        partnerReadyEl.classList.toggle('fp-ready-armed', s.partner.ready);
      }
    } else {
      partnerCard?.classList.add('fp-card-waiting');
      if (partnerCallsignEl) partnerCallsignEl.textContent = 'WAITING FOR PARTNER…';
      if (partnerReadyEl) partnerReadyEl.textContent = '';
    }

    const readyToggle = this.els['fp-ready-toggle'];
    if (readyToggle instanceof HTMLButtonElement) {
      readyToggle.textContent = s.selfReady ? 'READY' : 'READY UP';
      readyToggle.classList.toggle('fp-ready-armed', s.selfReady);
    }

    const isHost = s.role === 'host';
    this.els['fp-deploy-btn']?.classList.toggle('fp-block-hidden', !isHost);
    this.els['fp-deploy-reason']?.classList.toggle('fp-block-hidden', !isHost);
    this.els['fp-await-host']?.classList.toggle('fp-block-hidden', isHost);

    if (isHost) {
      const canDeploy = s.selfReady && s.partner?.ready === true;
      const deployBtn = this.els['fp-deploy-btn'];
      if (deployBtn instanceof HTMLButtonElement) deployBtn.disabled = !canDeploy;
      const reason = this.els['fp-deploy-reason'];
      if (reason) {
        reason.textContent = canDeploy
          ? ''
          : !s.partner
            ? 'WAITING FOR PARTNER TO JOIN'
            : !s.partner.ready
              ? 'WAITING ON PARTNER TO READY UP'
              : 'READY UP TO DEPLOY';
      }
    }
  }

  private onReadyToggle(): void {
    if (!this.handle || !this.latestState) return;
    this.handle.setReady(!this.latestState.selfReady);
  }

  private onCopyLink(): void {
    if (!this.handle) return;
    const url = this.handle.shareUrl;
    if (!navigator.clipboard) {
      this.flashCopyStatus('CLIPBOARD UNAVAILABLE', true);
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => this.flashCopyStatus('LINK COPIED', false),
      () => this.flashCopyStatus('COPY FAILED', true),
    );
  }

  private flashCopyStatus(text: string, isError: boolean): void {
    const el = this.els['fp-copy-confirm'];
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('fp-confirm-err', isError);
    el.classList.remove('fp-confirm-play');
    void el.offsetWidth; // restart the fade-in
    el.classList.add('fp-confirm-play');
  }

  // ---- launch ----

  private handleLaunch(): void {
    if (!this.handle || !this.latestState || !this.cb) return;
    if (this.latestState.role === 'host') {
      const handle = this.handle;
      this.handle = null; // hand off — see file header on single-slot ownership
      this.cb.onRoomLaunched(handle);
      this.cb.lock(); // still inside the DEPLOY TOGETHER click's call stack
      this.hide();
    } else {
      this.showInterstitial(); // guest needs its own gesture — see file header
    }
  }

  private onInterstitialClick(): void {
    if (!this.handle || !this.cb) return;
    const handle = this.handle;
    this.handle = null; // hand off — see file header on single-slot ownership
    this.cb.onRoomLaunched(handle);
    this.cb.lock();
    this.hide();
  }
}

const panel = new FriendPanelUI();

/** Called once from main.ts, where sound/input are in scope (same DI shape
 *  as FieldReport's configure / Hud's configureLeaderboard). Must run before
 *  Menu.ts is constructed, since a `?room=` boot can call openFriendPanel()
 *  immediately from Menu's constructor. */
export function configureFriendPanel(cb: FriendPanelCallbacks): void {
  panel.configure(cb);
}

/** Opens the panel. Pass a room code (e.g. from parseRoomFromUrl()) to
 *  pre-fill and auto-join; omit for the normal CREATE/JOIN entry screen. */
export function openFriendPanel(joinCode?: string): void {
  panel.show(joinCode);
}
