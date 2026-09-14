/**
 * The harness's one source of time. `now()` is monotonic (a duration source, never wall time), so
 * elapsed-time decisions — the lease-loss rule, the execution budget — are immune to clock steps and
 * NTP slew. Injected everywhere so unit tests drive heartbeat cadence, idle backoff and budgets with
 * a manual clock instead of real waiting.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
