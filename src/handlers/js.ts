import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { classifyUnknown, failure, messageOf } from '../domain/failure.js';
import { jsPayloadSchema } from '../domain/task.js';
import type { Classifier, Handler } from '@aguru/harness';

/** Payload failed the js schema. Terminal (§6). */
export class JsBadRequestError extends Error {
  override name = 'JsBadRequestError';
}

/** The script itself failed — a compile error or a throw — as reported by the child. */
export class JsScriptError extends Error {
  override name = 'JsScriptError';
}

/** The script's own I/O failed at the transport (a refused or reset connection, a transient DNS
 * failure), as reported by the child. The one js failure that is not the script's fault. */
export class JsNetworkError extends Error {
  override name = 'JsNetworkError';
}

/** The parent's budget expired and the child was SIGKILLed. */
export class JsTimeoutError extends Error {
  override name = 'JsTimeoutError';
}

/** The child died before reporting a result: process.exit in the script, an OOM abort, a crash. */
export class JsExitError extends Error {
  override name = 'JsExitError';
}

/** The script's return value did not survive a JSON round-trip. */
export class JsSerializationError extends Error {
  override name = 'JsSerializationError';
}

/** IPC protocol with js-child.ts, which imports these type-only so forking code never runs there. */
export interface JsRunRequest {
  source: string;
  input?: unknown;
}

/** Parsed, not trusted: a hostile script can call process.send itself, so only a well-formed
 * response settles the run — anything else waits out the timeout backstop. */
export const jsRunResponseSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), kind: z.enum(['script', 'network', 'serialization']), error: z.string() }),
]);
export type JsRunResponse = z.infer<typeof jsRunResponseSchema>;

// Under tsx/Vitest this module's URL ends in .ts and the child needs the tsx loader; a built
// dist forks the compiled sibling directly. The same code serves both.
const runningTypeScript = import.meta.url.endsWith('.ts');
const childPath = fileURLToPath(new URL(runningTypeScript ? 'js-child.ts' : 'js-child.js', import.meta.url));
const childExecArgv = [...(runningTypeScript ? ['--import', 'tsx'] : []), '--max-old-space-size=128', '--disable-sigusr1'];

export function createJsHandler(opts: { defaultTimeoutMs: number }): Handler {
  return async (task, ctx) => {
    const parsed = jsPayloadSchema.safeParse(task.payload);
    if (!parsed.success) {
      throw new JsBadRequestError(
        `payload failed js schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const { source, input, timeoutMs } = parsed.data;
    return runInChild({ source, input }, timeoutMs ?? opts.defaultTimeoutMs, ctx.signal);
  };
}

export const classifyJsError: Classifier = (thrown) => {
  // 'timeout', not the retryable mapping http/llm give their payload timeouts: for js the
  // parent-owned kill IS the execution budget, and an infinite loop is the likelier cause (A2).
  if (thrown instanceof JsTimeoutError) return failure('timeout', messageOf(thrown));
  // A2: the script's logic is deterministic, its I/O is not — a transport failure is the one
  // js error a later attempt could plausibly resolve, classified by the same allowlist as http.
  if (thrown instanceof JsNetworkError) return failure('handler_error', messageOf(thrown));
  if (
    thrown instanceof JsScriptError ||
    thrown instanceof JsExitError ||
    thrown instanceof JsSerializationError ||
    thrown instanceof JsBadRequestError
  ) {
    return failure('handler_terminal', messageOf(thrown));
  }
  return classifyUnknown(thrown);
};

/**
 * §5: hostile source never runs in this process. The child gets a scrubbed environment and a
 * V8 heap cap; the parent owns the clock (the budget deliberately includes child startup, so it
 * bounds total wall-clock) and settles exactly once, SIGKILLing the child on every path — a
 * script that forges a success message and keeps spinning still dies with the settle.
 *
 * Residual risk (§5): --max-old-space-size bounds the V8 heap, not RSS; the child keeps this
 * process's filesystem and network reach and can spawn processes of its own, which the SIGKILL
 * does not reach; and a SIGKILLed *parent* orphans a running child. Those are contained at the
 * OS layer (container, cgroup), not here. The inspector's SIGUSR1 trigger is disabled, so a
 * script cannot open a debugger port on loopback. `--disable-sigusr1` needs Node 22.14 or later,
 * which is the project's floor.
 */
function childError(kind: 'script' | 'network' | 'serialization', error: string): Error {
  switch (kind) {
    case 'network': return new JsNetworkError(error);
    case 'serialization': return new JsSerializationError(error);
    case 'script': return new JsScriptError(error);
  }
}

function runInChild(request: JsRunRequest, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = fork(childPath, {
      env: {},
      execArgv: childExecArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let settled = false;
    const settle = (outcome: { ok: true; value: unknown } | { ok: false; thrown: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.kill('SIGKILL'); // no-op if the child already exited
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.thrown);
    };

    const timer = setTimeout(
      () => settle({ ok: false, thrown: new JsTimeoutError(`script exceeded its ${timeoutMs} ms budget`) }),
      timeoutMs,
    );
    const onAbort = (): void => settle({ ok: false, thrown: signal.reason });
    signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (thrown) => settle({ ok: false, thrown }));
    // 'close', not 'exit': close orders after the IPC channel drains, so a result message sent
    // just before the child died still wins the race.
    child.once('close', (code, exitSignal) =>
      settle({
        ok: false,
        thrown: new JsExitError(`child exited before reporting a result (code ${code}, signal ${exitSignal})`),
      }),
    );
    child.on('message', (raw) => {
      const response = jsRunResponseSchema.safeParse(raw);
      if (!response.success) return;
      if (response.data.ok) settle({ ok: true, value: response.data.value });
      else {
        const { kind, error } = response.data;
        settle({ ok: false, thrown: childError(kind, error) });
      }
    });

    try {
      child.send(request);
    } catch (thrown) {
      settle({ ok: false, thrown }); // an already-dead IPC channel throws synchronously
    }
  });
}
