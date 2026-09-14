import { describe, expect, it } from 'vitest';
import { networkErrorCode } from './network-errors.js';

function withCode(code: string, cause?: unknown): Error {
  return Object.assign(new Error(`failed: ${code}`), { code, ...(cause === undefined ? {} : { cause }) });
}

describe('networkErrorCode — the transient transport allowlist shared by the http and js handlers', () => {
  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('recognises %s', (code) => {
    expect(networkErrorCode(withCode(code))).toBe(code);
  });

  it('walks the cause chain, as fetch wraps the socket error', () => {
    const fetchFailed = new TypeError('fetch failed', { cause: withCode('ECONNREFUSED') });
    expect(networkErrorCode(fetchFailed)).toBe('ECONNREFUSED');
  });

  it('does not recognise a code outside the allowlist, a non-Error, or a code only in the message', () => {
    expect(networkErrorCode(withCode('ENOTFOUND'))).toBeUndefined();
    expect(networkErrorCode({ code: 'ECONNRESET' })).toBeUndefined();
    expect(networkErrorCode(new Error('ECONNRESET'))).toBeUndefined();
    expect(networkErrorCode(withCode('UND_ERR_INVALID_ARG'))).toBeUndefined();
    expect(networkErrorCode(withCode('UND_ERR_RES_CONTENT_LENGTH_MISMATCH'))).toBeUndefined();
  });
});
