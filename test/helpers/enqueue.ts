import type pg from 'pg';
import type { QueuePolicyValues } from '../../src/config.js';
import { ensureQueue } from '../../src/store/queues.js';
import { enqueue as storeEnqueue, type EnqueueInput } from '../../src/store/tasks.js';
import type { TaskId } from '../../src/domain/task.js';

export const TEST_POLICY: QueuePolicyValues = {
  maxAttempts: 5, backoffBaseMs: 3000, backoffCapMs: 300_000, dedupeWindowMs: 600_000,
};

/** What the API does on enqueue: make sure the queue exists with the default policy, then insert. */
export async function enqueue(
  pool: pg.Pool, queue: string, input: EnqueueInput,
): Promise<{ id: TaskId; created: boolean }> {
  await ensureQueue(pool, queue, TEST_POLICY);
  return storeEnqueue(pool, queue, input);
}
