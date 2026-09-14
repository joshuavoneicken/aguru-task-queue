import { classifyUnknown, failure, messageOf } from '../domain/failure.js';
import { llmPayloadSchema } from '../domain/task.js';
import {
  LlmAuthError,
  LlmBadRequestError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmServerError,
  LlmTimeoutError,
  type LlmProvider,
} from './provider.js';
import type { Classifier, Handler } from '@aguru/harness';

export function createLlmHandler(provider: LlmProvider): Handler {
  return async (task, ctx) => {
    const parsed = llmPayloadSchema.safeParse(task.payload);
    if (!parsed.success) {
      throw new LlmBadRequestError(`payload failed llm schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const { model, prompt } = parsed.data;
    const { content } = await provider.complete({ model, prompt }, ctx.signal);
    return { model, content };
  };
}

export const classifyLlmError: Classifier = (thrown) => {
  if (thrown instanceof LlmRateLimitError || thrown instanceof LlmServerError || thrown instanceof LlmTimeoutError) {
    return failure('handler_error', messageOf(thrown));
  }
  if (thrown instanceof LlmAuthError || thrown instanceof LlmRefusalError || thrown instanceof LlmBadRequestError) {
    return failure('handler_terminal', messageOf(thrown));
  }
  return classifyUnknown(thrown);
};
