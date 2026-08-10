/** FIELD REPORT — the project's FeedbackWidget (zero-backend feedback
 *  widget; 67Lab AGENT.md §4 channel). Composes a prefilled GitHub
 *  "New Issue" URL (title + body + diagnostics) and opens it in a new tab;
 *  COPY REPORT is the no-GitHub-account fallback. No network calls except
 *  the user-initiated window.open.
 *
 *  Module-level singleton (not a class main.ts instantiates): Menu.ts and
 *  Hud.ts both need to trigger the same modal without holding a shared
 *  reference to each other, so `openFieldReport()` is a plain import both
 *  can call. Diagnostics arrive via dependency injection (`configure`) so
 *  this file never imports GameState — it stays a leaf the rest of the UI
 *  layer can depend on without a cycle. */

type Category = 'BUG' | 'IDEA' | 'OTHER';
const CATEGORIES: readonly Category[] = ['BUG', 'IDEA', 'OTHER'];
const REPO_URL = 'https://github.com/tangkwok0104/cat-of-duty';
const MESSAGE_MAX = 1000;

// Friendly labels for the diagnostics keys main.ts's getDiagnostics() may
// provide. An unlisted key still renders (uppercased key as label) so an
// omitted or future field never breaks the preview.
const DIAG_LABELS: Record<string, string> = {
  version: 'VERSION',
  wave: 'WAVE',
  quality: 'QUALITY',
  ua: 'USER AGENT',
  viewport: 'VIEWPORT',
};

/** Same formatter feeds the on-screen "ATTACHED INTEL" preview and the
 *  GitHub issue body — what the player sees is byte-for-byte what's sent. */
function formatDiagnostics(diag: Record<string, string>): string {
  return Object.entries(diag)
    .map(([key, value]) => `${DIAG_LABELS[key] ?? key.toUpperCase()}: ${value}`)
    .join('\n');
}

class FieldReportModal {
  private overlay: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private intelBody: HTMLElement | null = null;
  private confirmEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private chips: HTMLButtonElement[] = [];
  private category: Category = 'BUG';
  private diagnostics: Record<string, string> = {};
  private getDiagnostics: (() => Record<string, string>) | null = null;
  private isOpen = false;

  configure(getDiagnostics: () => Record<string, string>): void {
    this.getDiagnostics = getDiagnostics;
  }

  /** Opens from the menu footer (pointer already free) or the K.I.A. screen
   *  (pointer typically still locked — see Hud.ts). exitPointerLock() is a
   *  harmless no-op when nothing is locked, so one code path covers both. */
  show(): void {
    this.ensureBuilt();
    if (document.pointerLockElement) document.exitPointerLock();
    this.diagnostics = this.getDiagnostics?.() ?? {};
    this.renderIntel();
    this.setConfirm('', false);
    this.refreshButtons();
    this.overlay?.classList.remove('fr-hidden');
    this.isOpen = true;
    this.textarea?.focus();
  }

  private hide(): void {
    this.overlay?.classList.add('fr-hidden');
    this.isOpen = false;
  }

  private ensureBuilt(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.id = 'fieldreport-overlay';
    overlay.className = 'fr-overlay fr-hidden';
    overlay.innerHTML =
      '<div class="fr-panel" role="dialog" aria-modal="true" aria-label="Field report">' +
      '<div class="fr-header">' +
      '<div class="fr-title">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<ellipse cx="12" cy="16" rx="5.5" ry="4.2"/>' +
      '<ellipse cx="5.5" cy="8.5" rx="1.8" ry="2.3"/>' +
      '<ellipse cx="10.5" cy="5.5" rx="1.8" ry="2.4"/>' +
      '<ellipse cx="15.5" cy="5.5" rx="1.8" ry="2.4"/>' +
      '<ellipse cx="18.5" cy="8.5" rx="1.8" ry="2.3"/>' +
      '</svg>' +
      '<span>FIELD REPORT</span>' +
      '</div>' +
      '<button type="button" class="fr-close" aria-label="Close field report">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6 L18 18 M18 6 L6 18"/>' +
      '</svg>' +
      '</button>' +
      '</div>' +
      '<div class="fr-seg" id="fr-cat"></div>' +
      `<textarea id="fr-message" class="fr-textarea" maxlength="${MESSAGE_MAX}" rows="4" ` +
      'placeholder="WHAT HAPPENED, SOLDIER?"></textarea>' +
      '<div class="fr-intel">' +
      '<div class="fr-intel-title">ATTACHED INTEL</div>' +
      '<div id="fr-intel-body" class="fr-intel-body"></div>' +
      '</div>' +
      '<div class="fr-actions">' +
      '<button type="button" id="fr-send" class="fr-btn fr-btn-primary">SEND VIA GITHUB</button>' +
      '<button type="button" id="fr-copy" class="fr-btn fr-btn-ghost">COPY REPORT</button>' +
      '</div>' +
      '<div class="fr-note">OPENS A PUBLIC GITHUB ISSUE — A FREE GITHUB ACCOUNT IS REQUIRED. ' +
      'NO ACCOUNT? COPY REPORT INSTEAD.</div>' +
      '<div id="fr-confirm" class="fr-confirm"></div>' +
      '</div>';
    document.body.append(overlay);
    this.overlay = overlay;

    const textarea = overlay.querySelector('#fr-message');
    if (textarea instanceof HTMLTextAreaElement) {
      this.textarea = textarea;
      textarea.addEventListener('input', () => this.refreshButtons());
    }
    const intelBody = overlay.querySelector('#fr-intel-body');
    if (intelBody instanceof HTMLElement) this.intelBody = intelBody;
    const confirmEl = overlay.querySelector('#fr-confirm');
    if (confirmEl instanceof HTMLElement) this.confirmEl = confirmEl;

    // Category: macOS-style segmented control, same recipe as Menu.ts's
    // quality chips (raised active pill, index-matched refresh).
    const seg = overlay.querySelector('#fr-cat');
    if (seg) {
      for (const cat of CATEGORIES) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'fr-chip';
        chip.textContent = cat;
        chip.addEventListener('click', () => {
          this.category = cat;
          this.refreshChips();
        });
        seg.append(chip);
        this.chips.push(chip);
      }
      this.refreshChips();
    }

    const sendBtn = overlay.querySelector('#fr-send');
    if (sendBtn instanceof HTMLButtonElement) {
      this.sendBtn = sendBtn;
      sendBtn.addEventListener('click', () => this.send());
    }
    const copyBtn = overlay.querySelector('#fr-copy');
    if (copyBtn instanceof HTMLButtonElement) {
      this.copyBtn = copyBtn;
      copyBtn.addEventListener('click', () => this.copy());
    }

    overlay.querySelector('.fr-close')?.addEventListener('click', () => this.hide());
    // Backdrop click (outside the panel) also closes — the click target is
    // the overlay itself only when the panel wasn't hit.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });
    // Registered once (ensureBuilt runs a single time); gated on isOpen so
    // it's inert for the rest of the page's life until a report is open.
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      e.preventDefault();
      this.hide();
    });
  }

  private refreshChips(): void {
    CATEGORIES.forEach((cat, i) => {
      this.chips[i]?.classList.toggle('fr-chip-active', cat === this.category);
    });
  }

  /** SEND/COPY both compose a real GitHub issue — require some actual
   *  words rather than letting an empty textarea file "[untitled]" spam. */
  private refreshButtons(): void {
    const hasMessage = (this.textarea?.value.trim().length ?? 0) > 0;
    if (this.sendBtn) this.sendBtn.disabled = !hasMessage;
    if (this.copyBtn) this.copyBtn.disabled = !hasMessage;
  }

  private renderIntel(): void {
    if (this.intelBody) this.intelBody.textContent = formatDiagnostics(this.diagnostics);
  }

  private composeTitle(message: string): string {
    const trimmed = message.trim();
    const snippet = trimmed.length > 0 ? trimmed.slice(0, 60) : 'untitled';
    return `[field report] ${this.category}: ${snippet}`;
  }

  private composeBody(message: string): string {
    return `${message.trim()}\n\n---\n${formatDiagnostics(this.diagnostics)}`;
  }

  private send(): void {
    const message = this.textarea?.value ?? '';
    if (message.trim().length === 0) return; // buttons are disabled too; belt & suspenders
    const title = this.composeTitle(message);
    const body = this.composeBody(message);
    const url = `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener');
    this.setConfirm('REPORT HANDED OFF TO GITHUB.', false);
  }

  private copy(): void {
    const message = this.textarea?.value ?? '';
    if (message.trim().length === 0) return;
    const text = `${this.composeTitle(message)}\n\n${this.composeBody(message)}`;
    if (!navigator.clipboard) {
      this.setConfirm('CLIPBOARD UNAVAILABLE — USE SEND VIA GITHUB INSTEAD.', true);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => this.setConfirm('COPIED TO CLIPBOARD.', false),
      () => this.setConfirm('COPY FAILED — USE SEND VIA GITHUB INSTEAD.', true),
    );
  }

  private setConfirm(text: string, isError: boolean): void {
    const el = this.confirmEl;
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('fr-confirm-err', isError);
    el.classList.remove('fr-confirm-play');
    void el.offsetWidth; // restart the fade-in
    if (text) el.classList.add('fr-confirm-play');
  }
}

const modal = new FieldReportModal();

/** Called once from main.ts, where GameState/QualityManager are in scope. */
export function configure(getDiagnostics: () => Record<string, string>): void {
  modal.configure(getDiagnostics);
}

/** Opens the modal. Safe to call from any pointer-free context (menu
 *  footer, K.I.A. screen); never wired to a gameplay key while locked. */
export function openFieldReport(): void {
  modal.show();
}
