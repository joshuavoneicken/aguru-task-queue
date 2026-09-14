import { describe, expect, it } from 'vitest';
import { classifyUnknown, failure, messageOf } from './failure.js';

describe('failure', () => {
  it('failure() carries kind, message and the kind default retryability', () => {
    expect(failure('handler_error', 'flaky')).toEqual({ kind: 'handler_error', retryable: true, message: 'flaky' });
    expect(failure('handler_terminal', 'bad')).toEqual({ kind: 'handler_terminal', retryable: false, message: 'bad' });
    expect(failure('worker_shutdown', 'drain')).toEqual({ kind: 'worker_shutdown', retryable: true, message: 'drain' });
    expect(failure('timeout', 'budget')).toEqual({ kind: 'timeout', retryable: false, message: 'budget' });
  });

  it('classifyUnknown is terminal — the §6 default', () => {
    expect(classifyUnknown(new RangeError('boom'))).toEqual({ kind: 'unclassified', retryable: false, message: 'RangeError: boom' });
    expect(classifyUnknown('string throw')).toMatchObject({ kind: 'unclassified', retryable: false });
  });

  it('messageOf never throws and always returns a string', () => {
    expect(messageOf(new Error('x'))).toBe('Error: x');
    expect(messageOf({ toString: () => { throw new Error('hostile'); } })).toBe('[unrepresentable thrown value]');
    expect(messageOf(undefined)).toBe('undefined');
  });
});
