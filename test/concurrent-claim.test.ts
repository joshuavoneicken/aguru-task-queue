import { describe, expect, it } from 'vitest';
import { withServer } from './helpers/server.js';

// The brief's required test. Deliberately raw HTTP rather than HttpQueueClient: the property
// under test belongs to the server, and the test must not inherit a client library's bugs —
// or its kindnesses.

interface Span { worker: string; start: number; end: number }
interface Claimed { id: string; claimId: string }

const TASK_COUNT = 50;
const WORKERS = ['w1', 'w2', 'w3', 'w4'];
const MIXED_PAYLOADS = [
  { type: 'llm', payload: { model: 'stub', prompt: 'hi' } },
  { type: 'js', payload: { source: 'return 1' } },
  { type: 'http', payload: { method: 'GET', url: 'https://example.com/' } },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(baseUrl: string, workerId: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-id': workerId },
    body: JSON.stringify(body),
  });
}

async function enqueueMixed(baseUrl: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await post(baseUrl, 'seed', '/queues/jobs/tasks', MIXED_PAYLOADS[i % MIXED_PAYLOADS.length]);
    ids.push(((await res.json()) as { id: string }).id);
  }
  return ids;
}

async function claimBatch(baseUrl: string, worker: string, max: number): Promise<Claimed[]> {
  const res = await post(baseUrl, worker, '/queues/jobs/claim', { workerId: worker, max });
  return ((await res.json()) as { tasks: Claimed[] }).tasks;
}

async function ack(baseUrl: string, worker: string, task: Claimed): Promise<boolean> {
  const res = await post(baseUrl, worker, `/tasks/${task.id}/ack`, { result: { by: worker }, claimId: task.claimId });
  return res.status === 204;
}

function assertNoOverlap(spans: Map<string, Span[]>): void {
  // Per task, sort spans by start and require each to begin after the previous ended:
  // sequential reprocessing is at-least-once working; simultaneous processing is the defect.
  for (const [id, list] of spans) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start, `task ${id} processed concurrently`).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    }
  }
}

/** A processing span runs from the moment the claim response arrived to the moment the ack response
 * arrived: the whole interval in which this worker believed it held the task. Two claimants of one
 * task therefore overlap by construction, however the sleeps line up. */
async function claimAndProcessLoop(baseUrl: string, worker: string, spans: Map<string, Span[]>, done: Set<string>): Promise<void> {
  let idle = 0;
  while (done.size < TASK_COUNT && idle < 40) {
    const tasks = await claimBatch(baseUrl, worker, 5);
    const claimedAt = performance.now();
    if (tasks.length === 0) { idle += 1; await sleep(25); continue; }
    idle = 0;
    for (const task of tasks) {
      await sleep(5 + Math.random() * 20); // the "work"
      const acked = await ack(baseUrl, worker, task);
      // Recorded regardless of the ack outcome: the processing happened either way, and gating on
      // the ack would let the claim-id fence mask a double-claim (both claimants process, one acks).
      spans.set(task.id, [...(spans.get(task.id) ?? []), { worker, start: claimedAt, end: performance.now() }]);
      if (acked) done.add(task.id);
    }
  }
}

describe('concurrent-claim', () => {
  it('4 workers, 50 mixed tasks: every task processed at least once, no overlapping processing', async () => {
    await withServer(async ({ baseUrl }) => {
      const ids = await enqueueMixed(baseUrl, TASK_COUNT);
      const spans = new Map<string, Span[]>();
      const done = new Set<string>();

      await Promise.all(WORKERS.map((worker) => claimAndProcessLoop(baseUrl, worker, spans, done)));

      expect(done.size).toBe(TASK_COUNT);
      for (const id of ids) expect(spans.get(id)?.length ?? 0).toBeGreaterThanOrEqual(1);
      assertNoOverlap(spans);
      // The test runs in about two seconds against a 30 s lease, so no lease can expire and no
      // legitimate redelivery can happen: in this regime at-least-once must be exactly once, and a
      // second span for any task can only be a double-claim.
      for (const id of ids) expect(spans.get(id), `task ${id} claimed more than once`).toHaveLength(1);
    });
  });
});
