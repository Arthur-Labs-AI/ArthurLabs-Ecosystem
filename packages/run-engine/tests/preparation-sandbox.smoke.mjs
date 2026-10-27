import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { createWorkspacePreparer } from '../dist/workspace-preparation.js';
import { SystemdSandboxBackend } from '../../verifier/dist/index.js';
const { AbortController } = globalThis;
const parent = process.env.SENTRY_SANDBOX_SMOKE_PARENT ?? join(homedir(), '.local', 'share');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'sentry-depth-smoke-'));
const suppliedStore = process.env.SENTRY_SANDBOX_SMOKE_STORE;
const seed = suppliedStore ?? join(root, 'cache');
if (suppliedStore === undefined) await mkdir(join(seed, 'v3', 'files'), { recursive: true });
const peer = join(root, 'private-original.txt');
await writeFile(peer, 'original');
const server = createServer((req, res) => res.end('host-visible'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const backend = new SystemdSandboxBackend();
let isolationChecks = 0;
const wrapped = {
  id: backend.id,
  preflight: (parent) => backend.preflight(parent),
  createEnvironment: async (input) => {
    const env = await backend.createEnvironment(input);
    return {
      ...env,
      sandboxId: env.sandboxId,
      dispose: () => env.dispose(),
      run: async (command) => {
        const result = await env.run(command);
        if (command.args[0] === 'install' && result.exitCode !== 0)
          console.error(JSON.stringify({ preparationFailure: result }));
        if (command.args[0] === 'install' && result.exitCode === 0) {
          const probe = await env.run({
            ...command,
            executable: process.execPath,
            args: [
              '--input-type=module',
              '-e',
              `import {readFile} from 'node:fs/promises';let readable=false;try{await readFile(${JSON.stringify(peer)});readable=true}catch{};let connected=false;try{await fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(2000)});connected=true}catch{};process.exit(readable||connected?1:0)`,
            ],
          });
          if (probe.exitCode !== 0) throw new Error('isolation failure ' + JSON.stringify(probe));
          isolationChecks++;
        }
        return result;
      },
    };
  },
};
try {
  const receipts = [];
  for (const name of ['a', 'b']) {
    const workspaceRoot = join(root, name);
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: 'private-' + name,
        version: '1.0.0',
        packageManager: 'pnpm@9.12.3',
        dependencies: {
          'private-lib': 'workspace:*',
          ...(suppliedStore === undefined ? {} : { zod: '3.25.76' }),
        },
        scripts: {
          postinstall: 'node postinstall-fixture.cjs',
        },
      }),
    );
    await writeFile(
      join(workspaceRoot, 'postinstall-fixture.cjs'),
      "require('node:fs').writeFileSync('UNSAFE_POSTINSTALL','bad');\n",
    );
    await writeFile(
      join(workspaceRoot, '.pnpmfile.cjs'),
      "require('node:fs').writeFileSync('UNSAFE_PNPMFILE','bad'); module.exports={hooks:{}};\n",
    );
    await mkdir(join(workspaceRoot, 'packages', 'lib'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: 'private-lib', version: '1.0.0' }),
    );
    await writeFile(join(workspaceRoot, 'packages', 'lib', 'value.txt'), 'original');
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      join(workspaceRoot, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      private-lib:\n        specifier: workspace:*\n        version: link:packages/lib\n" +
        (suppliedStore === undefined
          ? ''
          : '      zod:\n        specifier: 3.25.76\n        version: 3.25.76\n') +
        '  packages/lib: {}\n' +
        (suppliedStore === undefined
          ? ''
          : 'packages:\n  zod@3.25.76:\n    resolution: {integrity: sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==}\nsnapshots:\n  zod@3.25.76: {}\n'),
    );
    const receipt = await createWorkspacePreparer(wrapped)({
      workspaceRoot,
      policy: { enabled: true, path: process.env.PATH, cacheSeed: seed },
      deadlineAt: Date.now() + 120000,
      signal: new AbortController().signal,
    });
    if (receipt.status !== 'ready') throw new Error(JSON.stringify(receipt));
    try {
      await stat(join(workspaceRoot, 'UNSAFE_POSTINSTALL'));
      throw new Error('lifecycle script ran');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await stat(join(workspaceRoot, 'UNSAFE_PNPMFILE'));
      throw new Error('project pnpmfile hook ran');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await writeFile(join(workspaceRoot, 'own.txt'), name);
    await writeFile(join(workspaceRoot, 'node_modules', 'private-lib', 'value.txt'), name);
    receipts.push(receipt);
  }
  if (
    (await readFile(join(root, 'a', 'own.txt'), 'utf8')) !== 'a' ||
    (await readFile(join(root, 'b', 'own.txt'), 'utf8')) !== 'b'
  )
    throw new Error('cross-copy write');
  if (
    (await readFile(join(root, 'a', 'node_modules', 'private-lib', 'value.txt'), 'utf8')) !== 'a' ||
    (await readFile(join(root, 'b', 'node_modules', 'private-lib', 'value.txt'), 'utf8')) !== 'b'
  )
    throw new Error('dependency writes crossed private workspaces');
  if (suppliedStore !== undefined) {
    const a = await stat(join(root, 'a', 'node_modules', 'zod', 'package.json'));
    const b = await stat(join(root, 'b', 'node_modules', 'zod', 'package.json'));
    if (a.nlink !== 1 || b.nlink !== 1 || (a.ino === b.ino && a.dev === b.dev))
      throw new Error('registry package bytes are mutable shared links');
  }
  const cancelRoot = join(root, 'cancel');
  await mkdir(cancelRoot);
  const cancelEnv = await backend.createEnvironment({
    workspaceRoot: cancelRoot,
    attemptRoot: join(root, 'cancel-state'),
    runtimeBinds: [dirname(process.execPath)],
    inaccessiblePaths: [],
  });
  const controller = new AbortController();
  let watcher;
  let watchdog;
  const ready = new Promise((resolve, reject) => {
    watcher = watch(cancelRoot, (kind, file) => {
      if (String(file) === 'ready') resolve();
    });
    watchdog = setTimeout(
      () => reject(new Error('sandbox cancellation fixture never became ready')),
      15000,
    );
  });
  const execution = cancelEnv
    .run({
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('ready','1');setInterval(()=>{},1000)"],
      cwd: cancelRoot,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 20000,
      signal: controller.signal,
    })
    .then(
      () => false,
      (error) => error.name === 'AbortError',
    );
  try {
    await ready;
    controller.abort();
    if (!(await execution)) throw new Error('sandbox cancellation did not stop owned execution');
  } finally {
    clearTimeout(watchdog);
    watcher.close();
    controller.abort();
    await execution;
    await cancelEnv.dispose();
  }
  console.log(
    JSON.stringify({
      receipts,
      isolationChecks,
      lifecycleScriptsBlocked: true,
      privateCopies: true,
      cancellationStopped: true,
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
