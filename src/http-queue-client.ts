import { z } from 'zod';
import {
  ResultTooLargeError,
  type ClaimedTask,
  type NackArgs,
  type QueueClient,
} from '@aguru/harness';
import { claimIdSchema, taskIdSchema, TASK_TYPES } from './domain/task.js';

// The HTTP implementation of the harness's QueueClient: the transport a worker uses when it reaches
// the queue over the API rather than the database directly. It maps the API's 409s onto the
// interface's `false`/`null` (the queue REFUSED, the lease is gone) and everything unexpected onto a
// throw (transport trouble, no ownership verdict), which is the distinction the harness relies on.

/** A status the contract does not account for — protocol trouble, not an ownership verdict, so it throws like a transport failure. */
export class QueueApiError extends Error {
  constructor(readonly status: number, operation: string, detail: string) {
    super(`${operation} returned ${status}: ${detail}`);
    this.name = 'QueueApiError';
  }
}

const wireTask = z.object({
  id: taskIdSchema,
  type: z.enum(TASK_TYPES),
  payload: z.unknown(),
  attempts: z.number().int().nonnegative(),
  claimId: claimIdSchema,
  leaseUntil: z.string().datetime(),
});

const claimResponse = z.object({ tasks: z.array(wireTask) });
const extendResponse = z.object({ leaseUntil: z.string().datetime() });

async function problemDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string') {
      return body.detail;
    }
  } catch {
    // not problem+json; the status alone will have to do
  }
  return res.statusText;
}

async function discardBody(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => undefined);
}

export interface HttpQueueClientOptions {
  transportTimeoutMs?: number;
}

const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;

export class HttpQueueClient implements QueueClient {
  private readonly baseUrl: string;
  private readonly transportTimeoutMs: number;

  constructor(baseUrl: string, private readonly workerId: string, options: HttpQueueClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
  }

  async claim(queue: string, max: number): Promise<ClaimedTask[]> {
    const res = await this.post(`/queues/${encodeURIComponent(queue)}/claim`, { workerId: this.workerId, max });
    if (res.status !== 200) throw new QueueApiError(res.status, 'claim', await problemDetail(res));
    const { tasks } = claimResponse.parse(await res.json());
    return tasks.map((t) => ({
      id: t.id, type: t.type, payload: t.payload, attempts: t.attempts,
      claimId: t.claimId, leaseExpiresAt: t.leaseUntil,
    }));
  }

  async ack(id: string, result: unknown, claimId: string): Promise<boolean> {
    const res = await this.post(`/tasks/${id}/ack`, { result, claimId });
    if (res.status === 204) return true;
    if (res.status === 409) {
      await discardBody(res);
      return false;
    }
    if (res.status === 413) throw new ResultTooLargeError(await problemDetail(res));
    throw new QueueApiError(res.status, 'ack', await problemDetail(res));
  }

  async nack(id: string, args: NackArgs): Promise<boolean> {
    const res = await this.post(`/tasks/${id}/nack`, {
      reason: args.reason, retryable: args.retryable, kind: args.kind, claimId: args.claimId,
      ...(args.forgiveAttempt !== undefined ? { forgiveAttempt: args.forgiveAttempt } : {}),
    });
    if (res.status === 204) return true;
    if (res.status === 409) {
      await discardBody(res);
      return false;
    }
    throw new QueueApiError(res.status, 'nack', await problemDetail(res));
  }

  async extend(id: string, claimId: string): Promise<string | null> {
    const res = await this.post(`/tasks/${id}/extend`, { workerId: this.workerId, claimId });
    if (res.status === 200) return extendResponse.parse(await res.json()).leaseUntil;
    if (res.status === 409) {
      await discardBody(res);
      return null;
    }
    throw new QueueApiError(res.status, 'extend', await problemDetail(res));
  }

  // The timeout turns a black-holed call into a throw — the transport-error verdict — so a server
  // that accepts and never answers cannot wedge the claim loop or a drain forever.
  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-id': this.workerId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.transportTimeoutMs),
    });
  }
}
