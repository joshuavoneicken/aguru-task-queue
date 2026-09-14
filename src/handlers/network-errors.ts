/**
 * Transient transport failures only — a deliberate allowlist, so an unrecognised code falls through
 * to the §6 terminal-by-default rule instead of retrying an unreasoned error. Shared by the http
 * handler and the js child: a script's own fetch fails with the same codes an http task does. The
 * undici codes are enumerated, not prefix-matched, so a hostile script cannot earn retries by
 * provoking a non-transient `UND_ERR_*` such as `UND_ERR_INVALID_ARG`.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** The transient transport code on `thrown` or in its cause chain (fetch wraps the socket error), else undefined. */
export function networkErrorCode(thrown: unknown, depth = 0): string | undefined {
  if (depth > 4 || !(thrown instanceof Error)) return undefined;
  if ('code' in thrown && typeof thrown.code === 'string') {
    if (NETWORK_ERROR_CODES.has(thrown.code)) return thrown.code;
  }
  return networkErrorCode(thrown.cause, depth + 1);
}
