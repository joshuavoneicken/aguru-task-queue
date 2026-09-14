import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { claimIdSchema, taskIdSchema } from '../src/domain/task.js';
import type { ClaimedTask } from '@aguru/harness';
import {
  classifyJsError,
  createJsHandler,
  JsBadRequestError,
  JsExitError,
  JsNetworkError,
  JsScriptError,
  JsSerializationError,
  JsTimeoutError,
} from '../src/handlers/js.js';

function jsTask(payload: unknown): ClaimedTask {
  return {
    id: taskIdSchema.parse(crypto.randomUUID()),
    type: 'js',
    payload,
    attempts: 1,
    claimId: claimIdSchema.parse(crypto.randomUUID()),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

/** A listener that closes every connection on arrival. macOS surfaces that to the client as
 * ECONNRESET, Linux as undici's UND_ERR_SOCKET; both are transport failures on the shared allowlist.
 * (A real RST via resetAndDestroy is not usable: on macOS with Node 24, undici throws an uncaught
 * setTypeOfService EINVAL on the reset socket and the child dies before it can report.) */
async function withClosingServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('closing server did not bind a TCP port');
  try {
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Generous default so tsx bootstrap in the forked child never eats a legitimate script's budget;
// the timeout tests pass their own timeoutMs.
const handler = createJsHandler({ defaultTimeoutMs: 10_000 });
const ctx = { signal: new AbortController().signal };

describe('createJsHandler — hostile source runs in a forked child, never in-process (§5)', () => {
  it("resolves the script's return value, fed the payload input", async () => {
    await expect(handler(jsTask({ source: 'return 1 + Number(input)', input: 41 }), ctx)).resolves.toBe(42);
  });

  it('a syntax error in the source rejects with the child-reported error', async () => {
    await expect(handler(jsTask({ source: 'return ((' }), ctx)).rejects.toThrowError(
      expect.objectContaining({ name: 'JsScriptError', message: expect.stringContaining('SyntaxError') }),
    );
  });

  it('a script that throws rejects with the child-reported error', async () => {
    await expect(handler(jsTask({ source: "throw new RangeError('boom')" }), ctx)).rejects.toThrowError(
      expect.objectContaining({ name: 'JsScriptError', message: expect.stringContaining('RangeError: boom') }),
    );
  });

  it("a transport failure in the script's own fetch rejects with JsNetworkError, carrying the code", async () => {
    await withClosingServer(async (port) => {
      await expect(
        handler(jsTask({ source: "await fetch('http://127.0.0.1:' + input + '/')", input: port }), ctx),
      ).rejects.toThrowError(
        expect.objectContaining({ name: 'JsNetworkError', message: expect.stringMatching(/\((ECONNRESET|UND_ERR_SOCKET)\)$/) }),
      );
    });
  });

  it('a script that throws an error merely mentioning a network code is a script error, not a network one', async () => {
    await expect(handler(jsTask({ source: "throw new Error('ECONNRESET happened')" }), ctx)).rejects.toBeInstanceOf(
      JsScriptError,
    );
  });

  it('while(true){} is SIGKILLed at the payload timeout', async () => {
    await expect(handler(jsTask({ source: 'while (true) {}', timeoutMs: 500 }), ctx)).rejects.toBeInstanceOf(
      JsTimeoutError,
    );
  });

  it('a circular return value rejects with a serialisation error', async () => {
    await expect(
      handler(jsTask({ source: 'const o = {}; o.self = o; return o;' }), ctx),
    ).rejects.toBeInstanceOf(JsSerializationError);
  });

  it('a function return value round-trips to undefined, not an error', async () => {
    await expect(handler(jsTask({ source: 'return () => {}' }), ctx)).resolves.toBeUndefined();
  });

  it("the child cannot see the parent's environment", async () => {
    process.env.SECRET = 'hunter2';
    try {
      await expect(handler(jsTask({ source: 'return process.env.SECRET ?? null' }), ctx)).resolves.toBeNull();
    } finally {
      delete process.env.SECRET;
    }
  });

  it('the child runs with the inspector signal disabled, so a script cannot open a debugger port', async () => {
    await expect(handler(jsTask({ source: 'return process.execArgv' }), ctx)).resolves.toEqual(
      expect.arrayContaining(['--disable-sigusr1']),
    );
  });

  it('console.log in the script does not corrupt the result (IPC, not stdout framing)', async () => {
    await expect(
      handler(jsTask({ source: "console.log('{\"ok\":false}'); return 7;" }), ctx),
    ).resolves.toBe(7);
  });

  it('a script that exits the child before reporting rejects with JsExitError', async () => {
    await expect(handler(jsTask({ source: 'process.exit(7)' }), ctx)).rejects.toThrowError(
      expect.objectContaining({ name: 'JsExitError', message: expect.stringContaining('code 7') }),
    );
  });

  it('aborting ctx.signal kills the child immediately, not at the timeout', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = handler(jsTask({ source: 'while (true) {}' }), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('worker shutting down')), 100);
    await expect(run).rejects.toThrow('worker shutting down');
    expect(Date.now() - started).toBeLessThan(5_000); // well inside the 10 s default budget
  });

  it('re-validates the payload and throws a terminal bad-request error on mismatch', async () => {
    await expect(handler(jsTask('not an object'), ctx)).rejects.toBeInstanceOf(JsBadRequestError);
    await expect(handler(jsTask({}), ctx)).rejects.toBeInstanceOf(JsBadRequestError);
    await expect(handler(jsTask({ source: 'return 1', extra: true }), ctx)).rejects.toBeInstanceOf(
      JsBadRequestError,
    );
  });
});

describe('classifyJsError — script faults terminal, transport faults retryable (§6, A2)', () => {
  it('the budget kill is kind timeout, retryable false', () => {
    expect(classifyJsError(new JsTimeoutError('budget'))).toMatchObject({ kind: 'timeout', retryable: false });
  });

  it("a transport failure inside the script's own I/O is handler_error, retryable", () => {
    expect(classifyJsError(new JsNetworkError('fetch failed: ECONNRESET'))).toMatchObject({
      kind: 'handler_error', retryable: true,
    });
  });

  it.each([
    ['child-reported script error', new JsScriptError('SyntaxError: x')],
    ['unexpected child exit', new JsExitError('code 1')],
    ['serialisation failure', new JsSerializationError('circular')],
    ['bad payload', new JsBadRequestError('schema')],
  ])('%s is terminal', (_label, thrown) => {
    expect(classifyJsError(thrown)).toMatchObject({ kind: 'handler_terminal', retryable: false });
  });

  it('anything unrecognised falls through to unclassified (terminal by default)', () => {
    expect(classifyJsError(new RangeError('boom'))).toMatchObject({ kind: 'unclassified', retryable: false });
  });
});
