import { describe, expect, it, vi } from 'vitest';
import { startReaperScheduler } from './reaper-scheduler.js';

describe('reaper scheduler', () => {
  it('ticks immediately and on every cadence, records the last completed tick', async () => {
    vi.useFakeTimers();
    try {
      const drains: number[] = [];
      const scheduler = startReaperScheduler({
        drain: async () => { drains.push(Date.now()); },
        cadenceMs: 15_000,
        log: () => undefined,
        random: () => 0.5, // pins the jittered cadence to exactly cadenceMs
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drains).toHaveLength(1);
      expect(scheduler.lastTickAt()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(drains).toHaveLength(2);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(drains).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing tick is logged by class and driver code, never the message, and does not stop the next tick', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      let calls = 0;
      const scheduler = startReaperScheduler({
        drain: async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('permission denied for table tasks'), { code: '42501' });
        },
        cadenceMs: 15_000,
        log: (message) => log.push(message),
        random: () => 0.5,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.lastTickAt()).toBeNull();
      expect(log).toEqual(['reaper tick failed: Error 42501']);
      expect(log.join('\n')).not.toMatch(/permission denied/);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls).toBe(2);
      expect(scheduler.lastTickAt()).not.toBeNull();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick still in flight when stop() runs does not log or update the last tick once it settles', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const inFlight: { reject: ((reason: unknown) => void) | null } = { reject: null };
      const scheduler = startReaperScheduler({
        drain: () => new Promise<void>((_resolve, rej) => { inFlight.reject = rej; }),
        cadenceMs: 15_000,
        log: (message) => log.push(message),
        random: () => 0.5,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(inFlight.reject).not.toBeNull();
      scheduler.stop();
      inFlight.reject?.(new Error('connection terminated'));
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toEqual([]);
      expect(scheduler.lastTickAt()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
