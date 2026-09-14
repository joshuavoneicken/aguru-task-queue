import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { flushMicrotasks, ManualClock } from '../testing/manual-clock.js';
import { Heartbeat } from './heartbeat.js';

type TaskId = string;
type ClaimId = string;

const LEASE_MS = 30_000;
const TICK_MS = LEASE_MS / 3;

const taskId = (): TaskId => randomUUID();
const claimId = (): ClaimId => randomUUID();

type ExtendImpl = (id: TaskId, claimId: ClaimId) => Promise<string | null>;

class FakeExtender {
  readonly calls: Array<{ id: TaskId; claimId: ClaimId }> = [];
  impl: ExtendImpl = async () => 'renewed';
  readonly client = {
    extend: (id: TaskId, cid: ClaimId): Promise<string | null> => {
      this.calls.push({ id, claimId: cid });
      return this.impl(id, cid);
    },
  };

  /** Answers each renewal with the next scripted result; 'throw' rejects, then repeats the last entry. */
  script(...results: Array<string | null | 'throw'>): void {
    let call = 0;
    this.impl = async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      if (result === 'throw') throw new Error('connect ECONNREFUSED');
      return result ?? null;
    };
  }
}

function setup() {
  const clock = new ManualClock();
  const extender = new FakeExtender();
  const lost: Array<{ id: TaskId; reason: 'refused' | 'deadline' }> = [];
  const heartbeat = new Heartbeat({
    client: extender.client,
    leaseMs: LEASE_MS,
    clock,
    onLost: (id, reason) => lost.push({ id, reason }),
  });
  return { clock, extender, lost, heartbeat };
}

describe('Heartbeat', () => {
  it('renews every held task once per leaseMs/3 tick, echoing each claim id', async () => {
    const { clock, extender, heartbeat } = setup();
    const a = { id: taskId(), claimId: claimId() };
    const b = { id: taskId(), claimId: claimId() };
    heartbeat.start();
    heartbeat.track(a);
    heartbeat.track(b);

    await clock.advance(TICK_MS - 1);
    expect(extender.calls).toHaveLength(0);

    await clock.advance(1);
    expect(extender.calls).toHaveLength(2);
    expect(extender.calls).toContainEqual(a);
    expect(extender.calls).toContainEqual(b);

    await clock.advance(TICK_MS);
    expect(extender.calls).toHaveLength(4);
  });

  it('treats a null renewal as an ownership verdict: lost immediately, tracking stops', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const gone = { id: taskId(), claimId: claimId() };
    const kept = { id: taskId(), claimId: claimId() };
    extender.impl = async (id) => (id === gone.id ? null : 'renewed');
    heartbeat.start();
    heartbeat.track(gone);
    heartbeat.track(kept);

    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: gone.id, reason: 'refused' }]);
    expect(heartbeat.heldIds()).toEqual([kept.id]);

    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: gone.id, reason: 'refused' }]);
    expect(extender.calls.filter((c) => c.id === gone.id)).toHaveLength(1);
  });

  it('treats a thrown renewal as saying nothing: lost only after leaseMs without a success (A19)', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    extender.script('throw');
    heartbeat.start();
    heartbeat.track(task);

    await clock.advance(TICK_MS * 2);
    expect(lost).toHaveLength(0);
    expect(heartbeat.heldIds()).toEqual([task.id]);

    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: task.id, reason: 'deadline' }]);
    expect(heartbeat.heldIds()).toHaveLength(0);
  });

  it('a successful renewal in between resets the lease-loss deadline', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    extender.script('throw', 'renewed', 'throw');
    heartbeat.start();
    heartbeat.track(task);

    // fail at 10s, succeed at 20s, then fail at 30s and 40s — deadline now runs from 20s
    await clock.advance(TICK_MS * 4);
    expect(lost).toHaveLength(0);

    // 50s: 30s have passed since the last success
    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: task.id, reason: 'deadline' }]);
  });

  it('a renewal that never settles still loses the task after leaseMs, without piling up requests', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    extender.impl = () => new Promise(() => {});
    heartbeat.start();
    heartbeat.track(task);

    await clock.advance(TICK_MS * 2);
    expect(lost).toHaveLength(0);
    expect(extender.calls).toHaveLength(1);

    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: task.id, reason: 'deadline' }]);
  });

  it('reports why a task was lost: refused for a null renewal, deadline for silence', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const refused = { id: taskId(), claimId: claimId() };
    const silent = { id: taskId(), claimId: claimId() };
    heartbeat.track(refused);
    heartbeat.track(silent);
    extender.impl = async (id) => (id === refused.id ? null : Promise.reject(new Error('ECONNREFUSED')));
    heartbeat.start();
    await clock.advance(TICK_MS);
    expect(lost).toEqual([{ id: refused.id, reason: 'refused' }]);
    await clock.advance(LEASE_MS);
    expect(lost).toEqual([
      { id: refused.id, reason: 'refused' },
      { id: silent.id, reason: 'deadline' },
    ]);
    heartbeat.stop();
  });

  it('release stops renewal', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    heartbeat.start();
    heartbeat.track(task);
    heartbeat.release(task.id, task.claimId);

    await clock.advance(TICK_MS * 3);
    expect(extender.calls).toHaveLength(0);
    expect(lost).toHaveLength(0);
    expect(heartbeat.heldIds()).toHaveLength(0);
  });

  it('release is fenced by claim id: a stale release leaves a re-claim of the same task tracked', () => {
    const { heartbeat } = setup();
    const id = taskId();
    const stale = claimId();
    const live = claimId();
    heartbeat.track({ id, claimId: stale });
    heartbeat.track({ id, claimId: live }); // the same task, re-claimed under a new claim id

    heartbeat.release(id, stale);
    expect(heartbeat.held()).toEqual([{ id, claimId: live }]);

    heartbeat.release(id, live);
    expect(heartbeat.held()).toEqual([]);
  });

  it('a renewal settling after release is ignored — no late onLost', async () => {
    const { clock, extender, lost, heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    const pending: { answer: ((renewed: string | null) => void) | null } = { answer: null };
    extender.impl = () => new Promise((resolve) => {
      pending.answer = resolve;
    });
    heartbeat.start();
    heartbeat.track(task);

    await clock.advance(TICK_MS);
    heartbeat.release(task.id, task.claimId);
    expect(pending.answer).not.toBeNull();
    pending.answer?.(null);
    await flushMicrotasks();
    expect(lost).toHaveLength(0);
  });

  it('stop halts ticking', async () => {
    const { clock, extender, heartbeat } = setup();
    heartbeat.track({ id: taskId(), claimId: claimId() });
    heartbeat.start();
    heartbeat.stop();

    await clock.advance(TICK_MS * 3);
    expect(extender.calls).toHaveLength(0);
  });

  it('held() exposes id and claim id pairs for the lifecycle to act on', () => {
    const { heartbeat } = setup();
    const task = { id: taskId(), claimId: claimId() };
    heartbeat.track(task);
    expect(heartbeat.held()).toEqual([task]);
    expect(heartbeat.heldIds()).toEqual([task.id]);
  });
});
