import { EditEvent } from './bridge';

export interface QueueOptions {
  revealDelayMs: number;
  dedupeMs: number;
  maxTabsPerTurn: number;
}

interface TurnState {
  opened: number;
  lastSeen: number;
  notified: boolean;
}

// Queue Codex edit events until the configured reveal delay expires.
// Track recently seen paths and tabs opened for each Codex turn.
// Keep overflow files available for an explicit user command.
export class EditQueue {
  private pending: EditEvent[] = [];
  private pendingPaths = new Set<string>();
  private recent = new Map<string, number>();
  private turns = new Map<string, TurnState>();
  private remaining = new Map<string, EditEvent>();
  private timer: NodeJS.Timeout | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private processing = false;
  private disposed = false;

  // Store the current settings and callbacks used by each queued event.
  constructor(
    private readonly options: () => QueueOptions,
    private readonly accepts: (event: EditEvent) => Promise<boolean>,
    private readonly open: (event: EditEvent) => Promise<boolean>,
    private readonly onOverflow: (count: number) => void,
  ) {}

  // Add a verified event without delaying the hook's HTTP acknowledgement.
  submit(event: EditEvent): void {
    if (this.disposed) return;
    const now = Date.now();
    const dedupeMs = this.options().dedupeMs;
    if (this.pendingPaths.has(event.path) || now - (this.recent.get(event.path) ?? -Infinity) < dedupeMs) return;
    this.recent.set(event.path, now);
    this.pendingPaths.add(event.path);
    this.pending.push(event);
    this.prune(now);
    if (!this.timer && !this.processing) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, this.options().revealDelayMs);
    }
  }

  // Return the unique files held back by the automatic tab limit.
  remainingFiles(): readonly EditEvent[] {
    return [...this.remaining.values()];
  }

  // Reveal a chosen overflow file after checking it again.
  async openRemaining(file: string): Promise<void> {
    const event = this.remaining.get(file);
    if (!event) return;
    try {
      if (await this.accepts(event)) await this.open(event);
      this.remaining.delete(file);
    } catch {
      // An inaccessible file should not interrupt other queued edits.
    }
  }

  // Cancel pending work when the extension shuts down.
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.pending = [];
    this.pendingPaths.clear();
    this.remaining.clear();
  }

  // Open eligible files serially so one burst cannot race the tab limit.
  private async drain(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      while (this.pending.length && !this.disposed) {
        const event = this.pending.shift()!;
        this.pendingPaths.delete(event.path);
        try {
          if (!(await this.accepts(event))) continue;
          const key = this.turnKey(event);
          const turn = this.turns.get(key) ?? { opened: 0, lastSeen: Date.now(), notified: false };
          turn.lastSeen = Date.now();
          this.turns.set(key, turn);
          if (turn.opened >= this.options().maxTabsPerTurn) {
            this.remaining.set(event.path, event);
            if (!turn.notified) {
              turn.notified = true;
              this.scheduleNotice();
            }
          } else {
            if (await this.open(event)) turn.opened++;
            this.remaining.delete(event.path);
          }
        } catch {
          // Opening errors are isolated to the affected file.
        }
      }
    } finally {
      this.processing = false;
    }
  }

  // Group known turns exactly and otherwise group nearby edits from a session.
  private turnKey(event: EditEvent): string {
    return JSON.stringify([event.sessionId, event.turnId ?? Math.floor(event.timestamp / 2000)]);
  }

  // Notify once the current burst has settled, with the latest overflow count.
  private scheduleNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      if (!this.disposed && this.remaining.size) this.onOverflow(this.remaining.size);
    }, 300);
  }

  // Bound bookkeeping for long sessions without scanning on every event.
  private prune(now: number): void {
    if (this.recent.size > 500) {
      for (const [file, time] of this.recent) if (now - time > 30_000) this.recent.delete(file);
      while (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
    }
    if (this.turns.size > 200) {
      for (const [key, turn] of this.turns) if (now - turn.lastSeen > 30 * 60_000) this.turns.delete(key);
      while (this.turns.size > 200) this.turns.delete(this.turns.keys().next().value!);
    }
  }
}
