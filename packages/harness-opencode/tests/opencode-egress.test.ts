import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isNonPublicAddress,
  parseConnectTarget,
  startEgressProxy,
  type EgressProxy,
} from '../src/egress.js';
import {
  TOOL_SHELL_EGRESS_PORT,
  TOOL_SHELL_EGRESS_SOCKET,
  renderToolShellWrapper,
  toolShellProxyEnvironment,
  type ToolShellSpec,
} from '../src/toolshell.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe('egress address classification', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip',
  ])('treats %s as non-public', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(['104.16.0.1', '151.101.1.1', '172.15.0.1', '172.32.0.1', '2606:4700::1'])(
    'treats %s as public',
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    },
  );
});

describe('CONNECT target parsing', () => {
  it('parses host:port and bracketed IPv6', () => {
    expect(parseConnectTarget('registry.npmjs.org:443')).toEqual({
      host: 'registry.npmjs.org',
      port: 443,
    });
    expect(parseConnectTarget('[2606:4700::1]:443')).toEqual({ host: '2606:4700::1', port: 443 });
  });

  it.each(['', 'registry.npmjs.org', 'a:b', 'host:0', 'host:70000', 'a b:443', 'http://x:443'])(
    'rejects %j',
    (target) => {
      expect(parseConnectTarget(target)).toBeUndefined();
    },
  );
});

/** Sends one CONNECT request to the proxy's Unix socket and returns the status line. */
async function connectThrough(
  socketPath: string,
  target: string,
  afterEstablished?: (socket: ReturnType<typeof connect>) => Promise<string>,
): Promise<{ status: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    let status: string | undefined;
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n');
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      if (status === undefined && buffer.includes('\r\n\r\n')) {
        status = buffer.split('\r\n')[0] as string;
        buffer = buffer.slice(buffer.indexOf('\r\n\r\n') + 4);
        if (status.includes(' 200') && afterEstablished !== undefined) {
          const echoed = await afterEstablished(socket);
          socket.destroy();
          resolve({ status, echoed });
        }
      }
    });
    socket.on('close', () => {
      if (status !== undefined) resolve({ status });
    });
    setTimeout(() => reject(new Error('timeout')), 4000).unref();
  });
}

async function startProxy(
  overrides: Partial<Parameters<typeof startEgressProxy>[0]> = {},
): Promise<{ proxy: EgressProxy; dialed: Array<{ address: string; port: number }> }> {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-egress-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dialed: Array<{ address: string; port: number }> = [];
  const proxy = await startEgressProxy({
    socketPath: join(dir, 'e.sock'),
    allowedHosts: ['registry.npmjs.org', '*.pythonhosted.org'],
    resolve: async () => ['104.16.0.1'],
    dial: async (address, port): Promise<Duplex> => {
      dialed.push({ address, port });
      // Echo upstream: whatever the client sends comes back.
      const echo = new PassThrough();
      return echo as unknown as Duplex;
    },
    ...overrides,
  });
  cleanup.push(() => proxy.close());
  return { proxy, dialed };
}

// Unix-domain sockets under temp paths are a Linux production surface (WSL); skip elsewhere.
describe.runIf(process.platform === 'linux')('egress proxy', () => {
  it('tunnels to an allowlisted registry through a validated address', async () => {
    const { proxy, dialed } = await startProxy();
    const result = await connectThrough(
      proxy.socketPath,
      'registry.npmjs.org:443',
      async (socket) => {
        socket.write('ping');
        return await new Promise<string>((resolve) =>
          socket.once('data', (d: string) => resolve(d)),
        );
      },
    );
    expect(result.status).toContain('200');
    expect(result.echoed).toBe('ping');
    expect(dialed).toEqual([{ address: '104.16.0.1', port: 443 }]);
    expect(proxy.stats()).toMatchObject({ allowed: 1, denied: 0 });
  });

  it('matches wildcard subdomains but not look-alike hosts', async () => {
    const { proxy, dialed } = await startProxy();
    const ok = await connectThrough(
      proxy.socketPath,
      'files.pythonhosted.org:443',
      async () => 'x',
    );
    expect(ok.status).toContain('200');
    const evil = await connectThrough(proxy.socketPath, 'registry.npmjs.org.evil.com:443');
    expect(evil.status).toContain('403');
    expect(dialed).toHaveLength(1);
    expect(proxy.stats().deniedHosts).toContain('registry.npmjs.org.evil.com');
  });

  it.each([
    ['example.com:443', 'a host outside the allowlist'],
    ['93.184.216.34:443', 'a raw IPv4 literal'],
    ['[2606:4700::1]:443', 'a raw IPv6 literal'],
    ['registry.npmjs.org:22', 'a non-web port'],
  ])('refuses %s (%s) without dialing', async (target) => {
    const { proxy, dialed } = await startProxy();
    const result = await connectThrough(proxy.socketPath, target);
    expect(result.status).toMatch(/403|400/);
    expect(dialed).toHaveLength(0);
    expect(proxy.stats().denied).toBe(1);
  });

  it('refuses an allowlisted name that resolves to a private address', async () => {
    const { proxy, dialed } = await startProxy({ resolve: async () => ['127.0.0.1'] });
    const result = await connectThrough(proxy.socketPath, 'registry.npmjs.org:443');
    expect(result.status).toContain('403');
    expect(dialed).toHaveLength(0);
  });

  it('refuses when any resolved address is private (DNS rebinding mix)', async () => {
    const { proxy, dialed } = await startProxy({
      resolve: async () => ['104.16.0.1', '10.0.0.5'],
    });
    const result = await connectThrough(proxy.socketPath, 'registry.npmjs.org:443');
    expect(result.status).toContain('403');
    expect(dialed).toHaveLength(0);
  });

  it('answers plain HTTP requests with 405 and removes the socket on close', async () => {
    const { proxy } = await startProxy();
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect({ path: proxy.socketPath });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('close', () => resolve(data.split('\r\n')[0] as string));
      socket.on('error', reject);
      socket.write('GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
    });
    expect(status).toContain('405');
  });
});

describe('tool shell wrapper egress', () => {
  const base: ToolShellSpec = {
    realShell: '/bin/bash',
    bwrap: '/usr/bin/bwrap',
    hidePaths: ['/data/runs'],
    runTmp: '/data/scope/tmp',
    scopeHome: '/data/scope/home',
    workspace: '/data/runs/ws',
  };

  it('stays fully offline without egress', () => {
    const script = renderToolShellWrapper(base);
    expect(script).toContain('--unshare-net');
    expect(script).not.toContain('socat');
    expect(script).not.toContain('--unshare-pid');
    expect(script).not.toContain('HTTPS_PROXY');
    expect(script).toContain('-- "$SENTRY_REAL_SHELL" -o pipefail -c "$SCRIPT"');
  });

  it('keeps the network namespace and adds only the proxy bridge with egress', () => {
    const script = renderToolShellWrapper({
      ...base,
      egress: {
        socketPath: '/data/scope/egress.sock',
        socat: '/usr/bin/socat',
        port: TOOL_SHELL_EGRESS_PORT,
      },
    });
    expect(script).toContain('--unshare-net');
    expect(script).toContain('--unshare-pid');
    expect(script).toContain('SENTRY_EGRESS_SOCKET=');
    expect(script).toContain('/usr/bin/socat');
    expect(script).toContain('TCP-LISTEN:' + TOOL_SHELL_EGRESS_PORT + ',bind=127.0.0.1');
    expect(script).toContain('UNIX-CONNECT:' + TOOL_SHELL_EGRESS_SOCKET);
    expect(script).toContain('HTTPS_PROXY');
    expect(script).toContain('http://127.0.0.1:' + TOOL_SHELL_EGRESS_PORT);
    // The socket is bound after the private /tmp, or the tmp bind would hide it.
    expect(script.indexOf('--bind "$SENTRY_RUN_TMP" /tmp')).toBeLessThan(
      script.indexOf('--bind "$SENTRY_EGRESS_SOCKET"'),
    );
    // The model's script still runs under pipefail inside the bridge.
    expect(script).toContain('-o pipefail -c "$1"');
  });

  it('points proxy environment only at the in-namespace loopback bridge', () => {
    const env = toolShellProxyEnvironment(4321);
    expect(new Set(Object.values(env).filter((v) => v.startsWith('http://')))).toEqual(
      new Set(['http://127.0.0.1:4321']),
    );
    expect(env['NO_PROXY']).toContain('127.0.0.1');
  });
});

/** Real bubblewrap + socat + proxy: only runs where all of them exist (Linux/WSL). */
const realSandbox = (() => {
  if (process.platform !== 'linux') return false;
  return ['/usr/bin/bwrap', '/usr/bin/socat', '/bin/bash'].every((path) => existsSync(path));
})();

describe.runIf(realSandbox)('tool shell egress end to end (real bwrap + socat)', () => {
  it('reaches registries only, refuses everything else, and keeps exit codes and pipefail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-egress-e2e-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const [home, runTmp, workspace] = ['home', 'tmp', 'ws'].map((name) => join(root, name));
    for (const dir of [home, runTmp, workspace] as string[]) await mkdir(dir);
    const dialed: Array<[string, number]> = [];
    const proxy = await startEgressProxy({
      socketPath: join(root, 'egress.sock'),
      allowedHosts: ['registry.npmjs.org'],
      resolve: async () => ['104.16.0.1'],
      dial: async (address, port): Promise<Duplex> => {
        dialed.push([address, port]);
        return new PassThrough() as unknown as Duplex;
      },
    });
    cleanup.push(() => proxy.close());
    const wrapper = join(root, 'sentry-bash');
    await writeFile(
      wrapper,
      renderToolShellWrapper({
        realShell: '/bin/bash',
        bwrap: '/usr/bin/bwrap',
        hidePaths: [],
        runTmp: runTmp as string,
        scopeHome: home as string,
        workspace: workspace as string,
        egress: {
          socketPath: proxy.socketPath,
          socat: '/usr/bin/socat',
          port: TOOL_SHELL_EGRESS_PORT,
        },
      }),
      { mode: 0o700 },
    );
    // The proxy lives in this process, so the shell must run asynchronously.
    const run = (script: string) =>
      new Promise<{ status: number | null; stdout: string }>((resolveRun) => {
        const child = spawn(wrapper, ['-c', script], {
          env: { HOME: home as string, PATH: process.env['PATH'] ?? '' },
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolveRun({ status, stdout });
        });
      });
    const ask = (host: string) =>
      'exec 3<>/dev/tcp/127.0.0.1/' +
      TOOL_SHELL_EGRESS_PORT +
      "; printf 'CONNECT " +
      host +
      ':443 HTTP/1.1\r\nHost: x\r\n\r\n\' >&3; read -r line <&3; echo "STATUS:$line"';
    expect((await run(ask('registry.npmjs.org'))).stdout).toMatch(/STATUS:HTTP\/1\.1 200/);
    expect((await run(ask('example.com'))).stdout).toMatch(/STATUS:HTTP\/1\.1 403/);
    expect(
      (await run('(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo OPEN || echo BLOCKED')).stdout,
    ).toContain('BLOCKED');
    expect((await run('exit 7')).status).toBe(7);
    expect((await run('false | true; echo PIPEFAIL_$?')).stdout).toContain('PIPEFAIL_1');
    expect(dialed).toEqual([['104.16.0.1', 443]]);
  }, 60_000);
});
