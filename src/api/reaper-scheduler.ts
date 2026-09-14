export interface ReaperScheduler {
  /** ISO time of the last tick that completed without throwing; null until one has. */
  lastTickAt(): string | null;
  stop(): void;
}

/**
 * Runs the recovery drain on a timer (SPEC §3). A tick that throws is logged and the next still
 * fires: recovery infrastructure that fails silently is the one failure the lease model cannot see,
 * so the failure is reported here and the staleness of lastTickAt is exposed on /healthz. Only the
 * error's class and driver code are logged, never its message, which may carry row values.
 */
export function startReaperScheduler(opts: {
  drain: () => Promise<unknown>;
  cadenceMs: number;
  log: (message: string) => void;
  random?: () => number;
}): ReaperScheduler {
  let lastTickAt: string | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await opts.drain();
      if (stopped) return;
      lastTickAt = new Date().toISOString();
    } catch (thrown) {
      if (stopped) return;
      const name = thrown instanceof Error ? thrown.name : 'non-error';
      const code = thrown instanceof Error && 'code' in thrown && typeof thrown.code === 'string' ? ` ${thrown.code}` : '';
      opts.log(`reaper tick failed: ${name}${code}`);
    }
  };
  void tick();
  const random = opts.random ?? Math.random;
  // ±20% jitter so N API instances do not tick in lockstep.
  const jittered = opts.cadenceMs + Math.floor(random() * opts.cadenceMs * 0.4) - Math.floor(opts.cadenceMs * 0.2);
  const timer = setInterval(() => { void tick(); }, jittered);
  timer.unref();
  return {
    lastTickAt: () => lastTickAt,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
