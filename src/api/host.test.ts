import { describe, expect, it } from 'vitest';
import { hostAllowed } from './host.js';

describe('hostAllowed', () => {
  it('accepts loopback hostnames with or without a port, case-insensitively', () => {
    expect(hostAllowed('localhost', [])).toBe(true);
    expect(hostAllowed('localhost:3000', [])).toBe(true);
    expect(hostAllowed('LOCALHOST:3000', [])).toBe(true);
    expect(hostAllowed('127.0.0.1:5173', [])).toBe(true);
    expect(hostAllowed('[::1]:3000', [])).toBe(true);
    expect(hostAllowed('[::1]', [])).toBe(true);
  });

  it('accepts a configured hostname, port stripped', () => {
    expect(hostAllowed('queue.internal', ['queue.internal'])).toBe(true);
    expect(hostAllowed('queue.internal:8443', ['queue.internal'])).toBe(true);
    expect(hostAllowed('other.internal', ['queue.internal'])).toBe(false);
  });

  it('rejects an untrusted hostname — the DNS-rebinding case', () => {
    expect(hostAllowed('evil.example', [])).toBe(false);
    expect(hostAllowed('evil.example:3000', [])).toBe(false);
    // Suffix/prefix confusions must not pass either.
    expect(hostAllowed('localhost.evil.example', [])).toBe(false);
    expect(hostAllowed('queue.internal.evil.example', ['queue.internal'])).toBe(false);
  });

  it('rejects a missing, empty, or malformed Host value', () => {
    expect(hostAllowed(undefined, [])).toBe(false);
    expect(hostAllowed('', [])).toBe(false);
    expect(hostAllowed(':3000', [])).toBe(false);
    expect(hostAllowed('[::1', [])).toBe(false); // unterminated IPv6 bracket
  });
});
