import type { LookupFunction } from 'node:net';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Agent, fetch } from 'undici';
import { classifyUnknown, failure, messageOf } from '../domain/failure.js';
import { httpPayloadSchema } from '../domain/task.js';
import { assertAllowedUrl, HttpBlockedError, type AllowedTarget } from './ssrf.js';
import { networkErrorCode } from './network-errors.js';
import type { Classifier, Handler } from '@aguru/harness';

/** Payload failed the http schema, or a redirect Location did not parse. Terminal (§6). */
export class HttpBadRequestError extends Error {
  override name = 'HttpBadRequestError';
}

export class HttpTooManyRedirectsError extends Error {
  override name = 'HttpTooManyRedirectsError';
}

/** Upstream answered 4xx/5xx; the status decides retryability, so it rides on the error. */
export class HttpStatusError extends Error {
  override name = 'HttpStatusError';
  constructor(readonly status: number) {
    super(`upstream responded ${status}`);
  }
}

export interface HttpResult {
  status: number;
  body: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Never replayed to a different origin — a redirect is the target's choice, not the producer's.
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];
const BODY_HEADERS = ['content-type', 'content-length'];

export function createHttpHandler(opts: {
  allowLoopback: boolean;
  bodyMaxBytes: number;
  redirectMax: number;
}): Handler {
  return async (task, ctx) => {
    const parsed = httpPayloadSchema.safeParse(task.payload);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        `payload failed http schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    // ctx.signal carries the harness budget (maxTaskExecutionMs), so it bounds the payload timeout from above.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);

    let url = parsed.data.url;
    let method = parsed.data.method;
    let body = parsed.data.body;
    let headers = parsed.data.headers ?? {};
    // The consumer-side half of idempotency (§7): at-least-once delivery may run this request
    // twice, so the target gets a stable key it can deduplicate on. A caller's own key wins.
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'idempotency-key')) {
      headers = { ...headers, 'idempotency-key': task.id };
    }
    for (let redirects = 0; ; redirects++) {
      // Every hop passes the guard, and the connection is pinned to the address the guard
      // approved — DNS cannot answer differently between check and connect (§5).
      const target = await assertAllowedUrl(url, { allowLoopback: opts.allowLoopback });
      const agent = new Agent({ connect: { lookup: pinnedLookup(target) } });
      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          dispatcher: agent,
          signal,
        });
        const location = response.headers.get('location');
        if (!REDIRECT_STATUSES.has(response.status) || location === null) {
          if (response.status >= 400) {
            await response.body?.cancel();
            throw new HttpStatusError(response.status);
          }
          return await readCapped(response.status, response.body, opts.bodyMaxBytes);
        }
        await response.body?.cancel();
        if (redirects >= opts.redirectMax) {
          throw new HttpTooManyRedirectsError(`redirect limit of ${opts.redirectMax} exceeded`);
        }
        const next = resolveRedirect(location, url);
        if (new URL(next).origin !== new URL(url).origin) headers = without(headers, CREDENTIAL_HEADERS);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers = without(headers, BODY_HEADERS);
        }
        url = next;
      } finally {
        await agent.destroy();
      }
    }
  };
}

export const classifyHttpError: Classifier = (thrown) => {
  if (thrown instanceof HttpStatusError) {
    const retryable = thrown.status === 429 || thrown.status >= 500;
    return failure(retryable ? 'handler_error' : 'handler_terminal', messageOf(thrown));
  }
  if (
    thrown instanceof HttpBlockedError ||
    thrown instanceof HttpTooManyRedirectsError ||
    thrown instanceof HttpBadRequestError
  ) {
    return failure('handler_terminal', messageOf(thrown));
  }
  if (isTimeout(thrown)) return failure('handler_error', 'request timed out');
  const code = networkErrorCode(thrown);
  if (code !== undefined) return failure('handler_error', `network error: ${code}`);
  return classifyUnknown(thrown);
};

/** Ignores the name net.connect resolves and answers with the guard-approved address; the
 * TLS servername stays the hostname, so certificate validation is untouched. */
function pinnedLookup(target: AllowedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

/** Reads the (already-decompressed) body stream into an accumulator cut at `cap` bytes —
 * counting post-inflation is what stops a small gzip bomb reaching the heap. */
async function readCapped(status: number, stream: WebReadableStream<Uint8Array> | null, cap: number): Promise<HttpResult> {
  if (stream === null) return { status, body: '', truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { status, body: decode(chunks), truncated: false };
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total));
      await reader.cancel();
      return { status, body: decode(chunks), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
}

function decode(chunks: Uint8Array[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

function resolveRedirect(location: string, base: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    throw new HttpBadRequestError('redirect Location did not parse as a URL');
  }
}

function without(headers: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name.toLowerCase())));
}

function isTimeout(thrown: unknown): boolean {
  return (thrown instanceof DOMException || thrown instanceof Error) && thrown.name === 'TimeoutError';
}

