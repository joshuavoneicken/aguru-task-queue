import { enqueue, claim, ack, nack, extend, requeue, getTask } from './tasks.js';
import { reapExpired, drainExpired } from './reaper.js';
import { getStats } from './stats.js';
import { listDlq } from './dlq.js';
import { seedQueues, ensureQueue, queueExists, listQueues } from './queues.js';

// The store's surface as one structural type: the compiler proves the whole contract is
// implemented, and a reviewer reads the port in one place (SPEC §1). Deliberately not an
// interface with multiple implementations — the guarantees would not port.
export const store = {
  enqueue, claim, ack, nack, extend, requeue, getTask,
  reapExpired, drainExpired, getStats, listDlq,
  seedQueues, ensureQueue, queueExists, listQueues,
} as const;

export type TaskStore = typeof store;
