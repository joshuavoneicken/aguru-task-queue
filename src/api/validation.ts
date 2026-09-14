import { z } from 'zod';
import { FAILURE_KINDS, RETRYABLE_BY_KIND } from '../domain/failure.js';
import { claimIdSchema, httpPayloadSchema, jsPayloadSchema, llmPayloadSchema } from '../domain/task.js';

// One convention for both caller-chosen identifiers: bounded and URL-safe, matching config's
// queuePolicySchema bound of 128. The enqueue path persists queue names via implicit creation,
// so an unvalidated :name would let any caller mint permanent rows of arbitrary content.
const boundedName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const workerId = boundedName;

export const queueName = boundedName;

const delay = z.number().int().min(0).max(604_800_000).optional();
const dedupeKey = z.string().min(1).max(256).optional();

// One branch per task type so a payload is validated against its own type's schema (SPEC §8);
// the payload shapes themselves live in domain/task.ts, next to the types they describe.
export const enqueueBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('llm'), payload: llmPayloadSchema, delay, dedupeKey }).strict(),
  z.object({ type: z.literal('js'), payload: jsPayloadSchema, delay, dedupeKey }).strict(),
  z.object({ type: z.literal('http'), payload: httpPayloadSchema, delay, dedupeKey }).strict(),
]);

/** Built per deployment: `max` is bounded by the configured claim limit, and a request above it is
 * rejected rather than clamped, so the caller learns the bound instead of silently getting less. */
export function claimBodyFor(claimMaxLimit: number) {
  return z.object({ workerId, max: z.number().int().min(1).max(claimMaxLimit) }).strict();
}

export const ackBody = z.object({ result: z.unknown().optional(), claimId: claimIdSchema.optional() }).strict();

// forgiveAttempt is inherently a retryable nack (§4's blameless release); paired with
// retryable: false the body contradicts itself. The two refines below are together the only
// guards — the store deliberately accepts the combinations they reject.
export const nackBody = z.object({
  reason: z.string().min(1).max(4096),
  retryable: z.boolean().default(true),
  forgiveAttempt: z.boolean().optional(),
  kind: z.enum(FAILURE_KINDS).optional(),
  claimId: claimIdSchema.optional(),
}).strict().refine((b) => !(b.forgiveAttempt === true && b.retryable === false), {
  message: 'forgiveAttempt contradicts retryable: false',
}).refine((b) => b.kind === undefined || RETRYABLE_BY_KIND[b.kind] === b.retryable, {
  message: 'kind disagrees with retryable',
});

export const extendBody = z.object({ workerId, claimId: claimIdSchema.optional() }).strict();

export const workerIdHeader = workerId;
