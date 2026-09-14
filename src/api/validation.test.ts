import { describe, expect, it } from 'vitest';
import { enqueueBody, nackBody, claimBodyFor, ackBody, extendBody } from './validation.js';

describe('enqueueBody', () => {
  it('accepts each task type with its own payload shape and rejects unknown fields', () => {
    expect(enqueueBody.safeParse({ type: 'llm', payload: { model: 'm', prompt: 'p' } }).success).toBe(true);
    expect(enqueueBody.safeParse({ type: 'js', payload: { source: 'return 1' }, delay: 5000, dedupeKey: 'k' }).success).toBe(true);
    expect(enqueueBody.safeParse({ type: 'http', payload: { method: 'GET', url: 'https://example.com' } }).success).toBe(true);
    expect(enqueueBody.safeParse({ type: 'js', payload: { source: '1' }, priority: 9 }).success).toBe(false);
    expect(enqueueBody.safeParse({ type: 'js', payload: { source: '1', shell: true } }).success).toBe(false);
    expect(enqueueBody.safeParse({ type: 'llm', payload: { source: '1' } }).success).toBe(false); // wrong shape for type
  });
});

describe('claimBodyFor', () => {
  it('bounds max by the configured claim limit: 1..limit accepted, above rejected', () => {
    const body = claimBodyFor(10);
    expect(body.safeParse({ workerId: 'w', max: 10 }).success).toBe(true);
    expect(body.safeParse({ workerId: 'w', max: 11 }).success).toBe(false);
    expect(body.safeParse({ workerId: 'w', max: 0 }).success).toBe(false);
    expect(body.safeParse({ max: 1 }).success).toBe(false);
  });
});

describe('nackBody', () => {
  it('defaults retryable to true, accepts kind and claimId, rejects forgive+terminal (§8)', () => {
    const minimal = nackBody.parse({ reason: 'it broke' });
    expect(minimal.retryable).toBe(true);
    expect(nackBody.safeParse({ reason: 'drain', retryable: true, forgiveAttempt: true, kind: 'worker_shutdown' }).success).toBe(true);
    expect(nackBody.safeParse({ reason: 'x', retryable: false, forgiveAttempt: true }).success).toBe(false);
    expect(nackBody.safeParse({ reason: 'x', kind: 'not_a_kind' }).success).toBe(false);
    expect(nackBody.safeParse({ reason: 'x'.repeat(5000) }).success).toBe(false);
  });

  it('rejects a kind whose retryability disagrees with the retryable flag', () => {
    expect(nackBody.safeParse({ reason: 'x', kind: 'handler_terminal', retryable: true }).success).toBe(false);
    expect(nackBody.safeParse({ reason: 'x', kind: 'handler_error', retryable: false }).success).toBe(false);
    expect(nackBody.safeParse({ reason: 'x', kind: 'handler_terminal', retryable: false }).success).toBe(true);
    expect(nackBody.safeParse({ reason: 'x', kind: 'handler_error' }).success).toBe(true); // retryable defaults true
    expect(nackBody.safeParse({ reason: 'x', kind: 'timeout' }).success).toBe(false); // timeout is terminal; default true disagrees
  });
});

describe('ackBody / extendBody', () => {
  it('shapes hold', () => {
    expect(ackBody.safeParse({ result: { anything: true } }).success).toBe(true);
    expect(ackBody.safeParse({}).success).toBe(true); // result optional -> stored as null
    expect(extendBody.safeParse({ workerId: 'w1' }).success).toBe(true);
    expect(extendBody.safeParse({}).success).toBe(false);
  });
});
