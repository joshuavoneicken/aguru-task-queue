/**
 * The worker harness — a self-contained library a worker process imports. It claims tasks in
 * batches, dispatches each to the handler registered for its type, heartbeats leases, and settles
 * every task with an ack or a nack (moving exhausted work to the DLQ is the queue's job on nack).
 *
 * It depends only on the injected `QueueClient` (the queue transport), a `Clock`, and the handlers a
 * host registers — it hardcodes none of a host's task types, and the app consumes it as the
 * `@aguru/harness` workspace package.
 */
export { Harness, type HarnessOptions } from './engine/harness.js';
export { HandlerRegistry, type Registration } from './engine/registry.js';
export { Heartbeat, type HeldTask } from './engine/heartbeat.js';
export { IdleBackoff } from './engine/idle-backoff.js';
export { systemClock, type Clock } from './clock.js';
export { createLifecycle, installLifecycle, type Lifecycle, type LifecycleOptions } from './engine/lifecycle.js';
export {
  ResultTooLargeError,
  type ClaimedTask,
  type Classifier,
  type Handler,
  type HandlerContext,
  type NackArgs,
  type QueueClient,
} from './contracts.js';
export { classifyUnknown, failure, messageOf, type Failure } from './failure.js';
