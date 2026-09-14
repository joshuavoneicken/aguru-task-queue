import { classifyUnknown, failure as makeFailure, messageOf, type Failure } from '@aguru/harness';

export { classifyUnknown, messageOf, type Failure };

// This app's failure taxonomy — a closed set stored on the task row so a DLQ can be grouped and
// counted without parsing prose (SPEC §6). The harness treats `kind` as an opaque string; these are
// the strings it and the handlers produce.
export const FAILURE_KINDS = [
  'handler_error', 'handler_terminal', 'unclassified', 'timeout',
  'lease_expired', 'result_too_large', 'no_handler', 'worker_shutdown',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The retryability each kind implies; a nack body that names a kind must agree with it (§8). */
export const RETRYABLE_BY_KIND: Record<FailureKind, boolean> = {
  handler_error: true, handler_terminal: false, unclassified: false, timeout: false,
  lease_expired: false, result_too_large: false, no_handler: false, worker_shutdown: true,
};

/** Typed over this app's taxonomy, defaulting retryability from the table; delegates to the harness's generic constructor. */
export function failure(kind: FailureKind, message: string, retryable = RETRYABLE_BY_KIND[kind]): Failure {
  return makeFailure(kind, message, retryable);
}
