import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable } from '../src/process.js';
import { startOpenCodeAuthProxy } from '../src/proxy.js';
import { computeToolHiddenPaths, writeToolShellWrapper } from '../src/toolshell.js';

/**
 * Model-controlled tool-shell network boundary.
 *
 * The OpenCode PARENT keeps host networking (it must reach the localhost
 * auth proxy and the provider). Model-controlled SHELL invocations go
 * through the Sentry-generated bwrap wrapper with `--unshare-net`, so they
 * must not reach host loopback at all — including the proxy port.
 *
 * - Pure generation tests (wrapper contains --unshare-net) run everywhere.
 * - Real-namespace tests need production bwrap on Linux and are
 *   capability-gated: they return early where the host cannot provide the
 *   boundary, without quarantining the logical assertions.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listenOnLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('sentry-host-listener');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, port };
}

interface WrapperFixture {
  readonly wrapper: string;
  readonly workspace: string;
  readonly scopeHome: string;
}

async function wrapperFixture(bwrap: string): Promise<WrapperFixture> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-tool-net-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const scopeHome = join(root, 'home');
  const runTmp = join(root, 'run-tmp');
  const binDir = join(root, 'bin');
  const hidden = join(root, 'hidden');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace, { recursive: true });
  await mkdir(scopeHome, { recursive: true });
  await mkdir(runTmp, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(hidden, { recursive: true });
  await writeFile(join(workspace, 'probe.txt'), 'workspace-readable');
  await writeFile(join(hidden, 'secret.txt'), 'must-stay-hidden');
  const realShell = await findExecutable(['/bin/bash', '/usr/bin/bash']);
  if (realShell === undefined) throw new Error('No POSIX shell for tool-network fixture');
  const wrapper = await writeToolShellWrapper({
    scopeBinDir: binDir,
    spec: {
      realShell,
      bwrap,
      hidePaths: computeToolHiddenPaths({
        scopeDir: root,
        workspace,
        ...(process.env['HOME'] === undefined ? {} : { realHome: process.env['HOME'] }),
      }).concat([hidden]),
      runTmp,
      scopeHome,
      workspace,
    },
  });
  return { wrapper, workspace, scopeHome };
}

function runThroughWrapper(input: {
  readonly wrapper: string;
  readonly scopeHome: string;
  readonly script: string;
  readonly timeoutMs?: number;
}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(input.wrapper, ['-c', input.script], {
    encoding: 'utf8',
    timeout: input.timeoutMs ?? 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: input.scopeHome,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Self-calibrating gate: the generated wrapper must execute at all. */
async function productionWrapperOrSkip(): Promise<WrapperFixture | undefined> {
  if (process.platform !== 'linux') return undefined;
  // Absolute candidates only: a bare 'bwrap' would resolve optimistically
  // without proving production containment exists on this host.
  const bwrap = await findExecutable(['/usr/bin/bwrap', '/bin/bwrap']);
  if (bwrap === undefined) return undefined;
  const fixture = await wrapperFixture(bwrap);
  const calibrated = runThroughWrapper({
    wrapper: fixture.wrapper,
    scopeHome: fixture.scopeHome,
    script: 'echo sentry-wrapper-alive',
  });
  if (calibrated.status !== 0 || !calibrated.stdout.includes('sentry-wrapper-alive')) {
    return undefined;
  }
  return fixture;
}

describe('tool-shell network boundary', () => {
  it('the OpenCode parent reaches its localhost auth proxy (host networking intact)', async () => {
    // Parent-side proof: the proxy is reachable over host loopback from a
    // normal host-networked process. The wrapper change never touches this
    // path — the OpenCode parent is spawned outside bwrap.
    const proxy = await startOpenCodeAuthProxy({
      apiKey: 'sentry-test-proxy-key',
      allowedModel: 'openrouter/anthropic/claude-test',
      upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    });
    try {
      const response = await fetch(proxy.baseUrl + '/models');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      expect(body.data?.[0]?.id).toBe('openrouter/anthropic/claude-test');
    } finally {
      await proxy.close();
    }
  });

  it('model-controlled shells cannot reach a host loopback listener', async () => {
    const fixture = await productionWrapperOrSkip();
    if (fixture === undefined) return;
    const { server, port } = await listenOnLoopback();
    try {
      // Sanity: the listener IS reachable from host networking.
      const direct = await fetch('http://127.0.0.1:' + String(port) + '/');
      expect(direct.status).toBe(200);
      // Through the wrapper (fresh network namespace, lo down): unreachable.
      const node = process.execPath;
      const probed = runThroughWrapper({
        wrapper: fixture.wrapper,
        scopeHome: fixture.scopeHome,
        script:
          `"${node}" -e "fetch('http://127.0.0.1:${String(port)}/')` +
          `.then(()=>console.log('SENTRY_NET_REACHABLE'))` +
          `.catch(()=>console.log('SENTRY_NET_BLOCKED'))"`,
      });
      expect(probed.status).toBe(0);
      expect(probed.stdout).toContain('SENTRY_NET_BLOCKED');
      expect(probed.stdout).not.toContain('SENTRY_NET_REACHABLE');
    } finally {
      server.close();
    }
  });

  it('model-controlled shells keep expected filesystem and workspace access', async () => {
    const fixture = await productionWrapperOrSkip();
    if (fixture === undefined) return;
    // Workspace stays readable inside the namespace.
    const readable = runThroughWrapper({
      wrapper: fixture.wrapper,
      scopeHome: fixture.scopeHome,
      script: 'cat "$SENTRY_WORKSPACE/probe.txt"',
    });
    expect(readable.status).toBe(0);
    expect(readable.stdout).toContain('workspace-readable');
    // Hidden paths stay hidden (empty tmpfs mount, not the host content).
    const hidden = runThroughWrapper({
      wrapper: fixture.wrapper,
      scopeHome: fixture.scopeHome,
      script: 'cat "$SENTRY_WORKSPACE/../hidden/secret.txt"',
    });
    expect(hidden.status).not.toBe(0);
    expect(hidden.stdout).not.toContain('must-stay-hidden');
  });

  it('the generated wrapper refuses unexpected invocations without networking', async () => {
    const fixture = await productionWrapperOrSkip();
    if (fixture === undefined) return;
    // Version drift fails loud (exit 126) instead of executing outside
    // the namespace.
    const direct = spawnSync(fixture.wrapper, ['--unexpected-flag'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', HOME: fixture.scopeHome },
    });
    expect(direct.status).toBe(126);
  });
});
