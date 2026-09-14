import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimIdSchema, taskIdSchema } from '../src/domain/task.js';
import type { ClaimedTask } from '@aguru/harness';
import {
  classifyHttpError,
  createHttpHandler,
  HttpBadRequestError,
  HttpStatusError,
  HttpTooManyRedirectsError,
} from '../src/handlers/http.js';
import { HttpBlockedError } from '../src/handlers/ssrf.js';

const BODY_MAX_BYTES = 4096;
const INFLATED_BYTES = 256 * 1024;

function httpTask(payload: unknown): ClaimedTask {
  return {
    id: taskIdSchema.parse(crypto.randomUUID()),
    type: 'http',
    payload,
    attempts: 1,
    claimId: claimIdSchema.parse(crypto.randomUUID()),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

const ctx = { signal: new AbortController().signal };
const handler = createHttpHandler({ allowLoopback: true, bodyMaxBytes: BODY_MAX_BYTES, redirectMax: 5 });

let upstream: Server;
let mirror: Server;
let base: string;
let mirrorBase: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function bodyOf(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'body' in result && typeof result.body === 'string') {
    return result.body;
  }
  throw new Error('result carries no string body');
}

function routeMirror(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sawAuthorization: req.headers.authorization !== undefined }));
}

function routeUpstream(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', base);
  switch (url.pathname) {
    case '/ok':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from ok');
      return;
    case '/echo': {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    case '/big':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(BODY_MAX_BYTES * 4));
      return;
    case '/gzip-bomb':
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('y'.repeat(INFLATED_BYTES))));
      return;
    case '/hop/1':
      res.writeHead(302, { location: '/hop/2' });
      res.end();
      return;
    case '/hop/2':
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    case '/loop':
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    case '/to-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    case '/to-mirror':
      res.writeHead(302, { location: `${mirrorBase}/reflect` });
      res.end();
      return;
    case '/see-other':
      res.writeHead(303, { location: '/echo' });
      res.end();
      return;
    case '/echo-headers':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ idempotencyKey: req.headers['idempotency-key'] ?? null }));
      return;
    case '/never':
      return; // accept the request, answer nothing — the timeout must fire
    case '/reset':
      req.socket.destroy();
      return;
    default: {
      const status = /^\/status\/(\d{3})$/.exec(url.pathname);
      if (status !== null) {
        res.writeHead(Number(status[1]));
        res.end('status body');
        return;
      }
      res.writeHead(404);
      res.end();
    }
  }
}

beforeAll(async () => {
  mirror = createServer(routeMirror);
  mirrorBase = await listen(mirror);
  upstream = createServer(routeUpstream);
  base = await listen(upstream);
});

afterAll(async () => {
  for (const server of [upstream, mirror]) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('createHttpHandler', () => {
  it('returns { status, body, truncated: false } for a small response', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/ok` }), ctx)).resolves.toEqual({
      status: 200,
      body: 'hello from ok',
      truncated: false,
    });
  });

  it('forwards method and body', async () => {
    const result = await handler(httpTask({ method: 'POST', url: `${base}/echo`, body: 'ping' }), ctx);
    expect(result).toMatchObject({ status: 200, truncated: false });
    expect(JSON.parse(bodyOf(result))).toEqual({ method: 'POST', body: 'ping' });
  });

  it('truncates a plain body larger than bodyMaxBytes and flags it', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/big` }), ctx)).resolves.toEqual({
      status: 200,
      body: 'x'.repeat(BODY_MAX_BYTES),
      truncated: true,
    });
  });

  it('counts the cap post-decompression: a small gzip bomb hits the cap, not the heap', async () => {
    // The wire payload fits comfortably under the cap; only counting inflated bytes truncates it.
    expect(gzipSync(Buffer.from('y'.repeat(INFLATED_BYTES))).byteLength).toBeLessThan(BODY_MAX_BYTES);
    await expect(handler(httpTask({ method: 'GET', url: `${base}/gzip-bomb` }), ctx)).resolves.toEqual({
      status: 200,
      body: 'y'.repeat(BODY_MAX_BYTES),
      truncated: true,
    });
  });

  it('follows a redirect chain of 2 to the final response', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/hop/1` }), ctx)).resolves.toEqual({
      status: 200,
      body: 'hello from ok',
      truncated: false,
    });
  });

  it('throws HttpTooManyRedirectsError past redirectMax', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/loop` }), ctx)).rejects.toBeInstanceOf(
      HttpTooManyRedirectsError,
    );
  });

  it('re-validates every redirect hop: a redirect to the metadata address is blocked', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/to-metadata` }), ctx)).rejects.toBeInstanceOf(
      HttpBlockedError,
    );
  });

  it('drops authorization on a cross-origin redirect', async () => {
    const result = await handler(
      httpTask({ method: 'GET', url: `${base}/to-mirror`, headers: { authorization: 'Bearer token' } }),
      ctx,
    );
    expect(JSON.parse(bodyOf(result))).toEqual({ sawAuthorization: false });
  });

  it('a 303 downgrades the follow-up to a body-less GET', async () => {
    const result = await handler(httpTask({ method: 'POST', url: `${base}/see-other`, body: 'ping' }), ctx);
    expect(JSON.parse(bodyOf(result))).toEqual({ method: 'GET', body: '' });
  });

  it('sends Idempotency-Key: <task.id> so a repeated execution can be deduplicated downstream', async () => {
    const task = httpTask({ method: 'POST', url: `${base}/echo-headers`, body: '{}' });
    const result = await handler(task, ctx);
    expect(JSON.parse(bodyOf(result))).toEqual({ idempotencyKey: task.id });
  });

  it('a caller-supplied Idempotency-Key wins over the task id', async () => {
    const task = httpTask({ method: 'POST', url: `${base}/echo-headers`, headers: { 'Idempotency-Key': 'caller-key' }, body: '{}' });
    const result = await handler(task, ctx);
    expect(JSON.parse(bodyOf(result))).toEqual({ idempotencyKey: 'caller-key' });
  });

  it('rejects a credentials-bearing URL', async () => {
    await expect(
      handler(httpTask({ method: 'GET', url: `${base.replace('http://', 'http://u:p@')}/ok` }), ctx),
    ).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it('blocks a denied target before any connection is attempted', async () => {
    await expect(handler(httpTask({ method: 'GET', url: 'http://10.0.0.1/' }), ctx)).rejects.toBeInstanceOf(
      HttpBlockedError,
    );
  });

  it('a non-http(s) url fails schema re-validation before the SSRF guard ever runs', async () => {
    await expect(handler(httpTask({ method: 'GET', url: 'ftp://example.com/x' }), ctx)).rejects.toBeInstanceOf(
      HttpBadRequestError,
    );
  });

  it('honours payload.timeoutMs against a server that never responds, classified retryable', async () => {
    const thrown = await handler(httpTask({ method: 'GET', url: `${base}/never`, timeoutMs: 200 }), ctx).then(
      () => {
        throw new Error('expected the request to time out');
      },
      (e: unknown) => e,
    );
    expect(classifyHttpError(thrown)).toMatchObject({ kind: 'handler_error', retryable: true });
  });

  it('throws HttpStatusError for 4xx/5xx responses', async () => {
    await expect(handler(httpTask({ method: 'GET', url: `${base}/status/503` }), ctx)).rejects.toBeInstanceOf(
      HttpStatusError,
    );
    await expect(handler(httpTask({ method: 'GET', url: `${base}/status/404` }), ctx)).rejects.toBeInstanceOf(
      HttpStatusError,
    );
  });

  it('a connection reset classifies as a retryable network error', async () => {
    const thrown = await handler(httpTask({ method: 'GET', url: `${base}/reset` }), ctx).then(
      () => {
        throw new Error('expected the connection to reset');
      },
      (e: unknown) => e,
    );
    expect(classifyHttpError(thrown)).toMatchObject({ kind: 'handler_error', retryable: true });
  });

  it('re-validates the payload and throws a terminal bad-request error on mismatch', async () => {
    await expect(handler(httpTask({ url: `${base}/ok` }), ctx)).rejects.toBeInstanceOf(HttpBadRequestError);
    await expect(handler(httpTask('not an object'), ctx)).rejects.toBeInstanceOf(HttpBadRequestError);
    await expect(
      handler(httpTask({ method: 'GET', url: `${base}/ok`, extra: true }), ctx),
    ).rejects.toBeInstanceOf(HttpBadRequestError);
  });
});

describe('classifyHttpError — the single place http retryability is decided (§6)', () => {
  it.each([[429], [500], [502], [503]])('status %d is retryable handler_error', (status) => {
    expect(classifyHttpError(new HttpStatusError(status))).toMatchObject({ kind: 'handler_error', retryable: true });
  });

  it.each([[400], [403], [404], [410]])('status %d is terminal', (status) => {
    expect(classifyHttpError(new HttpStatusError(status))).toMatchObject({
      kind: 'handler_terminal',
      retryable: false,
    });
  });

  it.each([
    ['SSRF-blocked', new HttpBlockedError('blocked')],
    ['too many redirects', new HttpTooManyRedirectsError('looped')],
    ['malformed URL / bad payload', new HttpBadRequestError('malformed url')],
  ])('%s is terminal', (_label, thrown) => {
    expect(classifyHttpError(thrown)).toMatchObject({ kind: 'handler_terminal', retryable: false });
  });

  it('a transient resolver failure (EAI_AGAIN) is retryable — the one DNS failure time can fix (A21)', () => {
    const thrown = Object.assign(new Error('getaddrinfo EAI_AGAIN api.example.com'), { code: 'EAI_AGAIN' });
    expect(classifyHttpError(thrown)).toMatchObject({ kind: 'handler_error', retryable: true });
  });

  it('a nonexistent name (ENOTFOUND) is unclassified and terminal — it will not exist next attempt either (A21)', () => {
    const thrown = Object.assign(new Error('getaddrinfo ENOTFOUND no.such.host'), { code: 'ENOTFOUND' });
    expect(classifyHttpError(thrown)).toMatchObject({ kind: 'unclassified', retryable: false });
  });

  it('anything unrecognised falls through to unclassified (terminal by default)', () => {
    expect(classifyHttpError(new RangeError('boom'))).toMatchObject({ kind: 'unclassified', retryable: false });
  });
});
