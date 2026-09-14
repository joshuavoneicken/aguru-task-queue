import { describe, expect, it } from 'vitest';
import { assertAllowedUrl, HttpBlockedError, isBlockedAddress } from './ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'RFC 1918 10/8'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['172.16.0.1', 'RFC 1918 172.16/12 lower bound'],
    ['172.31.255.255', 'RFC 1918 172.16/12 upper bound'],
    ['192.168.1.1', 'RFC 1918 192.168/16'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['::', 'v6 unspecified'],
    ['::1', 'v6 loopback'],
    ['fc00::1', 'unique-local lower half'],
    ['fd12::1', 'unique-local upper half'],
    ['fe80::1', 'v6 link-local'],
    ['ff02::1', 'v6 multicast'],
    ['64:ff9b::a00:1', 'NAT64 prefix'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['::ffff:169.254.169.254', 'v4-mapped dotted metadata'],
    ['::ffff:10.0.0.1', 'v4-mapped dotted private'],
    ['::ffff:7f00:1', 'v4-mapped hex loopback'],
    ['::10.0.0.1', 'v4-compatible private'],
  ])('blocks the embedded-v4 form %s (%s) that a dotted-quad guard misses', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([['1.1.1.1'], ['93.184.216.34'], ['2606:4700::1111'], ['::ffff:1.1.1.1']])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each([[''], ['not-an-ip'], ['example.com'], ['999.0.0.1'], ['0x7f.0.0.1'], ['1.2.3']])(
    'fails closed on unparseable input %j',
    (input) => {
      expect(isBlockedAddress(input)).toBe(true);
    },
  );
});

describe('assertAllowedUrl', () => {
  const strict = { allowLoopback: false };
  const dev = { allowLoopback: true };

  it.each([['ftp://example.com/file'], ['file:///etc/passwd'], ['gopher://example.com/']])(
    'rejects the non-http scheme %s',
    async (url) => {
      await expect(assertAllowedUrl(url, strict)).rejects.toBeInstanceOf(HttpBlockedError);
    },
  );

  it('rejects a URL carrying credentials', async () => {
    await expect(assertAllowedUrl('http://user:secret@1.1.1.1/', strict)).rejects.toBeInstanceOf(HttpBlockedError);
    await expect(assertAllowedUrl('http://user@1.1.1.1/', strict)).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it('does not echo the credential in the rejection message', async () => {
    await expect(assertAllowedUrl('http://user:hunter2@1.1.1.1/', strict)).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && !e.message.includes('hunter2'),
    );
  });

  it('rejects something that is not a URL at all (fail closed)', async () => {
    await expect(assertAllowedUrl('not a url', strict)).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it.each([
    ['http://10.0.0.1/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::ffff:169.254.169.254]/'],
    ['http://[fe80::1]/'],
  ])('rejects the blocked literal target %s', async (url) => {
    await expect(assertAllowedUrl(url, strict)).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it('rejects a hostname that resolves into blocked space', async () => {
    await expect(assertAllowedUrl('http://localhost:8080/', strict)).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it('allowLoopback exempts 127.0.0.0/8 and ::1', async () => {
    await expect(assertAllowedUrl('http://127.0.0.1:8080/x', dev)).resolves.toEqual({
      hostname: '127.0.0.1',
      address: '127.0.0.1',
      family: 4,
    });
    await expect(assertAllowedUrl('http://127.0.0.2/', dev)).resolves.toMatchObject({ address: '127.0.0.2' });
    await expect(assertAllowedUrl('http://[::1]:8080/', dev)).resolves.toEqual({
      hostname: '::1',
      address: '::1',
      family: 6,
    });
    await expect(assertAllowedUrl('http://localhost:8080/', dev)).resolves.toMatchObject({ hostname: 'localhost' });
  });

  it('allowLoopback exempts loopback only — other blocked space stays blocked', async () => {
    await expect(assertAllowedUrl('http://192.168.1.1/', dev)).rejects.toBeInstanceOf(HttpBlockedError);
    await expect(assertAllowedUrl('http://169.254.169.254/', dev)).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it('returns the pinned address for a public literal', async () => {
    await expect(assertAllowedUrl('https://1.1.1.1/dns-query', strict)).resolves.toEqual({
      hostname: '1.1.1.1',
      address: '1.1.1.1',
      family: 4,
    });
    await expect(assertAllowedUrl('https://[2606:4700::1111]/', strict)).resolves.toEqual({
      hostname: '2606:4700::1111',
      address: '2606:4700::1111',
      family: 6,
    });
  });
});
