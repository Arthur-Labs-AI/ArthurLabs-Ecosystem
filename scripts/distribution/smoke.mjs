// Real production entrypoint/preload/renderer/IPC against an isolated runtime.
// Usage: node smoke.mjs extractedArchiveRoot linuxRuntimeEntry linuxDisposableData
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { validate } from './contract.mjs';

const [input, entry, data, historyReceipt, settingsMode, settingsSession] = process.argv.slice(2);
if (process.platform !== 'win32' || !input || !entry || !data?.startsWith('/'))
  throw new Error(
    'Windows smoke requires extracted archive, Linux runtime entry and disposable absolute Linux data root',
  );
const sourceBeta = input.startsWith('source-beta:');
const root = resolve(sourceBeta ? input.slice('source-beta:'.length) : input);
const manifest = sourceBeta
  ? {
      version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    }
  : await validate(root);
if (sourceBeta) {
  assert.equal(settingsMode, 'seed');
  assert.equal(manifest.sourceCommit, '0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    '',
  );
}
const synthetic = process.env['SENTRY_SMOKE_SYNTHETIC'];
if (settingsMode) {
  assert.ok(['seed', 'verify'].includes(settingsMode));
  assert.ok(
    settingsSession &&
      resolve(settingsSession).startsWith(join(tmpdir(), 'sentry secure settings ')),
  );
  assert.ok(synthetic?.startsWith('synthetic-nonproduction-'));
}
const temporary = settingsMode
  ? resolve(settingsSession)
  : await mkdtemp(join(tmpdir(), 'sentry packaged smoke '));
await mkdir(join(temporary, 'appdata'), { recursive: true });
await mkdir(join(temporary, 'localappdata'), { recursive: true });
await mkdir(join(temporary, 'temp'), { recursive: true });
const source = join(temporary, 'synthetic project');
await mkdir(source, { recursive: true });
await writeFile(
  join(source, 'package.json'),
  '{"name":"sentry-packaged-fixture","version":"1.0.0"}\n',
);
await writeFile(join(source, 'index.js'), 'export const fixture = true;\n');
const env = {
  ...process.env,
  APPDATA: join(temporary, 'appdata'),
  LOCALAPPDATA: join(temporary, 'localappdata'),
  TEMP: join(temporary, 'temp'),
  TMP: join(temporary, 'temp'),
  SENTRY_DATA_ROOT: data,
  SENTRY_RUNTIME_ENTRY: entry,
  SENTRY_DESKTOP_URL: 'http://127.0.0.1:1/must-be-ignored',
};
delete env['SENTRY_SMOKE_SYNTHETIC'];
if (sourceBeta) delete env['SENTRY_DESKTOP_URL'];
// Keep the smoke independent of the owner's provider settings and legacy env file.
for (const name of Object.keys(env))
  if (
    /^(OPENROUTER_API_KEY|OPENCODE_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|SENTRY_(OPENCODE|DEEPSEEK|GLM)_)/i.test(
      name,
    )
  )
    delete env[name];
const profile = join(temporary, 'appdata/@qa/desktop');
await mkdir(profile, { recursive: true });
const exe = sourceBeta
  ? join(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
  : join(root, 'desktop/Sentry.exe');
const baseArgs = [
  ...(sourceBeta ? [join(root, 'apps/desktop')] : []),
  '--user-data-dir=' + profile,
];
if (!sourceBeta) {
  const identity = JSON.parse(
    execFileSync(exe, [...baseArgs, '--sentry-version'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    }).trim(),
  );
  assert.equal(identity.sourceCommit, manifest.sourceCommit);
}
let port;
await rm(join(profile, 'DevToolsActivePort'), { force: true });
const child = spawn(
  exe,
  [
    ...baseArgs,
    '--sentry-app',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stdout.on('data', (c) => {
  log = (log + c).slice(-10000);
});
child.stderr.on('data', (c) => {
  log = (log + c).slice(-10000);
});
const exited = once(child, 'close');
let socket;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Packaged app exited: ' + log);
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      /* startup */
    }
    await delay(250);
  }
  throw new Error('Packaged smoke timed out: ' + log);
}
try {
  // Electron uses OS known folders on Windows, ignoring APPDATA. Require proof
  // of the explicit profile before accessing any credential or project IPC.
  port = Number(
    (await until(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8'))).split('\n')[0],
  );
  assert.ok(Number.isInteger(port) && port > 0);
  const page = await until(async () =>
    (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
      (p) => p.type === 'page' && p.url.includes('/dist/renderer/index.html'),
    ),
  );
  assert.ok(page.url.startsWith('file:'));
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (pending.has(response.id)) {
      pending.get(response.id)(response);
      pending.delete(response.id);
    }
  });
  async function evaluate(expression) {
    const current = ++id;
    const response = new Promise((r) => pending.set(current, r));
    socket.send(
      JSON.stringify({
        id: current,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    const value = await Promise.race([
      response,
      delay(30000).then(() => {
        throw new Error('CDP evaluation timeout');
      }),
    ]);
    if (value.result?.exceptionDetails)
      throw new Error(JSON.stringify(value.result.exceptionDetails));
    return value.result?.result?.value;
  }
  await until(() =>
    evaluate('typeof window.sentry === "object" && document.body.innerText.length > 0'),
  );
  assert.equal(
    await evaluate(
      'typeof window.require === "undefined" && typeof window.process === "undefined"',
    ),
    true,
  );
  const runtime = await evaluate('window.sentry.runtime.status()');
  assert.equal(runtime.connected, true);
  if (!sourceBeta) assert.equal(runtime.hello.sourceCommit, manifest.sourceCommit);
  assert.equal(runtime.hello.runtimeVersion, manifest.version);
  assert.equal(runtime.hello.platform, 'linux');
  assert.equal(runtime.hello.isElectron, false);
  if (settingsMode) {
    const before = await evaluate('window.sentry.providers.status()');
    const status = before.find((s) => s.name === 'DEEPSEEK_API_KEY');
    assert.equal(status.configured, settingsMode === 'verify');
    if (settingsMode === 'seed') {
      const saved = await evaluate(
        `window.sentry.providers.save("DEEPSEEK_API_KEY", ${JSON.stringify(synthetic)})`,
      );
      assert.equal(saved.configured, true);
      assert.equal(saved.persistence, 'secure');
    } else {
      // Stored/secure requires a successful real safeStorage decrypt on this new boot.
      assert.equal(status.persistence, 'secure');
      assert.equal(status.source, 'stored');
    }
  }
  const imported = await evaluate(`window.sentry.projects.add(${JSON.stringify(source)})`);
  assert.ok(imported);
  const projects = await evaluate('window.sentry.projects.list()');
  assert.ok(projects.length >= 1);
  if (historyReceipt) {
    const history = JSON.parse(await readFile(historyReceipt, 'utf8'));
    assert.equal(history.dataRoot, data);
    assert.ok(projects.some((p) => p.projectId === history.projectId));
    const preserved = await evaluate(`window.sentry.runs.get(${JSON.stringify(history.runId)})`);
    assert.equal(preserved.run.status, 'completed');
    assert.equal(preserved.revision.id, history.revisionId);
    assert.ok(
      preserved.agentRuns.some((a) => a.id === history.agentRunId && a.status === 'completed'),
    );
    assert.ok(preserved.findings.some((f) => f.id === history.findingId));
    assert.ok(
      preserved.findings.some((f) => f.agentRunId === history.agentRunId && f.sourceAgentStackId),
    );
    assert.ok(preserved.evidence.some((e) => e.id === history.evidenceId));
    const revisions = await evaluate(
      `window.sentry.projects.revisions(${JSON.stringify(history.projectId)})`,
    );
    assert.ok(revisions.length >= 2);
    const issues = await evaluate(
      `window.sentry.issues.list(${JSON.stringify(history.projectId)})`,
    );
    assert.ok(issues.some((i) => i.id === history.issueId));
    const retests = await evaluate(
      `window.sentry.retests.list(${JSON.stringify(history.issueId)})`,
    );
    assert.ok(retests.some((r) => r.id === history.retestId && r.status === 'completed'));
  }
  await evaluate('location.hash = "#/projects"');
  assert.ok((await evaluate('location.href')).includes('#/projects'));
  // Invalid renderer requests still traverse production validation.
  assert.equal(await evaluate('window.sentry.projects.get("").then(()=>false,()=>true)'), true);
  const second = spawn(exe, [...baseArgs, '--sentry-app'], { env, stdio: 'ignore' });
  const [secondCode] = await once(second, 'close');
  assert.equal(secondCode, 0);
  const control = spawn(exe, [...baseArgs, '--sentry-control=stop'], { env, stdio: 'ignore' });
  await once(control, 'close');
  const [code] = await Promise.race([
    exited,
    delay(30000).then(() => {
      throw new Error('Graceful packaged shutdown timed out');
    }),
  ]);
  assert.equal(code, 0);
  if (settingsMode) {
    const store = JSON.parse(
      await readFile(join(temporary, 'appdata/@qa/desktop/credentials/providers.json'), 'utf8'),
    );
    assert.ok(store.secrets.DEEPSEEK_API_KEY);
    async function noPlaintext(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await noPlaintext(path);
        else if (item.isFile())
          assert.equal(
            (await readFile(path)).includes(Buffer.from(synthetic)),
            false,
            'Synthetic plaintext found in ' + path,
          );
      }
    }
    assert.equal(log.includes(synthetic), false, 'Synthetic plaintext found in application output');
    await noPlaintext(temporary);
    if (!sourceBeta) await noPlaintext(root);
  }
  console.log(
    JSON.stringify({
      packagedSmoke: 'PASS',
      sourceCommit: manifest.sourceCommit,
      manifestVersion: manifest.version,
      productionEntry: true,
      sourceBeta,
      explicitProfileVerified: true,
      preload: true,
      renderer: true,
      rendererNodeAccess: false,
      ipcValidation: true,
      linuxHandshake: true,
      projectImport: true,
      betaHistory: Boolean(historyReceipt),
      encryptedSettings: settingsMode ?? 'SKIPPED',
      singleInstance: true,
      gracefulStop: true,
      appData: temporary,
      dataRoot: data,
    }),
  );
} catch (error) {
  console.error(synthetic ? log.replaceAll(synthetic, '[redacted]') : log);
  if (synthetic) throw new Error(String(error).replaceAll(synthetic, '[redacted]'));
  throw error;
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
