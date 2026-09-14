import { describe, expect, it } from 'vitest';
import { failure, messageOf } from '../failure.js';
import type { Classifier, Handler } from '../contracts.js';
import { HandlerRegistry } from './registry.js';

const handler: Handler = async () => null;
const classifier: Classifier = (thrown) => failure('handler_error', messageOf(thrown), true);

describe('HandlerRegistry', () => {
  it('resolves a registered type to its handler and classifier', () => {
    const registry = new HandlerRegistry().register('js', handler, classifier);
    expect(registry.resolve('js')).toEqual({ handler, classifier });
  });

  it('returns null for an unregistered type, including strings off the wire', () => {
    const registry = new HandlerRegistry().register('js', handler, classifier);
    expect(registry.resolve('http')).toBeNull();
    expect(registry.resolve('not-a-task-type')).toBeNull();
  });

  it('throws on duplicate registration', () => {
    const registry = new HandlerRegistry().register('llm', handler, classifier);
    expect(() => registry.register('llm', handler, classifier)).toThrow(/llm/);
  });

  it('chains: register returns the registry itself', () => {
    const registry = new HandlerRegistry();
    expect(registry.register('http', handler, classifier)).toBe(registry);
  });
});
