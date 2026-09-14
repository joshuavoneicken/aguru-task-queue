import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { failure, messageOf } from '../failure.js';
import {
  ResultTooLargeError,
  type ClaimedTask, type Classifier, type Handler, type NackArgs, type QueueClient,
} from '../contracts.js';
import { flushMicrotasks, ManualClock } from '../testing/manual-clock.js';
import { Harness } from './harness.js';
import { IdleBackoff } from './idle-backoff.js';
import { HandlerRegistry } from './registry.js';

type TaskId = string;
type ClaimId = string;
type TaskType = string;

const LEASE_MS = 30_000;
const TICK_MS = LEASE_MS / 3;
const BUDGET_MS = 300_000;

function makeTask(type: TaskType = 'http'): ClaimedTask {
  return {
    id: randomUUID(),
    type,
    payload: {},
    attempts: 1,
    claimId: randomUUID(),
    leaseExpiresAt: new Date(0).toISOString(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeQueueClient implements QueueClient {
  readonly claimCalls: Array<{ queue: string; max: number }> = [];
  readonly ackCalls: Array<{ id: TaskId; result: unknown; claimId: ClaimId }> = [];
  readonly nackCalls: Array<{ id: TaskId; args: NackArgs }> = [];
  ackImpl: (id: TaskId, result: unknown, claimId: ClaimId) => Promise<boolean> = async () => true;
  nackImpl: (id: TaskId, args: NackArgs) => Promise<boolean> = async () => true;
  extendImpl: (id: TaskId, claimId: ClaimId) => Promise<string | null> = async () => 'renewed';
  claimImpl: ((queue: string, max: number) => Promise<ClaimedTask[]>) | null = null;

  constructor(private readonly batches: ClaimedTask[][]) {}

  async claim(queue: string, max: number): Promise<ClaimedTask[]> {
    this.claimCalls.push({ queue, max });
    if (this.claimImpl !== null) return this.claimImpl(queue, max);
    return this.batches.shift() ?? [];
  }

  ack(id: TaskId, result: unknown, claimId: ClaimId): Promise<boolean> {
    this.ackCalls.push({ id, result, claimId });
    return this.ackImpl(id, result, claimId);
  }

  nack(id: TaskId, args: NackArgs): Promise<boolean> {
    this.nackCalls.push({ id, args });
    return this.nackImpl(id, args);
  }

  extend(id: TaskId, claimId: ClaimId): Promise<string | null> {
    return this.extendImpl(id, claimId);
  }
}

interface Registration {
  type: TaskType;
  handler: Handler;
  classifier?: Classifier;
}

const retryableClassifier: Classifier = (thrown) => failure('handler_error', messageOf(thrown), true);

function makeHarness(options: { batches?: ClaimedTask[][]; concurrency?: number; register?: Registration[] }) {
  const clock = new ManualClock();
  const client = new FakeQueueClient(options.batches ?? []);
  const registry = new HandlerRegistry();
  for (const { type, handler, classifier } of options.register ?? []) {
    registry.register(type, handler, classifier ?? retryableClassifier);
  }
  const log: string[] = [];
  const harness = new Harness({
    client,
    registry,
    queueName: 'jobs',
    concurrency: options.concurrency ?? 2,
    leaseMs: LEASE_MS,
    maxTaskExecutionMs: BUDGET_MS,
    clock,
    idleBackoff: new IdleBackoff(() => 0.5),
    log: (message) => log.push(message),
  });
  return { clock, client, harness, log };
}

describe('Harness', () => {
  it('dispatches by task type and acks the handler result under the claim id', async () => {
    const task = makeTask('http');
    const seen: Array<{ task: ClaimedTask; hasSignal: boolean }> = [];
    const { client, harness } = makeHarness({
      batches: [[task]],
      register: [{
        type: 'http',
        handler: async (t, ctx) => {
          seen.push({ task: t, hasSignal: ctx.signal instanceof AbortSignal });
          return { status: 200 };
        },
      }],
    });
    harness.start();
    await flushMicrotasks();

    expect(seen).toEqual([{ task, hasSignal: true }]);
    expect(client.ackCalls).toEqual([{ id: task.id, result: { status: 200 }, claimId: task.claimId }]);
    expect(client.nackCalls).toHaveLength(0);
    expect(harness.heldTasks()).toHaveLength(0);
    await harness.stop();
  });

  it('nacks a thrown handler error with the classifier verdict', async () => {
    const task = makeTask('js');
    const { client, harness } = makeHarness({
      batches: [[task]],
      register: [{
        type: 'js',
        handler: async () => {
          throw new Error('SyntaxError in payload');
        },
        classifier: () => failure('handler_terminal', 'script is broken', false),
      }],
    });
    harness.start();
    await flushMicrotasks();

    expect(client.ackCalls).toHaveLength(0);
    expect(client.nackCalls).toEqual([{
      id: task.id,
      args: { reason: 'script is broken', retryable: false, kind: 'handler_terminal', claimId: task.claimId },
    }]);
    await harness.stop();
  });

  it('falls back to classifyUnknown when the classifier itself throws', async () => {
    const task = makeTask('js');
    const { client, harness } = makeHarness({
      batches: [[task]],
      register: [{
        type: 'js',
        handler: async () => {
          throw new Error('boom');
        },
        classifier: () => {
          throw new Error('classifier bug');
        },
      }],
    });
    harness.start();
    await flushMicrotasks();

    expect(client.nackCalls).toHaveLength(1);
    expect(client.nackCalls[0]?.args).toEqual({
      reason: 'Error: boom', retryable: false, kind: 'unclassified', claimId: task.claimId,
    });
    await harness.stop();
  });

  it('nacks an unregistered task type as no_handler, terminal', async () => {
    const task = makeTask('llm');
    const { client, harness } = makeHarness({ batches: [[task]] });
    harness.start();
    await flushMicrotasks();

    expect(client.nackCalls).toHaveLength(1);
    const args = client.nackCalls[0]?.args;
    expect(args?.kind).toBe('no_handler');
    expect(args?.retryable).toBe(false);
    expect(args?.reason).toContain('llm');
    expect(harness.heldTasks()).toHaveLength(0);
    await harness.stop();
  });

  it('aborts and nacks timeout when the execution budget expires', async () => {
    const task = makeTask('http');
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{
        type: 'http',
        handler: (_t, ctx) => {
          captured.signal = ctx.signal;
          return new Promise(() => {});
        },
      }],
    });
    harness.start();
    await flushMicrotasks();
    expect(harness.heldTasks()).toEqual([{ id: task.id, claimId: task.claimId }]);

    await clock.advance(BUDGET_MS - 1);
    expect(client.nackCalls).toHaveLength(0);

    await clock.advance(1);
    expect(captured.signal?.aborted).toBe(true);
    expect(client.nackCalls).toHaveLength(1);
    const args = client.nackCalls[0]?.args;
    expect(args?.kind).toBe('timeout');
    expect(args?.retryable).toBe(false);
    expect(client.ackCalls).toHaveLength(0);
    expect(harness.heldTasks()).toHaveLength(0);
  });

  it('budget classification beats whatever the aborted handler then throws', async () => {
    const task = makeTask('http');
    let classified = 0;
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{
        type: 'http',
        handler: (_t, ctx) => new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
        classifier: () => {
          classified += 1;
          return failure('handler_error', 'abort mapped retryable by the http classifier', true);
        },
      }],
    });
    harness.start();
    await flushMicrotasks();

    await clock.advance(BUDGET_MS);
    expect(client.nackCalls).toHaveLength(1);
    const args = client.nackCalls[0]?.args;
    expect(args?.kind).toBe('timeout');
    expect(args?.retryable).toBe(false);
    expect(classified).toBe(0);
  });

  it('claims only free slots and claims again as slots free up', async () => {
    const first = makeTask('http');
    const second = makeTask('http');
    const gates = new Map<TaskId, ReturnType<typeof deferred<unknown>>>([
      [first.id, deferred<unknown>()],
      [second.id, deferred<unknown>()],
    ]);
    const { client, harness } = makeHarness({
      batches: [[first, second]],
      concurrency: 2,
      register: [{
        type: 'http',
        handler: (t) => {
          const gate = gates.get(t.id);
          if (gate === undefined) throw new Error(`no gate for ${t.id}`);
          return gate.promise;
        },
      }],
    });
    harness.start();
    await flushMicrotasks();

    expect(client.claimCalls).toEqual([{ queue: 'jobs', max: 2 }]);
    expect(harness.heldTasks()).toHaveLength(2);

    gates.get(first.id)?.resolve('done');
    await flushMicrotasks();
    expect(client.claimCalls).toHaveLength(2);
    expect(client.claimCalls[1]).toEqual({ queue: 'jobs', max: 1 });

    gates.get(second.id)?.resolve('done');
    await harness.stop();
  });

  it('sleeps per idle backoff on an empty claim and resets the curve on a non-empty one', async () => {
    // misses double the jitter ceiling (draws of 100 then 200 with random 0.5); a hit resets to 100
    const task = makeTask('http');
    const { clock, client, harness } = makeHarness({
      batches: [[], [], [task]],
      register: [{ type: 'http', handler: async () => 'done' }],
    });
    harness.start();
    await flushMicrotasks();
    expect(client.claimCalls).toHaveLength(1);

    await clock.advance(99);
    expect(client.claimCalls).toHaveLength(1);
    await clock.advance(1);
    expect(client.claimCalls).toHaveLength(2);

    await clock.advance(199);
    expect(client.claimCalls).toHaveLength(2);
    await clock.advance(1);
    // claim 3 was non-empty: it dispatches, resets the backoff, and a free slot claims again at once
    expect(client.claimCalls).toHaveLength(4);
    await clock.advance(99);
    expect(client.claimCalls).toHaveLength(4);
    await clock.advance(1);
    expect(client.claimCalls).toHaveLength(5); // back to the 100ms draw: the hit reset the curve
    await harness.stop();
  });

  it('treats a claim transport error like an empty queue: back off, retry, recover', async () => {
    const task = makeTask('http');
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      register: [{ type: 'http', handler: async () => 'done' }],
    });
    client.claimImpl = async () => {
      client.claimImpl = null; // fail exactly once, then fall back to the scripted batches
      throw new Error('fetch failed');
    };
    harness.start();
    await flushMicrotasks();
    expect(client.claimCalls).toHaveLength(1);
    expect(client.ackCalls).toHaveLength(0);

    await clock.advance(100); // the first idle-backoff draw
    expect(client.claimCalls.length).toBeGreaterThanOrEqual(2);
    expect(client.ackCalls).toHaveLength(1);
    await harness.stop();
  });

  it('after a refused renewal the only settle is the fenced timeout nack; the aborted handler adds nothing', async () => {
    const task = makeTask('http');
    const gate = deferred<unknown>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{
        type: 'http',
        handler: (_t, ctx) => {
          captured.signal = ctx.signal;
          return gate.promise;
        },
      }],
    });
    client.extendImpl = async () => null;
    harness.start();
    await flushMicrotasks();
    expect(harness.heldTasks()).toEqual([{ id: task.id, claimId: task.claimId }]);

    await clock.advance(TICK_MS);
    expect(captured.signal?.aborted).toBe(true);
    expect(harness.heldTasks()).toHaveLength(0);
    expect(client.claimCalls.length).toBeGreaterThanOrEqual(2); // the slot freed without a settle

    gate.reject(new Error('This operation was aborted'));
    await flushMicrotasks();
    expect(client.ackCalls).toHaveLength(0);
    expect(client.nackCalls).toHaveLength(1);
    expect(client.nackCalls[0]?.args).toMatchObject({ kind: 'timeout', retryable: false, claimId: task.claimId });
    await harness.stop();
  });

  it('a renewal refused by the queue sends a fenced terminal timeout nack; a deadline loss sends nothing', async () => {
    const task = makeTask('http');
    const gate = deferred<unknown>();
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{ type: 'http', handler: () => gate.promise }],
    });
    client.extendImpl = async () => null; // budget refusal or reclaim: the queue said no
    harness.start();
    await flushMicrotasks();
    await clock.advance(TICK_MS);
    await flushMicrotasks();
    expect(client.nackCalls).toHaveLength(1);
    expect(client.nackCalls[0]?.args).toMatchObject({ kind: 'timeout', retryable: false, claimId: task.claimId });
    gate.reject(new Error('aborted'));
    await flushMicrotasks();
    expect(client.nackCalls).toHaveLength(1); // the aborted handler's rejection is not a second verdict
    await harness.stop();
  });

  it('a deadline loss (transport silent for a lease) sends nothing: the row may still be ours and in budget', async () => {
    const task = makeTask('http');
    const gate = deferred<unknown>();
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{ type: 'http', handler: () => gate.promise }],
    });
    client.extendImpl = async () => { throw new Error('ECONNREFUSED'); };
    harness.start();
    await flushMicrotasks();
    await clock.advance(LEASE_MS + TICK_MS);
    await flushMicrotasks();
    expect(harness.heldTasks()).toHaveLength(0);
    expect(client.nackCalls).toHaveLength(0);
    gate.reject(new Error('aborted'));
    await flushMicrotasks();
    expect(client.nackCalls).toHaveLength(0);
    await harness.stop();
  });

  it('drops a fenced ack (false) silently', async () => {
    const task = makeTask('http');
    const { client, harness } = makeHarness({
      batches: [[task]],
      register: [{ type: 'http', handler: async () => 'done' }],
    });
    client.ackImpl = async () => false;
    harness.start();
    await flushMicrotasks();

    expect(client.ackCalls).toHaveLength(1);
    expect(client.nackCalls).toHaveLength(0);
    expect(harness.heldTasks()).toHaveLength(0);
    await harness.stop();
  });

  it('a fenced stale ack does not un-heartbeat the live re-claim of the same task', async () => {
    const id = randomUUID();
    const stale: ClaimedTask = { ...makeTask('http'), id };
    const live: ClaimedTask = { ...makeTask('http'), id };
    const staleGate = deferred<unknown>();
    const liveGate = deferred<unknown>();
    const { client, harness } = makeHarness({
      batches: [[stale], [live]],
      concurrency: 2,
      register: [{
        type: 'http',
        handler: (task) => (task.claimId === stale.claimId ? staleGate.promise : liveGate.promise),
      }],
    });
    // The queue fences the stale claim: its ack is refused, the live one is accepted.
    client.ackImpl = async (_id, _result, claimId) => claimId === live.claimId;
    harness.start();
    await flushMicrotasks();
    expect(harness.heldTasks()).toEqual([{ id, claimId: live.claimId }]);

    staleGate.resolve('stale done');
    await flushMicrotasks();
    expect(client.ackCalls.map((c) => c.claimId)).toEqual([stale.claimId]);
    // The live claim must still be heartbeated after the stale ack was fenced out.
    expect(harness.heldTasks()).toEqual([{ id, claimId: live.claimId }]);

    liveGate.resolve('live done');
    await flushMicrotasks();
    expect(harness.heldTasks()).toEqual([]);
    await harness.stop();
  });

  it('answers an oversized-result refusal with a terminal result_too_large nack', async () => {
    const task = makeTask('http');
    const { client, harness } = makeHarness({
      batches: [[task]],
      register: [{ type: 'http', handler: async () => 'done' }],
    });
    client.ackImpl = async () => {
      throw new ResultTooLargeError('result exceeds 262144 bytes');
    };
    harness.start();
    await flushMicrotasks();

    expect(client.ackCalls).toHaveLength(1);
    expect(client.nackCalls).toHaveLength(1);
    const args = client.nackCalls[0]?.args;
    expect(args?.kind).toBe('result_too_large');
    expect(args?.retryable).toBe(false);
    expect(harness.heldTasks()).toHaveLength(0);
    await harness.stop();
  });

  it('leaves a task held under the lease when ack throws a transport error (A19), and never retries the call', async () => {
    const task = makeTask('http');
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      register: [{ type: 'http', handler: async () => 'done' }],
    });
    client.ackImpl = async () => {
      throw new Error('socket hang up');
    };
    harness.start();
    await flushMicrotasks();

    expect(client.ackCalls).toHaveLength(1);
    expect(client.nackCalls).toHaveLength(0);
    expect(harness.heldTasks()).toEqual([{ id: task.id, claimId: task.claimId }]);

    // the next renewal verdict resolves it: the queue refuses, the task is dropped, still never re-acked
    client.extendImpl = async () => null;
    await clock.advance(TICK_MS);
    expect(harness.heldTasks()).toHaveLength(0);
    expect(client.ackCalls).toHaveLength(1);
    expect(client.nackCalls).toHaveLength(0);
    await harness.stop();
  });

  it('leaves a task held under the lease when nack throws a transport error, without crashing the loop', async () => {
    const task = makeTask('http');
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      register: [{
        type: 'http',
        handler: async () => {
          throw new Error('boom');
        },
      }],
    });
    client.nackImpl = async () => {
      throw new Error('socket hang up');
    };
    harness.start();
    await flushMicrotasks();

    expect(client.nackCalls).toHaveLength(1);
    expect(harness.heldTasks()).toEqual([{ id: task.id, claimId: task.claimId }]);

    const claimsBefore = client.claimCalls.length;
    await clock.advance(1_000);
    expect(client.claimCalls.length).toBeGreaterThan(claimsBefore); // the loop is still claiming
    expect(client.nackCalls).toHaveLength(1);
  });

  it('does not wedge on a black-holed ack: the slot frees when the lease is lost', async () => {
    const task = makeTask('http');
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{
        type: 'http',
        handler: async (_t, ctx) => {
          captured.signal = ctx.signal;
          return 'done';
        },
      }],
    });
    client.ackImpl = () => new Promise(() => {});
    harness.start();
    await flushMicrotasks();

    expect(client.ackCalls).toHaveLength(1);
    expect(client.claimCalls).toHaveLength(1); // the only slot is occupied by the unsettleable dispatch

    client.extendImpl = async () => null;
    await clock.advance(TICK_MS);
    await flushMicrotasks();
    expect(captured.signal?.aborted).toBe(true);
    expect(harness.heldTasks()).toHaveLength(0);
    expect(client.claimCalls.length).toBeGreaterThanOrEqual(2);
    expect(client.nackCalls).toHaveLength(1);
    expect(client.nackCalls[0]?.args).toMatchObject({ kind: 'timeout', retryable: false, claimId: task.claimId });
    await harness.stop();
  });

  it('stop() waits for a pending refused-renewal nack before resolving', async () => {
    const task = makeTask('http');
    const gate = deferred<unknown>();
    const nackGate = deferred<boolean>();
    const { clock, client, harness } = makeHarness({
      batches: [[task]],
      concurrency: 1,
      register: [{ type: 'http', handler: () => gate.promise }],
    });
    client.extendImpl = async () => null;
    client.nackImpl = () => nackGate.promise;
    harness.start();
    await flushMicrotasks();

    await clock.advance(TICK_MS);
    gate.reject(new Error('This operation was aborted'));
    await flushMicrotasks();
    expect(harness.heldTasks()).toHaveLength(0);
    expect(client.nackCalls).toHaveLength(1); // the fenced timeout nack is on the wire, unanswered

    let stopped = false;
    const stopping = harness.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false); // nothing is in flight, but a settle this worker owes is still pending

    nackGate.resolve(true);
    await stopping;
    expect(client.nackCalls).toHaveLength(1);
    expect(client.nackCalls[0]?.args).toMatchObject({ kind: 'timeout', retryable: false, claimId: task.claimId });
  });

  it('stop() stops claiming, drains in-flight dispatches, then resolves', async () => {
    const first = makeTask('http');
    const second = makeTask('http');
    const gates = new Map<TaskId, ReturnType<typeof deferred<unknown>>>([
      [first.id, deferred<unknown>()],
      [second.id, deferred<unknown>()],
    ]);
    const { clock, client, harness } = makeHarness({
      batches: [[first, second]],
      concurrency: 2,
      register: [{
        type: 'http',
        handler: (t) => {
          const gate = gates.get(t.id);
          if (gate === undefined) throw new Error(`no gate for ${t.id}`);
          return gate.promise;
        },
      }],
    });
    harness.start();
    await flushMicrotasks();

    let stopped = false;
    const stopping = harness.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    gates.get(first.id)?.resolve('one');
    await flushMicrotasks();
    expect(stopped).toBe(false); // still one dispatch in flight

    gates.get(second.id)?.resolve('two');
    await stopping;
    expect(client.ackCalls).toHaveLength(2);

    const claims = client.claimCalls.length;
    await clock.advance(60_000);
    expect(client.claimCalls).toHaveLength(claims); // no claims and no heartbeat after stop
  });

  it('logs one line per settle with id, type, attempt and outcome — never payload, result or reason', async () => {
    const ok = makeTask('http');
    const bad = makeTask('js');
    const { client, harness, log } = makeHarness({
      batches: [[ok, bad]],
      register: [
        { type: 'http', handler: async () => ({ secret: 'do-not-log' }) },
        { type: 'js', handler: async () => { throw new Error('SyntaxError: secret-source'); },
          classifier: () => failure('handler_terminal', 'SyntaxError: secret-source', false) },
      ],
    });
    harness.start();
    await flushMicrotasks();
    expect(client.ackCalls).toHaveLength(1);
    expect(client.nackCalls).toHaveLength(1);
    expect(log).toHaveLength(2);
    expect(log).toEqual(expect.arrayContaining([
      `acked http ${ok.id} attempt 1`,
      `nacked js ${bad.id} attempt 1: handler_terminal, terminal`,
    ]));
    expect(log.join('\n')).not.toMatch(/secret/);
    await harness.stop();
  });
});
