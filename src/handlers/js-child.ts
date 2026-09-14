import { messageOf } from '../domain/failure.js';
import { networkErrorCode } from './network-errors.js';
import type { JsRunRequest, JsRunResponse } from './js.js';

// The other side of §5's boundary: this process exists to run one hostile script and die.
// Results travel over the IPC channel only — the parent ignores stdout, so nothing the script
// prints can corrupt the protocol — and the parent owns the clock, so a script that never
// finishes is SIGKILLed at its budget rather than trusted to stop.

// lib.d.ts does not surface the AsyncFunction constructor; this cast names its true shape.
const AsyncFunction = (async () => {}).constructor as new (
  param: string,
  body: string,
) => (input: unknown) => Promise<unknown>;

function isRunRequest(message: unknown): message is JsRunRequest {
  return typeof message === 'object' && message !== null && 'source' in message && typeof message.source === 'string';
}

async function execute(request: JsRunRequest): Promise<JsRunResponse> {
  let value: unknown;
  try {
    const script = new AsyncFunction('input', request.source);
    value = await script(request.input);
  } catch (thrown) {
    const code = networkErrorCode(thrown);
    if (code !== undefined) return { ok: false, kind: 'network', error: `${messageOf(thrown)} (${code})` };
    return { ok: false, kind: 'script', error: messageOf(thrown) };
  }
  try {
    return { ok: true, value: jsonRoundTrip(value) };
  } catch (thrown) {
    return { ok: false, kind: 'serialization', error: `result did not survive a JSON round-trip: ${messageOf(thrown)}` };
  }
}

/** A function or undefined return stringifies to no JSON at all — that is undefined, not an error. */
function jsonRoundTrip(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : JSON.parse(json);
}

const send = process.send?.bind(process);
if (send === undefined) throw new Error('js-child must be forked with an IPC channel');

process.once('message', (message) => {
  if (!isRunRequest(message)) {
    send({ ok: false, kind: 'script', error: 'malformed run request' }, () => process.exit(1));
    return;
  }
  // The send callback confirms the flush; exiting before it can drop the message.
  void execute(message).then((response) => send(response, () => process.exit(0)));
});
