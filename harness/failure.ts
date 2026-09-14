/**
 * A verdict on a task attempt: a `kind` (an opaque label the queue interprets — the harness never
 * enumerates them), whether a later attempt could plausibly help, and a human-readable message.
 * Handlers produce these through their classifiers; the harness produces its own for the cases it
 * owns (no handler, budget timeout, oversized result, unclassified throw).
 */
export interface Failure {
  kind: string;
  retryable: boolean;
  message: string;
}

export function failure(kind: string, message: string, retryable: boolean): Failure {
  return { kind, retryable, message };
}

export function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  try {
    return String(thrown);
  } catch {
    return '[unrepresentable thrown value]';
  }
}

/** The default verdict for a thrown value no classifier claimed: terminal, since an unreasoned error is not safe to retry blindly. */
export function classifyUnknown(thrown: unknown): Failure {
  return failure('unclassified', messageOf(thrown), false);
}
