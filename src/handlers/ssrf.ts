import { promises as dns } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** Target rejected by SSRF policy: bad scheme, credentials, or an address in denied space. Terminal (§6). */
export class HttpBlockedError extends Error {
  override name = 'HttpBlockedError';
}

const DENIED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — the cloud metadata address lives here
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

const DENIED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64 — a public-looking v6 route into embedded v4 space
];

function buildBlockList(v4: ReadonlyArray<readonly [string, number]>, v6: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

const denied = buildBlockList(DENIED_V4, DENIED_V6);
const loopbackOnly = buildBlockList([['127.0.0.0', 8]], [['::1', 128]]);

/**
 * True when the address must not be connected to. Non-IP input is blocked — the guard
 * fails closed on anything it cannot parse.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return denied.check(ip, 'ipv4');
  if (family !== 6) return true;
  // The v4-mapped (::ffff:a.b.c.d, ::ffff:hex) and v4-compatible (::a.b.c.d) forms are how a
  // literal such as ::ffff:169.254.169.254 walks past a guard that only knows dotted quads:
  // extract the embedded v4 first and hold it to the v4 rules.
  const embedded = embeddedV4(ip);
  if (embedded !== undefined && denied.check(embedded, 'ipv4')) return true;
  try {
    return denied.check(ip, 'ipv6');
  } catch {
    return true;
  }
}

function isLoopback(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return loopbackOnly.check(ip, 'ipv4');
  if (family !== 6) return false;
  const embedded = embeddedV4(ip);
  if (embedded !== undefined) return loopbackOnly.check(embedded, 'ipv4');
  try {
    return loopbackOnly.check(ip, 'ipv6');
  } catch {
    return false;
  }
}

export interface AllowedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/**
 * Resolves the URL's host and requires EVERY resolved address to clear the denied set —
 * a host with one public and one private record is rejected, not round-robined past the
 * guard. Returns the first address; the caller pins the connection to it so a DNS
 * rebind after this check cannot swap the target (§5).
 */
export async function assertAllowedUrl(rawUrl: string, opts: { allowLoopback: boolean }): Promise<AllowedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpBlockedError('target is not a parseable URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpBlockedError(`scheme "${url.protocol}" is not allowed; only http and https are`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpBlockedError('URLs carrying credentials are not allowed');
  }
  const hostname = stripBrackets(url.hostname);
  const addresses = await resolve(hostname);
  const exempt = (address: string): boolean => opts.allowLoopback && isLoopback(address);
  for (const { address } of addresses) {
    if (isBlockedAddress(address) && !exempt(address)) {
      throw new HttpBlockedError(`host "${hostname}" resolves to a blocked address (${address})`);
    }
  }
  const first = addresses[0];
  if (first === undefined) throw new HttpBlockedError(`host "${hostname}" did not resolve to any address`);
  return { hostname, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolve(hostname: string): Promise<LookupAddress[]> {
  const family = isIP(hostname);
  if (family !== 0) return [{ address: hostname, family }];
  return dns.lookup(hostname, { all: true });
}

/**
 * The dotted quad embedded in a v4-mapped or v4-compatible IPv6 literal, or undefined when
 * the address embeds none. `::` and `::1` are v6-native, not compat encodings of 0.0.0.0/1.
 */
function embeddedV4(ip: string): string | undefined {
  const bytes = v6Bytes(ip);
  if (bytes === undefined) return undefined;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = bytes.subarray(12, 16);
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compat = bytes[10] === 0 && bytes[11] === 0 && !(a === 0 && b === 0 && c === 0 && d <= 1);
  if (!mapped && !compat) return undefined;
  return `${a}.${b}.${c}.${d}`;
}

/** The 16 bytes of an IPv6 literal `isIP` already validated; undefined on any anomaly (callers fail closed). */
function v6Bytes(ip: string): Uint8Array | undefined {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted !== null) {
    const [, head = '', quad = ''] = dotted;
    const [a = NaN, b = NaN, c = NaN, d = NaN] = quad.split('.').map(Number);
    if ([a, b, c, d].some((octet) => !Number.isInteger(octet) || octet > 255)) return undefined;
    s = `${head}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const compressed = s.includes('::');
  const [headRaw = '', tailRaw = ''] = s.split('::');
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === '' ? [] : tailRaw.split(':');
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 0 : head.length !== 8 || tail.length !== 0) return undefined;
  const groups = compressed ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (group === undefined || !/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}
