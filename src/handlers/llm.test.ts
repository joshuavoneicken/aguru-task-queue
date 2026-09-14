import { describe, expect, it } from 'vitest';
import { claimIdSchema, taskIdSchema } from '../domain/task.js';
import type { ClaimedTask } from '@aguru/harness';
import { classifyLlmError, createLlmHandler } from './llm.js';
import {
  LlmAuthError,
  LlmBadRequestError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmServerError,
  LlmTimeoutError,
  StubLlmProvider,
} from './provider.js';

function llmTask(payload: unknown): ClaimedTask {
  return {
    id: taskIdSchema.parse(crypto.randomUUID()),
    type: 'llm',
    payload,
    attempts: 1,
    claimId: claimIdSchema.parse(crypto.randomUUID()),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

const ctx = { signal: new AbortController().signal };

describe('createLlmHandler', () => {
  const handler = createLlmHandler(new StubLlmProvider());

  it('returns { model, content } with the prompt embedded deterministically', async () => {
    const result = await handler(llmTask({ model: 'stub-1', prompt: 'summarise the queue' }), ctx);
    expect(result).toEqual({ model: 'stub-1', content: 'stub(stub-1): summarise the queue' });
  });

  it('rejects a payload that fails the llm schema with LlmBadRequestError', async () => {
    await expect(handler(llmTask({ model: 'stub-1' }), ctx)).rejects.toBeInstanceOf(LlmBadRequestError);
    await expect(handler(llmTask({ model: 'stub-1', prompt: '' }), ctx)).rejects.toBeInstanceOf(LlmBadRequestError);
    await expect(handler(llmTask('not an object'), ctx)).rejects.toBeInstanceOf(LlmBadRequestError);
    await expect(handler(llmTask({ model: 'stub-1', prompt: 'p', extra: true }), ctx)).rejects.toBeInstanceOf(
      LlmBadRequestError,
    );
  });

  it.each([
    ['FAIL:rate_limit', LlmRateLimitError],
    ['FAIL:server', LlmServerError],
    ['FAIL:auth', LlmAuthError],
    ['FAIL:refusal', LlmRefusalError],
    ['FAIL:timeout', LlmTimeoutError],
  ])('a %s prompt prefix surfaces the injected provider failure', async (prefix, errorClass) => {
    await expect(handler(llmTask({ model: 'stub-1', prompt: `${prefix} rest of prompt` }), ctx)).rejects.toBeInstanceOf(
      errorClass,
    );
  });
});

describe('StubLlmProvider', () => {
  it('truncates long prompts in the deterministic completion', async () => {
    const prompt = 'p'.repeat(200);
    const { content } = await new StubLlmProvider().complete({ model: 'stub-1', prompt }, ctx.signal);
    expect(content).toBe(`stub(stub-1): ${'p'.repeat(64)}`);
  });

  it('throws a timeout-shaped error when the signal is already aborted', async () => {
    const aborted = AbortSignal.abort();
    await expect(new StubLlmProvider().complete({ model: 'stub-1', prompt: 'p' }, aborted)).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
  });
});

describe('classifyLlmError — the single place llm retryability is decided (§6)', () => {
  it.each([
    ['rate limit', new LlmRateLimitError('429')],
    ['server error', new LlmServerError('503')],
    ['timeout', new LlmTimeoutError('deadline')],
  ])('%s is retryable handler_error', (_label, thrown) => {
    expect(classifyLlmError(thrown)).toMatchObject({ kind: 'handler_error', retryable: true });
  });

  it.each([
    ['auth failure', new LlmAuthError('bad key')],
    ['content refusal', new LlmRefusalError('declined')],
    ['bad request', new LlmBadRequestError('invalid model')],
  ])('%s is terminal handler_terminal', (_label, thrown) => {
    expect(classifyLlmError(thrown)).toMatchObject({ kind: 'handler_terminal', retryable: false });
  });

  it('anything unrecognised falls through to classifyUnknown (unclassified, terminal)', () => {
    expect(classifyLlmError(new RangeError('boom'))).toEqual({
      kind: 'unclassified',
      retryable: false,
      message: 'RangeError: boom',
    });
    expect(classifyLlmError('string throw')).toMatchObject({ kind: 'unclassified', retryable: false });
  });

  it('carries the thrown error name and message for DLQ triage', () => {
    expect(classifyLlmError(new LlmRateLimitError('slow down')).message).toBe('LlmRateLimitError: slow down');
  });
});
