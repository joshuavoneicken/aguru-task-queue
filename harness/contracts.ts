import type { Failure } from './failure.js';

/**
 * A task handed to a handler. `type` selects the handler; `payload` is opaque to the harness and was
 * validated by whoever enqueued it. Ids are opaque tokens the harness carries but never inspects —
 * deliberately `string`, so the library hardcodes none of a host application's task types or id shapes.
 */
export interface ClaimedTask {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  claimId: string;
  leaseExpiresAt: string;
}

export interface HandlerContext {
  signal: AbortSignal;
}

/** Executes one claimed task; the resolved value is the task result the store persists. */
export type Handler = (task: ClaimedTask, ctx: HandlerContext) => Promise<unknown>;

/** Per-type mapping from a thrown value to a Failure — the single place retryability is decided. */
export type Classifier = (thrown: unknown) => Failure;

export interface NackArgs {
  reason: string;
  retryable: boolean;
  kind: string;
  forgiveAttempt?: boolean;
  claimId: string;
}

/**
 * The harness ↔ queue seam — the interface the harness depends on, so a host wires in whichever
 * transport it wants (an HTTP client, or a direct store adapter) and the tests substitute a fake.
 * The return values carry the ownership distinction the harness needs: `false`/`null` mean the queue
 * REFUSED (a lost lease, a fenced 409) — abandon the task now — while a thrown error says nothing
 * about ownership, so the harness keeps working under its own lease-loss clock instead.
 */
export interface QueueClient {
  claim(queue: string, max: number): Promise<ClaimedTask[]>;
  ack(id: string, result: unknown, claimId: string): Promise<boolean>;
  nack(id: string, args: NackArgs): Promise<boolean>;
  extend(id: string, claimId: string): Promise<string | null>;
}

/** Ack refused because the result exceeds the queue's storage cap. Retrying cannot help — the harness nacks terminal with kind `result_too_large`. */
export class ResultTooLargeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ResultTooLargeError';
  }
}
