import { createServer, type IncomingMessage, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { hostMatchesAllowlist } from '@qa/shared';

/**
 * Sentry-owned egress proxy for OpenCode tool shells.
 *
 * Tool shells run in a network namespace with no routes (bwrap
 * `--unshare-net`). The only way out is a Unix socket bind-mounted into the
 * namespace and bridged to a loopback port by `socat`. This proxy listens
 * on that socket and admits exactly one thing: an HTTP CONNECT tunnel to an
 * allowlisted package-registry hostname on port 443/80 that resolves to a
 * PUBLIC address. It never inspects or logs payloads.
 */

export interface EgressStats {
  readonly allowed: number;
  readonly denied: number;
  /** Up to 50 distinct denied hostnames, for the run diagnostics. */
  readonly deniedHosts: readonly string[];
}

export interface EgressProxy {
  readonly socketPath: string;
  stats(): EgressStats;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  readonly socketPath: string;
  readonly allowedHosts: readonly string[];
  /** Test seam: resolve a hostname to addresses. Default is the system resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Test seam: open the upstream connection to an already validated address. */
  readonly dial?: (address: string, port: number) => Promise<Duplex>;
}

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_DENIED_HOSTS = 50;

/** True for anything that is not a routable public unicast address (and for non-IPs). */
export function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isNonPublicIpv4(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped !== null) return isNonPublicIpv4(mapped[1] as string);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex !== null) {
      const high = parseInt(hex[1] as string, 16);
      const low = parseInt(hex[2] as string, 16);
      return isNonPublicIpv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a >= 224;
}

/** Strict `host:port` / `[v6]:port` parse for a CONNECT request target. */
export function parseConnectTarget(target: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s[\]]+)):(\d{1,5})$/.exec(target.trim());
  if (match === null) return undefined;
  const host = (match[1] ?? match[2]) as string;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

async function systemResolve(host: string): Promise<readonly string[]> {
  const results = await lookup(host, { all: true });
  return results.map((entry) => entry.address);
}

function systemDial(address: string, port: number): Promise<Duplex> {
  return new Promise((resolveDial, reject) => {
    const socket: Socket = connect({ host: address, port });
    socket.once('connect', () => resolveDial(socket));
    socket.once('error', reject);
  });
}

function refuse(client: Duplex, status: string): void {
  client.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const resolveHost = options.resolve ?? systemResolve;
  const dial = options.dial ?? systemDial;
  let allowed = 0;
  let denied = 0;
  const deniedHosts = new Set<string>();
  const sockets = new Set<Duplex>();
  const deny = (client: Duplex, host: string, status: string): void => {
    denied += 1;
    if (deniedHosts.size < MAX_DENIED_HOSTS) deniedHosts.add(host.slice(0, 255));
    refuse(client, status);
  };

  const server: Server = createServer((_request, response) => {
    // Plain HTTP requests are never proxied: CONNECT tunnels only.
    response.writeHead(405, { Allow: 'CONNECT', Connection: 'close' });
    response.end();
  });
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    void (async () => {
      const target = parseConnectTarget(request.url ?? '');
      if (target === undefined) return deny(client, 'malformed', '400 Bad Request');
      const { host, port } = target;
      if (!ALLOWED_PORTS.has(port)) return deny(client, host, '403 Forbidden');
      if (isIP(host) !== 0) return deny(client, host, '403 Forbidden');
      if (!hostMatchesAllowlist(host, options.allowedHosts))
        return deny(client, host, '403 Forbidden');
      let addresses: readonly string[];
      try {
        addresses = await resolveHost(host);
      } catch {
        return deny(client, host, '502 Bad Gateway');
      }
      // Validate EVERY resolved address, then dial a validated address
      // directly: no second resolution between check and connect.
      const first = addresses[0];
      if (first === undefined || addresses.some(isNonPublicAddress))
        return deny(client, host, '403 Forbidden');
      let upstream: Duplex;
      try {
        upstream = await dial(first, port);
      } catch {
        return deny(client, host, '502 Bad Gateway');
      }
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      allowed += 1;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => resolveListen());
  });
  await chmod(options.socketPath, 0o600).catch(() => undefined);

  return {
    socketPath: options.socketPath,
    stats: () => ({ allowed, denied, deniedHosts: [...deniedHosts] }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(options.socketPath, { force: true });
    },
  };
}
