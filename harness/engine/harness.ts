import type { Clock } from '../clock.js';
import type { ClaimedTask, Classifier, QueueClient } from '../contracts.js';
import { ResultTooLargeError } from '../contracts.js';
import { classifyUnknown, failure, type Failure } from '../failure.js';
import { Heartbeat, type HeldTask, type LossReason } from './heartbeat.js';
import { IdleBackoff } from './idle-backoff.js';
import type { HandlerRegistry } from './registry.js';

export interface HarnessOptions {
  client: QueueClient;
  registry: HandlerRegistry;
  queueName: string;
  concurrency: number;
  leaseMs: number;
  maxTaskExecutionMs: number;
  clock: Clock;
  idleBackoff?: IdleBackoff;
  log?: (message: string) => void;
}

interface InFlightRecord {
  readonly controller: AbortController;
  readonly claimId: string;
  lost: boolean;
}

type HandlerOutcome =
  | { readonly kind: 'completed'; readonly value: unknown }
  | { readonly kind: 'threw'; readonly thrown: unknown }
  | { readonly kind: 'budget' };

// The worker's claim/dispatch/settle loop. Every claimed task ends in exactly one of: an ack, a
// nack, or a deliberate nothing — the last when the queue has already ruled the claim dead (a lost
// lease, a fenced 409) or when transport failed and ownership is unknowable, in which case the
// lease, not this process, decides the task's fate.
export class Harness {
  private readonly client: QueueClient;
  private readonly registry: HandlerRegistry;
  private readonly queueName: string;
  private readonly concurrency: number;
  private readonly maxTaskExecutionMs: number;
  private readonly clock: Clock;
  private readonly idleBackoff: IdleBackoff;
  private readonly heartbeat: Heartbeat;
  private readonly log: (message: string) => void;

  private readonly inFlight = new Map<string, InFlightRecord>();
  // Settles owed after a task has already left inFlight: a refused renewal frees the slot at once
  // but its fenced nack is still on the wire, and stop() must not exit before it is answered.
  private readonly pendingSettles = new Set<Promise<void>>();
  private running = false;
  private loop: Promise<void> | null = null;
  private waiters: Array<() => void> = [];
  private pendingSleep: { handle: NodeJS.Timeout; resolve: () => void } | null = null;

  constructor(options: HarnessOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.queueName = options.queueName;
    this.concurrency = options.concurrency;
    this.maxTaskExecutionMs = options.maxTaskExecutionMs;
    this.clock = options.clock;
    this.idleBackoff = options.idleBackoff ?? new IdleBackoff();
    this.log = options.log ?? (() => undefined);
    this.heartbeat = new Heartbeat({
      client: options.client,
      leaseMs: options.leaseMs,
      clock: options.clock,
      onLost: (id, reason) => this.handleLost(id, reason),
    });
  }

  start(): void {
    if (this.loop !== null) throw new Error('harness already started');
    this.running = true;
    this.heartbeat.start();
    this.loop = this.run();
  }

  /**
   * Stops claiming, waits for in-flight dispatches to settle or lose their leases and for any settle
   * still on the wire, then stops the heartbeat.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelSleep();
    this.notify();
    if (this.loop !== null) await this.loop;
    while (this.inFlight.size > 0) await this.change();
    await Promise.allSettled([...this.pendingSettles]);
    this.heartbeat.stop();
  }

  /** Every task this worker still holds a lease claim on — a superset of the dispatching ones. */
  heldTasks(): HeldTask[] {
    return this.heartbeat.held();
  }

  private async run(): Promise<void> {
    while (this.running) {
      const free = this.concurrency - this.inFlight.size;
      if (free <= 0) {
        await this.change();
        continue;
      }
      let batch: ClaimedTask[];
      try {
        batch = await this.client.claim(this.queueName, free);
      } catch {
        batch = []; // an unreachable queue claims nothing; back off exactly like an empty one
      }
      if (batch.length === 0) {
        if (this.running) await this.sleep(this.idleBackoff.nextDelayMs());
        continue;
      }
      this.idleBackoff.reset();
      // A batch that raced stop() is still dispatched: the claim already took the lease, and
      // draining it here is cheaper than letting it expire. stop() waits for these too.
      for (const task of batch) void this.dispatch(task);
    }
  }

  private async dispatch(task: ClaimedTask): Promise<void> {
    const record: InFlightRecord = { controller: new AbortController(), claimId: task.claimId, lost: false };
    this.inFlight.set(task.id, record);
    this.heartbeat.track({ id: task.id, claimId: task.claimId });
    try {
      await this.execute(task, record);
    } finally {
      if (this.inFlight.get(task.id) === record) {
        this.inFlight.delete(task.id);
        this.notify();
      }
    }
  }

  private async execute(task: ClaimedTask, record: InFlightRecord): Promise<void> {
    const registration = this.registry.resolve(task.type);
    if (registration === null) {
      await this.deliverNack(task, failure('no_handler', `no handler registered for task type "${task.type}"`, false), record);
      return;
    }

    let budgetExpired = false;
    let budgetTimer: NodeJS.Timeout | null = null;
    const budget = new Promise<void>((resolve) => {
      budgetTimer = this.clock.setTimeout(() => {
        budgetExpired = true;
        record.controller.abort();
        resolve();
      }, this.maxTaskExecutionMs);
    });
    const run = Promise.resolve().then(() => registration.handler(task, { signal: record.controller.signal }));

    const outcome = await Promise.race<HandlerOutcome>([
      run.then(
        (value): HandlerOutcome => ({ kind: 'completed', value }),
        (thrown): HandlerOutcome => ({ kind: 'threw', thrown }),
      ),
      budget.then((): HandlerOutcome => ({ kind: 'budget' })),
    ]);
    if (budgetTimer !== null) this.clock.clearTimeout(budgetTimer);

    // The budget verdict wins over whatever the aborted handler then throws: llm and http map
    // their own abort errors as retryable, which is safe only because this branch outranks them.
    if (outcome.kind === 'budget' || (outcome.kind === 'threw' && budgetExpired)) {
      run.catch(() => undefined); // the aborted handler's eventual rejection is not this task's verdict
      await this.deliverNack(task, failure('timeout', `exceeded the ${this.maxTaskExecutionMs}ms execution budget`, false), record);
      return;
    }
    if (outcome.kind === 'completed') {
      await this.deliverAck(task, outcome.value, record);
      return;
    }
    await this.deliverNack(task, this.classify(registration.classifier, outcome.thrown), record);
  }

  private classify(classifier: Classifier, thrown: unknown): Failure {
    try {
      return classifier(thrown);
    } catch {
      return classifyUnknown(thrown);
    }
  }

  private async deliverAck(task: ClaimedTask, result: unknown, record: InFlightRecord): Promise<void> {
    if (record.lost) return;
    try {
      const acked = await this.client.ack(task.id, result, task.claimId); // false = fenced out: not ours, drop silently
      this.heartbeat.release(task.id, task.claimId);
      if (acked) this.log(`acked ${task.type} ${task.id} attempt ${task.attempts}`);
    } catch (thrown) {
      if (thrown instanceof ResultTooLargeError) {
        await this.deliverNack(task, failure('result_too_large', thrown.message, false), record);
        return;
      }
      // Transport failure: the ack may or may not have landed, so ownership is unknowable.
      // Never retried — the task stays under the heartbeat and the lease decides.
    }
  }

  private async deliverNack(task: ClaimedTask, verdict: Failure, record: InFlightRecord): Promise<void> {
    if (record.lost) return;
    try {
      const nacked = await this.client.nack(task.id, {
        reason: verdict.message,
        retryable: verdict.retryable,
        kind: verdict.kind,
        claimId: task.claimId,
      });
      this.heartbeat.release(task.id, task.claimId);
      if (nacked) {
        this.log(`nacked ${task.type} ${task.id} attempt ${task.attempts}: ${verdict.kind}, ${verdict.retryable ? 'retryable' : 'terminal'}`);
      }
    } catch {
      // Same rule as an ack transport failure: stay held, let the lease decide.
    }
  }

  // A refused renewal means the queue ruled on this claim: either the row was reclaimed (a nack is
  // fenced out, harmless) or the attempt is past its execution budget while still ours, in which
  // case the verdict is the terminal timeout the budget timer would have delivered one latency
  // later. A deadline loss says nothing about ownership, so it sends nothing (§3, A19).
  private handleLost(id: string, reason: LossReason): void {
    const record = this.inFlight.get(id);
    if (record === undefined) return; // already settled with the queue; nothing left to abort
    record.lost = true;
    this.inFlight.delete(id); // the slot frees now — a black-holed settle call must not wedge the loop
    record.controller.abort();
    this.notify();
    if (reason === 'refused') {
      const settle: Promise<void> = this.nackAfterRefusedRenewal(id, record.claimId)
        .finally(() => this.pendingSettles.delete(settle));
      this.pendingSettles.add(settle);
    }
  }

  private async nackAfterRefusedRenewal(id: string, claimId: string): Promise<void> {
    try {
      await this.client.nack(id, {
        reason: `renewal refused after the ${this.maxTaskExecutionMs}ms execution budget`,
        retryable: false,
        kind: 'timeout',
        claimId,
      });
    } catch {
      // best effort: transport failed, the lease decides
    }
  }

  private change(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.clock.setTimeout(() => {
        this.pendingSleep = null;
        resolve();
      }, ms);
      this.pendingSleep = { handle, resolve };
    });
  }

  private cancelSleep(): void {
    if (this.pendingSleep === null) return;
    this.clock.clearTimeout(this.pendingSleep.handle);
    this.pendingSleep.resolve();
    this.pendingSleep = null;
  }
}
