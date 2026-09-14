import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listQueues, requeue, ApiError } from './api.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('api', () => {
  it('parses the queues list and sends no worker header — the UI is not a worker', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ queues: ['jobs'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const names = await listQueues();
    expect(names).toEqual(['jobs']);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = ((init?.headers ?? {}) as Record<string, string>);
    expect(headers['x-worker-id']).toBeUndefined();
  });

  it('throws ApiError on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 409 })));
    await expect(requeue('abc')).rejects.toBeInstanceOf(ApiError);
  });

  it('carries the problem+json type and prefers its detail as the message', async () => {
    const problem = {
      type: 'https://example.test/problems/not_in_dlq',
      title: 'Conflict',
      status: 409,
      detail: 'task abc is not in the DLQ',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(problem), {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
    );
    const err = await requeue('abc').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) throw new Error('unreachable');
    expect(err.status).toBe(409);
    expect(err.problemType).toBe('https://example.test/problems/not_in_dlq');
    expect(err.message).toBe('task abc is not in the DLQ');
  });

  it('falls back safely when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 })),
    );
    const err = await requeue('abc').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) throw new Error('unreachable');
    expect(err.status).toBe(502);
    expect(err.problemType).toBeUndefined();
    expect(err.message).toContain('502');
  });
});
