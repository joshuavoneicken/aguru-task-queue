import { describe, expect, it } from 'vitest';
import { httpPayloadSchema, jsPayloadSchema, llmPayloadSchema } from './task.js';

describe('payload schemas', () => {
  it('accepts a valid payload of each type', () => {
    expect(llmPayloadSchema.safeParse({ model: 'gpt-x', prompt: 'hello' }).success).toBe(true);
    expect(jsPayloadSchema.safeParse({ source: 'return 1;', input: { n: 1 }, timeoutMs: 5000 }).success).toBe(true);
    expect(httpPayloadSchema.safeParse({
      method: 'POST',
      url: 'https://example.com/hook',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      timeoutMs: 10_000,
    }).success).toBe(true);
  });

  it('rejects unknown fields — the schemas are strict', () => {
    expect(llmPayloadSchema.safeParse({ model: 'gpt-x', prompt: 'hi', temperature: 0.7 }).success).toBe(false);
    expect(jsPayloadSchema.safeParse({ source: 'x', env: {} }).success).toBe(false);
    expect(httpPayloadSchema.safeParse({ method: 'GET', url: 'https://a.example', follow: true }).success).toBe(false);
  });

  it('rejects a payload of the wrong shape for the type', () => {
    expect(llmPayloadSchema.safeParse({ source: 'return 1;' }).success).toBe(false);
    expect(jsPayloadSchema.safeParse({ source: '', timeoutMs: 0 }).success).toBe(false);
    expect(httpPayloadSchema.safeParse({ method: 'TRACE', url: 'not a url' }).success).toBe(false);
  });

  it('rejects an http payload whose url is not http or https', () => {
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(httpPayloadSchema.safeParse({ method: 'GET', url }).success, url).toBe(false);
    }
    expect(httpPayloadSchema.safeParse({ method: 'GET', url: 'https://example.com/' }).success).toBe(true);
  });
});
