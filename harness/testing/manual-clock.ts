import type { Clock } from '../clock.js';

let nextTimerId = 1;

/** A handle that satisfies NodeJS.Timeout structurally so no cast is needed anywhere. */
class FakeTimer implements NodeJS.Timeout {
  private readonly id = nextTimerId;

  constructor() {
    nextTimerId += 1;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  hasRef(): boolean {
    return true;
  }

  refresh(): this {
    return this;
  }

  close(): this {
    return this;
  }

  _onTimeout(): void {}

  [Symbol.toPrimitive](): number {
    return this.id;
  }

  [Symbol.dispose](): void {}
}

interface Scheduled {
  at: number;
  every: number | null;
  run: () => void;
}

/** Deterministic Clock for unit tests: time moves only through advance(), which fires due timers in order. */
export class ManualClock implements Clock {
  private current = 0;
  private readonly scheduled = new Map<NodeJS.Timeout, Scheduled>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    const handle = new FakeTimer();
    this.scheduled.set(handle, { at: this.current + delayMs, every: null, run: callback });
    return handle;
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    this.scheduled.delete(handle);
  }

  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout {
    const handle = new FakeTimer();
    this.scheduled.set(handle, { at: this.current + intervalMs, every: intervalMs, run: callback });
    return handle;
  }

  clearInterval(handle: NodeJS.Timeout): void {
    this.scheduled.delete(handle);
  }

  /** Advances time by ms, firing due timers in time order and letting promise chains settle between firings. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.nextDueBy(target);
      if (due === null) break;
      const [handle, timer] = due;
      this.current = Math.max(this.current, timer.at);
      if (timer.every === null) this.scheduled.delete(handle);
      else timer.at += timer.every;
      timer.run();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  private nextDueBy(target: number): [NodeJS.Timeout, Scheduled] | null {
    let winner: [NodeJS.Timeout, Scheduled] | null = null;
    for (const entry of this.scheduled) {
      if (entry[1].at <= target && (winner === null || entry[1].at < winner[1].at)) winner = entry;
    }
    return winner;
  }
}

/** Lets pending promise chains settle without moving the clock. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}
