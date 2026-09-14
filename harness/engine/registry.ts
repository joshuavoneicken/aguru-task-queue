import type { Classifier, Handler } from '../contracts.js';

export interface Registration {
  handler: Handler;
  classifier: Classifier;
}

// The handler and its classifier travel together: whoever knows how to run a task type is the only
// party qualified to say which of its failures are worth retrying.
export class HandlerRegistry {
  private readonly entries = new Map<string, Registration>();

  register(type: string, handler: Handler, classifier: Classifier): this {
    if (this.entries.has(type)) throw new Error(`a handler for "${type}" is already registered`);
    this.entries.set(type, { handler, classifier });
    return this;
  }

  resolve(type: string): Registration | null {
    return this.entries.get(type) ?? null;
  }
}
