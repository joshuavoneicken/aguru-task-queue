export interface LlmProvider {
  complete(input: { model: string; prompt: string }, signal: AbortSignal): Promise<{ content: string }>;
}

/** One error class per provider failure mode, so the classifier decides on types, not message text. */
abstract class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class LlmRateLimitError extends LlmError {}
export class LlmServerError extends LlmError {}
export class LlmAuthError extends LlmError {}
export class LlmRefusalError extends LlmError {}
export class LlmTimeoutError extends LlmError {}
export class LlmBadRequestError extends LlmError {}

const INJECTED_FAILURES: ReadonlyArray<readonly [prefix: string, error: new (message: string) => LlmError]> = [
  ['FAIL:rate_limit', LlmRateLimitError],
  ['FAIL:server', LlmServerError],
  ['FAIL:auth', LlmAuthError],
  ['FAIL:refusal', LlmRefusalError],
  ['FAIL:timeout', LlmTimeoutError],
];

const COMPLETION_PROMPT_FRAGMENT_LENGTH = 64;

/**
 * Deterministic stand-in for a real LLM API. Magic prompt prefixes inject each §6 failure mode
 * so every retry path is exercisable end to end without a key or network access.
 */
export class StubLlmProvider implements LlmProvider {
  async complete({ model, prompt }: { model: string; prompt: string }, signal: AbortSignal): Promise<{ content: string }> {
    if (signal.aborted) {
      throw new LlmTimeoutError('aborted before completion');
    }
    for (const [prefix, InjectedError] of INJECTED_FAILURES) {
      if (prompt.startsWith(prefix)) {
        throw new InjectedError(`injected by prompt prefix ${prefix}`);
      }
    }
    return { content: `stub(${model}): ${prompt.slice(0, COMPLETION_PROMPT_FRAGMENT_LENGTH)}` };
  }
}
