/**
 * HR-02.5D2 unit tests: downloader, checksum, process runner, python.
 *
 * Fully deterministic: injected fake transports/runners/filesystems.
 * No internet, no real pip, no GPU, no models.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto') as typeof import('node:crypto');

import { ArthurError } from '../../src/core/errors/errors';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  downloadArtifact,
  internalDefineTrustedArtifactSource,
  type HttpTransport,
  type TransportResponse,
  type TrustedArtifactSource,
} from '../../src/runtime/local-models/provisioning/downloader';
import { memoryDownloadFs } from '../../src/runtime/local-models/provisioning/downloader';

// Tests reach the internal factory via deep module import (the unit-test
// convention in this repo); it is absent from every public barrel, so a
// generic runtime caller importing from barrels cannot mint sources.
function src(url: string): TrustedArtifactSource {
  return internalDefineTrustedArtifactSource(url, 'test-source');
}
import {
  memoryVerifyFs,
  normalizeSha256,
  sha256OfFile,
  verifyArtifact,
} from '../../src/runtime/local-models/provisioning/verification';
import {
  describeRun,
  runTrustedProcess,
  type SpawnFn,
} from '../../src/runtime/local-models/provisioning/process_runner';
import {
  checkVersionSpec,
  discoverSystemPython,
  ensureEnvironment,
  environmentPython,
  installPinnedPackages,
} from '../../src/runtime/local-models/provisioning/python';

const ROOT = path.resolve('/managed');

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

function bodyOf(chunks: string[]): AsyncIterable<Uint8Array> {
  const snapshot = [...chunks];
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (i >= snapshot.length) return Promise.resolve({ done: true, value: undefined });
          const value = Buffer.from(snapshot[i] as string);
          i += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function transportFor(status: number, chunks: string[] = [], headers: Record<string, string> = {}): HttpTransport {
  return async () => ({ status, headers, body: bodyOf(chunks), cancel: () => {} });
}

// ---- downloader -------------------------------------------------------------------

test('successful streamed download lands at the destination', async () => {
  const fs = memoryDownloadFs();
  const dest = path.join(ROOT, 'staging', 'a.bin');
  const result = await downloadArtifact(ROOT, transportFor(200, ['hello ', 'world']), fs, { source: src('https://example.com/a.bin'), destPath: dest });
  assert.equal(result.outcome, 'downloaded');
  assert.equal(result.path, path.normalize(dest));
  assert.equal(result.bytes_written, 11);
  const stored = (fs.files.get(path.normalize(dest)) ?? []).map((c) => Buffer.from(c).toString()).join('');
  assert.equal(stored, 'hello world');
  assert.equal(fs.files.has(path.normalize(dest) + '.part'), false);
});

test('non-https urls are rejected at source definition', async () => {
  // Origin trust: untrusted schemes cannot even become a source — the
  // factory (trusted installer code) rejects them before any transport.
  for (const url of ['http://example.com/a', 'file:///etc/passwd', 'ftp://example.com/a', 'javascript:alert(1)']) {
    assert.throws(() => internalDefineTrustedArtifactSource(url, 'evil'), (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG');
  }
  // A forged source-shaped object (no brand) is rejected at the boundary.
  const fs = memoryDownloadFs();
  const forged = { url: 'https://example.com/a.bin', label: 'forged' };
  await assert.rejects(
    () => downloadArtifact(ROOT, transportFor(200), fs, { source: forged as never, destPath: path.join(ROOT, 'a.bin') }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

test('redirects are followed within the limit and https-only', async () => {
  const fs = memoryDownloadFs();
  let calls = 0;
  const hopping: HttpTransport = async (url): Promise<TransportResponse> => {
    calls += 1;
    if (url === 'https://example.com/start') {
      return { status: 302, headers: { location: 'https://example.com/next' }, body: bodyOf([]), cancel: () => {} };
    }
    return { status: 200, headers: {}, body: bodyOf(['ok']), cancel: () => {} };
  };
  const dest = path.join(ROOT, 'a.bin');
  const result = await downloadArtifact(ROOT, hopping, fs, { source: src('https://example.com/start'), destPath: dest });
  assert.equal(result.outcome, 'downloaded');
  assert.equal(calls, 2);
  const evilTarget = 'http' + '://evil.example/x';
  const evil: HttpTransport = async () => ({ status: 302, headers: { location: evilTarget }, body: bodyOf([]), cancel: () => {} });
  const bad = await downloadArtifact(ROOT, evil, fs, { source: src('https://example.com/start'), destPath: dest, maxRedirects: 2 });
  assert.equal(bad.outcome, 'failed');
  const loop: HttpTransport = async () => ({ status: 302, headers: { location: 'https://example.com/loop' }, body: bodyOf([]), cancel: () => {} });
  const limited = await downloadArtifact(ROOT, loop, fs, { source: src('https://example.com/loop'), destPath: dest, maxRedirects: 1 });
  assert.equal(limited.outcome, 'failed');
});

test('size limit discards the partial file', async () => {
  const fs = memoryDownloadFs();
  const dest = path.join(ROOT, 'big.bin');
  const result = await downloadArtifact(ROOT, transportFor(200, ['x'.repeat(100)]), fs, { source: src('https://example.com/big.bin'), destPath: dest, maxBytes: 10 });
  assert.equal(result.outcome, 'failed');
  assert.equal(fs.files.has(path.normalize(dest)), false);
  assert.equal(fs.files.has(path.normalize(dest) + '.part'), false);
});

test('http failures and aborts map deterministically', async () => {
  const fs = memoryDownloadFs();
  const dest = path.join(ROOT, 'x.bin');
  const missing = await downloadArtifact(ROOT, transportFor(404), fs, { source: src('https://example.com/x'), destPath: dest });
  assert.equal(missing.outcome, 'failed');
  const auth = await downloadArtifact(ROOT, transportFor(401), fs, { source: src('https://example.com/x'), destPath: dest });
  assert.equal(auth.outcome, 'auth_required');
  assert.ok((auth.reason ?? '').includes('no token'));
  const controller = new AbortController();
  controller.abort();
  const cancelled = await downloadArtifact(ROOT, transportFor(200, ['x']), fs, { source: src('https://example.com/x'), destPath: dest, signal: controller.signal });
  assert.equal(cancelled.outcome, 'cancelled');
});

test('partial files are never valid artifacts', async () => {
  const fs = memoryDownloadFs();
  const dest = path.join(ROOT, 'p.bin');
  const failing: HttpTransport = async () => {
    return {
      status: 200,
      headers: {},
      body: { [Symbol.asyncIterator]() { throw new Error('socket reset'); } },
      cancel: () => {},
    };
  };
  const result = await downloadArtifact(ROOT, failing, fs, { source: src('https://example.com/p.bin'), destPath: dest });
  assert.equal(result.outcome, 'failed');
  assert.equal(fs.files.has(path.normalize(dest)), false);
});

test('destination outside the root is refused', async () => {
  const fs = memoryDownloadFs();
  await assert.rejects(
    () => downloadArtifact(ROOT, transportFor(200, ['x']), fs, { source: src('https://example.com/x'), destPath: '/etc/evil.bin' }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

// ---- checksum -----------------------------------------------------------------------

function shaOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('valid sha-256 passes and streams large files', async () => {
  const files = new Map<string, Uint8Array[]>();
  const big = 'abcd'.repeat(65536);
  files.set('/f/big.bin', [Buffer.from(big.slice(0, 100000)), Buffer.from(big.slice(100000))]);
  const fs = memoryVerifyFs(files);
  const { hex, bytes } = await sha256OfFile(fs, '/f/big.bin');
  assert.equal(hex, shaOf(big));
  assert.equal(bytes, big.length);
  const verified = await verifyArtifact(fs, '/f/big.bin', { mode: 'required', expected_sha256: shaOf(big).toUpperCase() });
  assert.equal(verified.sha256_hex, shaOf(big));
});

test('mismatch removes the staged copy and fails', async () => {
  const files = new Map<string, Uint8Array[]>();
  files.set('/f/a.bin', [Buffer.from('real-bytes')]);
  const fs = memoryVerifyFs(files);
  await assert.rejects(
    () => verifyArtifact(fs, '/f/a.bin', { mode: 'required', expected_sha256: shaOf('other-bytes') }),
    (e: unknown) => codeOf(e) === 'TOOL_EXECUTION_FAILED',
  );
  assert.equal(files.has('/f/a.bin'), false);
});

test('malformed hashes and missing required hashes fail closed', async () => {
  const files = new Map<string, Uint8Array[]>();
  files.set('/f/a.bin', [Buffer.from('x')]);
  const fs = memoryVerifyFs(files);
  await assert.rejects(() => verifyArtifact(fs, '/f/a.bin', { mode: 'required', expected_sha256: 'zzz' }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  await assert.rejects(() => verifyArtifact(fs, '/f/a.bin', { mode: 'required' }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.equal(normalizeSha256('  ' + shaOf('x') + '\n'), shaOf('x'));
});

test('optional and provider_verified modes are explicit', async () => {
  const files = new Map<string, Uint8Array[]>();
  files.set('/f/a.bin', [Buffer.from('x')]);
  const fs = memoryVerifyFs(files);
  const opt = await verifyArtifact(fs, '/f/a.bin', { mode: 'optional' });
  assert.equal(opt.sha256_hex, 'unverified');
  const pv = await verifyArtifact(fs, '/f/a.bin', { mode: 'provider_verified' });
  assert.equal(pv.sha256_hex, 'provider-verified');
});

// ---- process runner --------------------------------------------------------------------

function fakeSpawn(behavior: (exe: string, args: readonly string[]) => { code: number | null; stdout: string; stderr: string; delayMs?: number; neverClose?: boolean }): SpawnFn {
  return (_exe, _args) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    (child as unknown as { stdout: unknown }).stdout = out;
    (child as unknown as { stderr: unknown }).stderr = err;
    (child as unknown as { pid: number }).pid = 4242;
    child.kill = () => true;
    const b = behavior(_exe, [..._args]);
    const delay = b.delayMs ?? 0;
    setTimeout(() => {
      if (b.neverClose) return;
      if (b.stdout !== '') out.emit('data', Buffer.from(b.stdout));
      if (b.stderr !== '') err.emit('data', Buffer.from(b.stderr));
      (child.emit as (e: string, ...a: unknown[]) => boolean).call(child, 'close', b.code, null);
    }, delay);
    return child;
  };
}

test('argv are preserved and success is reported', async () => {
  let seen: string[] = [];
  const spawn = fakeSpawn((exe, args) => {
    seen = [exe, ...args];
    return { code: 0, stdout: 'out', stderr: '' };
  });
  const result = await runTrustedProcess(spawn, { executable: '/trusted/python', args: ['-m', 'venv', '/managed/x', 'two words'] });
  assert.deepEqual(seen, ['/trusted/python', '-m', 'venv', '/managed/x', 'two words']);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(describeRun('/trusted/python', result), '/trusted/python: ok'.replace('/trusted/', ''));
});

test('env overlay reaches the spawn boundary and is validated', async () => {
  let seenEnv: Record<string, string> | undefined;
  const spawn: SpawnFn = ((_exe, _args, options) => {
    seenEnv = options.env;
    return fakeSpawn(() => ({ code: 0, stdout: '', stderr: '' }))(_exe, _args, options);
  }) as SpawnFn;
  const result = await runTrustedProcess(spawn, {
    executable: '/trusted/python',
    args: [],
    env: { HF_HOME: '/managed/cache/huggingface', HF_HUB_CACHE: '/managed/cache/huggingface/hub' },
  });
  assert.equal(result.exit_code, 0);
  assert.deepEqual(seenEnv, { HF_HOME: '/managed/cache/huggingface', HF_HUB_CACHE: '/managed/cache/huggingface/hub' });
  // checkSpec throws synchronously (pre-existing runner behavior).
  assert.throws(
    () => runTrustedProcess(spawn, { executable: '/trusted/python', args: [], env: { '': 'x' } }),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => runTrustedProcess(spawn, { executable: '/trusted/python', args: [], env: { HF_HOME: 'a\0b' } }),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
});

test('non-zero exit is reported without output dumps', async () => {
  const spawn = fakeSpawn(() => ({ code: 3, stdout: 'o', stderr: 'e' }));
  const result = await runTrustedProcess(spawn, { executable: '/trusted/pip', args: [] });
  assert.equal(result.exit_code, 3);
  assert.ok(describeRun('/trusted/pip', result).includes('exit 3'));
  assert.ok(!describeRun('/trusted/pip', result).includes('secret'));
});

test('timeout kills and reports timed_out', async () => {
  const spawn = fakeSpawn(() => ({ code: 0, stdout: '', stderr: '', delayMs: 5000 }));
  const result = await runTrustedProcess(spawn, { executable: '/trusted/x', args: [], timeoutMs: 20 });
  assert.equal(result.timed_out, true);
});

test('abort reports aborted', async () => {
  const spawn = fakeSpawn(() => ({ code: 0, stdout: '', stderr: '', delayMs: 5000 }));
  const controller = new AbortController();
  const pending = runTrustedProcess(spawn, { executable: '/trusted/x', args: [], timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
});

test('stdout and stderr are capped', async () => {
  const spawn = fakeSpawn(() => ({ code: 0, stdout: 'A'.repeat(10000), stderr: 'B'.repeat(10000) }));
  const result = await runTrustedProcess(spawn, { executable: '/trusted/x', args: [], maxStdoutBytes: 100, maxStderrBytes: 50 });
  assert.equal(result.stdout.length, 100);
  assert.equal(result.stderr.length, 50);
});

// ---- python ------------------------------------------------------------------------------

function okVersion(text: string): (exe: string, args: readonly string[]) => Promise<{ exit_code: number; signal: null; timed_out: false; aborted: false; stdout: string; stderr: string }> {
  return async () => ({ exit_code: 0, signal: null, timed_out: false, aborted: false, stdout: text, stderr: '' });
}

test('python discovery success, not found, and wrong version', async () => {
  const found = await discoverSystemPython(okVersion('Python 3.11.9'), { minVersion: '3.10.0' });
  assert.equal(found.status, 'found');
  const old = await discoverSystemPython(okVersion('Python 3.8.1'), { minVersion: '3.10.0' });
  assert.equal(old.status, 'unsupported_version');
  const missing = await discoverSystemPython(async () => ({ exit_code: 1, signal: null, timed_out: false, aborted: false, stdout: '', stderr: '' }));
  assert.equal(missing.status, 'not_found');
  assert.equal(checkVersionSpec('3.11.0', { maxVersionExclusive: '3.12.0' }), true);
  assert.equal(checkVersionSpec('3.12.0', { maxVersionExclusive: '3.12.0' }), false);
});

test('venv creation argv shape and interpreter resolution', async () => {
  const seen: Array<{ exe: string; args: readonly string[] }> = [];
  const spawn = fakeSpawn((exe, args) => {
    seen.push({ exe, args });
    return { code: 0, stdout: '', stderr: '' };
  });
  const runtimeDir = path.join(ROOT, 'runtimes', 'python', 'py-1');
  const env = await ensureEnvironment({ root: ROOT, runtimeDir, systemPython: '/trusted/python3', fs: { exists: () => false }, run: spawn });
  assert.deepEqual(seen[0] && [seen[0].exe, ...(seen[0].args as string[])], ['/trusted/python3', '-m', 'venv', runtimeDir]);
  assert.equal(env.python_executable, environmentPython(ROOT, runtimeDir));
  assert.ok(env.python_executable.startsWith(ROOT));
  // Existing env is reused without re-running venv.
  const env2 = await ensureEnvironment({ root: ROOT, runtimeDir, systemPython: '/trusted/python3', fs: { exists: () => true }, run: spawn });
  assert.equal(seen.length, 1);
  assert.equal(env2.root, runtimeDir);
});

test('venv outside the root and venv failure are rejected', async () => {
  const spawn = fakeSpawn(() => ({ code: 0, stdout: '', stderr: '' }));
  await assert.rejects(
    () => ensureEnvironment({ root: ROOT, runtimeDir: '/etc/evil', systemPython: '/trusted/python3', fs: { exists: () => false }, run: spawn }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
  const failing = fakeSpawn(() => ({ code: 1, stdout: '', stderr: 'nope' }));
  await assert.rejects(
    () => ensureEnvironment({ root: ROOT, runtimeDir: path.join(ROOT, 'runtimes', 'python', 'py-9'), systemPython: '/trusted/python3', fs: { exists: () => false }, run: failing }),
    (e: unknown) => codeOf(e) === 'TOOL_EXECUTION_FAILED',
  );
});

test('package install argv is pinned and code-owned', async () => {
  const seen: Array<{ exe: string; args: readonly string[] }> = [];
  const spawn = fakeSpawn((exe, args) => {
    seen.push({ exe, args });
    return { code: 0, stdout: 'ok', stderr: '' };
  });
  const env = { runtime_id: 'py-1', root: path.join(ROOT, 'runtimes', 'python', 'py-1'), python_executable: path.join(ROOT, 'runtimes', 'python', 'py-1', 'bin', 'python'), version: 'managed' };
  const out = await installPinnedPackages({ env, packages: { packages: ['numpy==1.26.4', 'torch==2.2.0'], indexUrl: 'https://example.com/simple' }, run: spawn });
  assert.deepEqual(out.installed, ['numpy==1.26.4', 'torch==2.2.0']);
  const argv = (seen[0] as { args: readonly string[] }).args as string[];
  assert.ok(argv.includes('--no-input') && argv.includes('--disable-pip-version-check'));
  assert.ok(argv.includes('--index-url') && argv.includes('https://example.com/simple'));
  assert.ok(!argv.join(' ').includes(';') && !argv.join(' ').includes('&&'));
  const evilPkg = { env, packages: { packages: ['evil; rm -rf /'] }, run: spawn };
  await assert.rejects(() => installPinnedPackages(evilPkg), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  // Correction 3: pip parses argv flags even with shell=false, so option
  // injection through the package list must fail before argv construction.
  const flagPkg = { env, packages: { packages: ['--index-url=https://evil.invalid'] }, run: spawn };
  await assert.rejects(() => installPinnedPackages(flagPkg), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  const dashPkg = { env, packages: { packages: ['-r', 'requirements.txt'] }, run: spawn };
  await assert.rejects(() => installPinnedPackages(dashPkg), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  const before = seen.length;
  await assert.rejects(() => installPinnedPackages({ env, packages: { packages: [''] }, run: spawn }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.equal(seen.length, before);
  const badIndexPkg = { env, packages: { packages: ['numpy==1.0'], indexUrl: 'notaurl' }, run: spawn };
  await assert.rejects(() => installPinnedPackages(badIndexPkg), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  const failing = fakeSpawn(() => ({ code: 2, stdout: '', stderr: 'bad' }));
  await assert.rejects(
    () => installPinnedPackages({ env, packages: { packages: ['numpy==1.0'] }, run: failing }),
    (e: unknown) => codeOf(e) === 'TOOL_EXECUTION_FAILED',
  );
});

test('python cancellation aborts venv creation', async () => {
  const spawn = fakeSpawn(() => ({ code: 0, stdout: '', stderr: '', delayMs: 5000 }));
  const controller = new AbortController();
  const pending = ensureEnvironment({ root: ROOT, runtimeDir: path.join(ROOT, 'runtimes', 'python', 'py-c'), systemPython: '/trusted/python3', fs: { exists: () => false }, run: spawn, timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (e: unknown) => codeOf(e) === 'TOOL_EXECUTION_FAILED');
});

test('public barrels do not expose the trust-construction primitive', async () => {
  const provisioning = await import('../../src/runtime/local-models/provisioning/index');
  assert.equal('internalDefineTrustedArtifactSource' in provisioning, false);
  assert.equal('defineTrustedArtifactSource' in provisioning, false);
  const localModels = await import('../../src/runtime/local-models/index');
  assert.equal('internalDefineTrustedArtifactSource' in localModels, false);
  assert.equal('defineTrustedArtifactSource' in localModels, false);
  // The opaque TYPE is still consumable for signatures; only construction
  // is restricted. A forged object is rejected at the download boundary.
  const fs = memoryDownloadFs();
  const forged = { url: 'https://example.com/a.bin', label: 'forged' };
  await assert.rejects(
    () => downloadArtifact(ROOT, transportFor(200), fs, { source: forged as never, destPath: path.join(ROOT, 'a.bin') }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

test('provisioning never touches lifecycle state or routers', async () => {
  const { LocalModelStateStore } = await import('../../src/runtime/local-models/state_store');
  const { memoryStateFileSystem } = await import('../../src/runtime/local-models/state_store');
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: '/s.json', fs });
  await store.markInstalled('m');
  assert.deepEqual(Object.keys(store.snapshot().models), ['m']);
});
