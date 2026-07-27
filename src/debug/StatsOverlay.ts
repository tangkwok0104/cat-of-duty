import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';

const SAMPLE_CAP = 240;
const REFRESH_MS = 250;

interface PerformanceMemory {
  usedJSHeapSize: number;
}

export function heapMB(): number {
  const mem = (performance as unknown as { memory?: PerformanceMemory }).memory;
  return mem ? mem.usedJSHeapSize / (1024 * 1024) : -1;
}

/** Debug stats overlay (DOM, token-styled): fps, frame ms (avg + p95),
 *  draw calls, triangles, quality tier, JS heap. Text updates are throttled
 *  and use textContent only — no layout churn, no hot-path allocation. */
export class StatsOverlay {
  private samples = new Float32Array(SAMPLE_CAP);
  private cursor = 0;
  private filled = 0;
  private lastRefresh = 0;
  private sorted = new Float32Array(SAMPLE_CAP);

  private readonly fields: Record<string, HTMLElement> = {};
  private tierName: () => string;

  constructor(private readonly state: GameState, tierName: () => string) {
    this.tierName = tierName;
    const root = document.getElementById('debug-root');
    if (!root) throw new Error('debug-root missing from index.html');

    const panel = document.createElement('div');
    panel.className = 'stats-panel';
    const rows: [string, string][] = [
      ['fps', 'FPS'],
      ['ms', 'MS AVG'],
      ['p95', 'MS P95'],
      ['draw', 'DRAW'],
      ['tris', 'TRIS'],
      ['qual', 'QUAL'],
      ['heap', 'HEAP'],
    ];
    for (const [key, label] of rows) {
      const row = document.createElement('div');
      row.className = 'stats-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'stats-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'stats-value';
      valueEl.textContent = '—';
      row.append(labelEl, valueEl);
      panel.append(row);
      this.fields[key] = valueEl;
    }
    root.append(panel);

    bus.on('quality:changed', () => {
      const el = this.fields['qual'];
      if (el) el.textContent = this.tierName();
    });
  }

  frame(frameMs: number): void {
    this.samples[this.cursor] = frameMs;
    this.cursor = (this.cursor + 1) % SAMPLE_CAP;
    if (this.filled < SAMPLE_CAP) this.filled++;

    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const n = this.filled;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.samples[i] ?? 0;
    const avg = sum / Math.max(1, n);

    this.sorted.set(this.samples.subarray(0, n));
    const sortedView = this.sorted.subarray(0, n);
    sortedView.sort();
    const p95 = sortedView[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;

    this.setText('fps', (1000 / Math.max(0.01, avg)).toFixed(0));
    this.setText('ms', avg.toFixed(2));
    this.setText('p95', p95.toFixed(2));
    this.setText('draw', String(this.state.perf.drawCalls));
    this.setText('tris', formatK(this.state.perf.triangles));
    this.setText('qual', this.tierName());
    const heap = heapMB();
    this.state.perf.heapMB = heap;
    this.setText('heap', heap < 0 ? 'n/a' : `${heap.toFixed(0)}MB`);
  }

  private setText(key: string, value: string): void {
    const el = this.fields[key];
    if (el && el.textContent !== value) el.textContent = value;
  }
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
