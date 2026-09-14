import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { flushMicrotasks, ManualClock } from '../testing/manual-clock.js';
import type { HeldTask } from './heartbeat.js';
import { createLifecycle } from './lifecycle.js';
import type { NackArgs } from '../contracts.js';

type TaskId = string;

const GRACE_MS = 5_000;

function heldTask(): HeldTask {
  return { id: randomUUID(), claimId: randomUUID() };
}

function forgivingRelease(task: HeldTask): { id: TaskId; args: NackArgs } {
  return {
    id: task.id,
    args: {
      reason: 'worker shutting down',
      retryable: true,
      kind: 'worker_shutdown',
      forgiveAttempt: true,
      claimId: task.claimId,
    },
  };
}

function makeLifecycle() {
  const clock = new ManualClock();
  const exits: number[] = [];
  const nackCalls: Array<{ id: TaskId; args: NackArgs }> = [];
  let held: HeldTask[] = [];
  let stopCalls = 0;
  let resolveDrain: () => void = () => {};
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  let nackImpl: (id: TaskId) => Promise<boolean> = async () => true;
  const log: string[] = [];

  const lifecycle = createLifecycle({
    harness: {
      stop: () => {
        stopCalls += 1;
        return drain;
      },
      heldTasks: () => [...held],
    },
    client: {
      nack: (id, args) => {
        nackCalls.push({ id, args });
        return nackImpl(id);
      },
    },
    shutdownGraceMs: GRACE_MS,
    clock,
    onExit: (code) => exits.push(code),
    log: (message) => log.push(message),
  });

  return {
    lifecycle,
    clock,
    exits,
    log,
    nackCalls,
    resolveDrain,
    setHeld: (tasks: HeldTask[]) => {
      held = tasks;
    },
    setNackImpl: (impl: (id: TaskId) => Promise<boolean>) => {
      nackImpl = impl;
    },
    stopCalls: () => stopCalls,
  };
}

describe('lifecycle: shutdown (SIGTERM/SIGINT)', () => {
  it('stops claiming, and tasks that finish inside the grace are acked normally — no forgiving nacks, exit 0', async () => {
    const t = makeLifecycle();
    t.setHeld([heldTask()]);

    const done = t.lifecycle.shutdown();
    await flushMicrotasks();
    expect(t.stopCalls()).toBe(1);
    expect(t.exits).toEqual([]); // still draining

    t.setHeld([]); // the in-flight task acked and was released
    t.resolveDrain();
    await done;

    expect(t.nackCalls).toEqual([]);
    expect(t.exits).toEqual([0]);

    // The grace timer was cancelled: time passing after the drain changes nothing.
    await t.clock.advance(GRACE_MS * 2);
    expect(t.nackCalls).toEqual([]);
    expect(t.exits).toEqual([0]);
  });

  it('at the grace deadline, forgiving-nacks exactly the still-held set and exits 0', async () => {
    const t = makeLifecycle();
    const finished = heldTask();
    const stuckA = heldTask();
    const stuckB = heldTask();
    t.setHeld([finished, stuckA, stuckB]);

    const done = t.lifecycle.shutdown();
    await flushMicrotasks();
    t.setHeld([stuckA, stuckB]); // one task completed mid-drain and was released

    await t.clock.advance(GRACE_MS);
    await done;

    expect(t.nackCalls).toEqual([forgivingRelease(stuckA), forgivingRelease(stuckB)]);
    expect(t.exits).toEqual([0]);
  });

  it('a drain that resolves with a task still held releases it forgivingly — an unsettled task is never stranded', async () => {
    const t = makeLifecycle();
    const straggler = heldTask();
    t.setHeld([straggler]);

    const done = t.lifecycle.shutdown();
    await flushMicrotasks();
    // stop() resolved cleanly, but a settle call that failed in transport (A19) left the task on
    // the heartbeat's books: the release must cover it, not just the grace-deadline path.
    t.resolveDrain();
    await done;

    expect(t.nackCalls).toEqual([forgivingRelease(straggler)]);
    expect(t.exits).toEqual([0]);
  });

  it('reports the drain and the release, so a graceful shutdown is visible in the log', async () => {
    const { lifecycle, clock, setHeld, log } = makeLifecycle();
    setHeld([heldTask(), heldTask()]);
    const done = lifecycle.shutdown();
    await flushMicrotasks();
    expect(log).toEqual([expect.stringMatching(/draining 2 in-flight tasks?.*5000 ms/)]);
    clock.advance(GRACE_MS);
    await done;
    expect(log[1]).toMatch(/released 2 .*exiting/);
  });

  it('a second SIGTERM during the drain does not double-run', async () => {
    const t = makeLifecycle();
    t.setHeld([heldTask()]);

    const first = t.lifecycle.shutdown();
    await flushMicrotasks();
    const second = t.lifecycle.shutdown();
    await second; // the repeat returns immediately
    expect(t.stopCalls()).toBe(1);
    expect(t.exits).toEqual([]);

    t.setHeld([]);
    t.resolveDrain();
    await first;

    expect(t.stopCalls()).toBe(1);
    expect(t.exits).toEqual([0]);
  });
});

describe('lifecycle: crash (uncaughtException/unhandledRejection)', () => {
  it('best-effort forgiving-nacks every held task and exits 1 even when one nack throws', async () => {
    const t = makeLifecycle();
    const poisoned = heldTask();
    const healthy = heldTask();
    t.setHeld([poisoned, healthy]);
    t.setNackImpl(async (id) => {
      if (id === poisoned.id) throw new Error('transport down');
      return true;
    });

    await t.lifecycle.crash();

    expect(t.nackCalls).toEqual([forgivingRelease(poisoned), forgivingRelease(healthy)]);
    expect(t.exits).toEqual([1]);
  });

  it('a crash during a graceful drain wins: exit code 1, exactly one exit', async () => {
    const t = makeLifecycle();
    const stuck = heldTask();
    t.setHeld([stuck]);

    const draining = t.lifecycle.shutdown();
    await flushMicrotasks();
    await t.lifecycle.crash();
    expect(t.exits).toEqual([1]);

    // The abandoned drain settling later must not produce a second exit.
    t.resolveDrain();
    await draining;
    await t.clock.advance(GRACE_MS * 2);
    expect(t.exits).toEqual([1]);
  });

  it('a second crash is a no-op', async () => {
    const t = makeLifecycle();
    t.setHeld([heldTask()]);

    await t.lifecycle.crash();
    await t.lifecycle.crash();

    expect(t.nackCalls).toHaveLength(1);
    expect(t.exits).toEqual([1]);
  });
});
