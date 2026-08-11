/** TOP CATS — the solo leaderboard panel. Opens from the menu's secondary
 *  action row (see Menu.ts). Module-level singleton, same shape as
 *  FieldReport.ts's modal: `openTopCats()` is a plain import any caller can
 *  use without holding a shared reference, and this file never imports
 *  GameState — it only talks to net/Leaderboard.ts and localStorage.
 *
 *  Rows are untrusted external data (another player's callsign, eventually
 *  served by a real backend) — every row is built with createElement +
 *  textContent, never innerHTML, so a malicious or buggy callsign can never
 *  inject markup. Only this file's own static chrome (title, buttons, empty
 *  states) uses the innerHTML template-string style FieldReport.ts uses,
 *  because that content is 100% authored here, never user data. */

import { fetchBoard, type BoardRow, type BoardWindow } from '../net/Leaderboard';

const CALLSIGN_KEY = 'cod-callsign';
const WINDOWS: readonly { id: BoardWindow; label: string }[] = [
  { id: 'week', label: 'THIS WEEK' },
  { id: 'all', label: 'ALL TIME' },
];

function readStoredCallsign(): string {
  try {
    return localStorage.getItem(CALLSIGN_KEY) ?? '';
  } catch {
    return ''; // private mode
  }
}

class TopCatsPanel {
  private overlay: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private tabs: HTMLButtonElement[] = [];
  private windowSel: BoardWindow = 'week';
  private isOpen = false;
  // Bumped on every load() call; a response only renders if it's still the
  // most recent request — guards against a slow THIS WEEK fetch landing
  // after the player has already switched to ALL TIME.
  private requestSeq = 0;

  show(): void {
    this.ensureBuilt();
    this.overlay?.classList.remove('tc-hidden');
    this.isOpen = true;
    this.load();
  }

  private hide(): void {
    this.overlay?.classList.add('tc-hidden');
    this.isOpen = false;
  }

  private ensureBuilt(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.id = 'topcats-overlay';
    overlay.className = 'tc-overlay tc-hidden';
    overlay.innerHTML =
      '<div class="tc-panel" role="dialog" aria-modal="true" aria-label="Top cats leaderboard">' +
      '<div class="tc-header">' +
      '<div class="tc-title">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<ellipse cx="12" cy="16" rx="5.5" ry="4.2"/>' +
      '<ellipse cx="5.5" cy="8.5" rx="1.8" ry="2.3"/>' +
      '<ellipse cx="10.5" cy="5.5" rx="1.8" ry="2.4"/>' +
      '<ellipse cx="15.5" cy="5.5" rx="1.8" ry="2.4"/>' +
      '<ellipse cx="18.5" cy="8.5" rx="1.8" ry="2.3"/>' +
      '</svg>' +
      '<span>TOP CATS</span>' +
      '</div>' +
      '<button type="button" class="tc-close" aria-label="Close leaderboard">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6 L18 18 M18 6 L6 18"/>' +
      '</svg>' +
      '</button>' +
      '</div>' +
      '<div class="tc-seg" id="tc-seg"></div>' +
      '<div class="tc-body" id="tc-body"></div>' +
      '</div>';
    document.body.append(overlay);
    this.overlay = overlay;

    const body = overlay.querySelector('#tc-body');
    if (body instanceof HTMLElement) this.body = body;

    // Window segmented control — same recipe as FieldReport's category
    // chips (raised active pill on --c-bg).
    const seg = overlay.querySelector('#tc-seg');
    if (seg) {
      for (const w of WINDOWS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tc-chip';
        chip.textContent = w.label;
        chip.addEventListener('click', () => this.setWindow(w.id));
        seg.append(chip);
        this.tabs.push(chip);
      }
      this.refreshTabs();
    }

    overlay.querySelector('.tc-close')?.addEventListener('click', () => this.hide());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      e.preventDefault();
      this.hide();
    });
  }

  private setWindow(w: BoardWindow): void {
    if (w === this.windowSel) return;
    this.windowSel = w;
    this.refreshTabs();
    this.load();
  }

  private refreshTabs(): void {
    WINDOWS.forEach((w, i) => {
      this.tabs[i]?.classList.toggle('tc-chip-active', w.id === this.windowSel);
    });
  }

  private async load(bust = false): Promise<void> {
    const seq = ++this.requestSeq;
    this.renderLoading();
    const result = await fetchBoard(this.windowSel, { bust });
    if (seq !== this.requestSeq) return; // superseded by a newer tab switch/retry
    if (!result.ok) {
      this.renderUnreachable();
      return;
    }
    if (result.rows.length === 0) {
      this.renderEmpty();
      return;
    }
    this.renderRows(result.rows);
  }

  private renderLoading(): void {
    if (!this.body) return;
    this.body.innerHTML = '<div class="tc-state tc-state-loading">QUERYING COMMAND…</div>';
  }

  private renderEmpty(): void {
    if (!this.body) return;
    this.body.innerHTML = '<div class="tc-state">NO SCORES ON RECORD — BE THE FIRST</div>';
  }

  private renderUnreachable(): void {
    if (!this.body) return;
    this.body.innerHTML =
      '<div class="tc-state">BOARD UNREACHABLE — SIGNAL LOST' +
      '<button type="button" class="tc-retry" id="tc-retry">RETRY</button>' +
      '</div>';
    this.body.querySelector('#tc-retry')?.addEventListener('click', () => this.load(true));
  }

  private renderRows(rows: BoardRow[]): void {
    if (!this.body) return;
    this.body.innerHTML = ''; // clears any prior state/rows before rebuilding
    const list = document.createElement('div');
    list.className = 'tc-rows';
    const mine = readStoredCallsign();

    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'tc-row';
      if (i < 3) el.classList.add('tc-row-top');
      if (mine.length > 0 && row.callsign === mine) el.classList.add('tc-row-me');

      const rank = document.createElement('span');
      rank.className = 'tc-rank';
      rank.textContent = `#${i + 1}`;

      const callsign = document.createElement('span');
      callsign.className = 'tc-callsign';
      callsign.textContent = row.callsign; // untrusted — textContent only, never innerHTML

      const score = document.createElement('span');
      score.className = 'tc-score';
      score.textContent = String(row.score);

      const wave = document.createElement('span');
      wave.className = 'tc-wave';
      wave.textContent = `W${row.wave}`;

      el.append(rank, callsign, score, wave);
      list.append(el);
    });

    this.body.append(list);
  }
}

const panel = new TopCatsPanel();

/** Opens the panel. Safe to call any time the pointer is free (menu only,
 *  currently — see Menu.ts). */
export function openTopCats(): void {
  panel.show();
}
