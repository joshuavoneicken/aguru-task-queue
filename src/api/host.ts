// DNS-rebinding guard (SPEC §9). A hostile page can rebind its own domain to this API's
// address and become same-origin — CORS never fires on a same-origin request — so the Host
// header is the one signal that survives the rebind: the browser still sends the attacker's
// hostname. Answering only trusted hostnames closes the vector for every path, static and
// health included.

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Extracts the hostname from a Host header value: strips the port, unwraps IPv6 brackets. */
function hostnameOf(host: string): string | null {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? null : host.slice(1, close);
  }
  const beforePort = host.split(':')[0];
  return beforePort === undefined || beforePort === '' ? null : beforePort;
}

/** Loopback is trusted intrinsically; `allowedHosts` (lowercase, from config) adds deployment names. */
export function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined) return false;
  const hostname = hostnameOf(host)?.toLowerCase();
  if (hostname === undefined) return false;
  return LOOPBACK.has(hostname) || allowedHosts.includes(hostname);
}
