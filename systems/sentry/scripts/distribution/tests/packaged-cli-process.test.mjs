import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleCli } from '../bundle-cli.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const projectId = 'proj_01K7777777777777777777A8W1';
const runId = 'run_01K7777777777777777777A8W3';
const revisionId = 'rev_01K7777777777777777777A8W2';

function processResult(file, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => accept({ code, stdout, stderr }));
  });
}

test(
  'registered packaged CLI uses included runtime, canonical broker and complete UTF-8 JSON',
  { skip: process.platform !== 'win32', timeout: 120000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'sentry packaged process '));
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + '\\'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = join(temporary, 'archive ü with spaces'),
      bin = join(temporary, 'bin');
    await mkdir(join(root, 'scripts/distribution'), { recursive: true });
    await cp(join(repo, 'apps/desktop/node_modules/electron/dist'), join(root, 'desktop'), {
      recursive: true,
    });
    await cp(join(root, 'desktop/electron.exe'), join(root, 'desktop/Sentry.exe'));
    for (const p of ['release.ps1', 'cli.ps1'])
      await cp(
        join(repo, 'scripts/distribution', p),
        join(root, p === 'release.ps1' ? 'sentry.ps1' : 'scripts/distribution/' + p),
      );
    await writeFile(
      join(root, 'scripts/distribution/verify.ps1'),
      'function Get-SentryDistribution { param($Root) return @{} }',
    );
    const meta = await bundleCli(repo, root, '1.0.1');
    assert.ok(
      Object.keys(meta.inputs).every(
        (p) => !p.includes('/persistence/') && !p.includes('/harness-'),
      ),
    );
    const registration = join(temporary, 'registration.ps1');
    await writeFile(
      registration,
      `\uFEFF. ${quote(join(repo, 'scripts/distribution/register-command.ps1'))}
Register-SentryDistributionCommand -Root ${quote(root)} -BinDirectory ${quote(bin)} -ReadUserPath { '' } -WriteUserPath { param($Value) }
`,
    );
    const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    let reply = await processResult(ps, ['-NoProfile', '-File', registration]);
    assert.equal(reply.code, 0, reply.stderr);
    const pipe = '\\\\.\\pipe\\sentry-packaged-' + process.pid + '-' + Date.now();
    const seen = [],
      sockets = new Set();
    const status = {
      runId,
      projectId,
      mode: 'full',
      status: 'completed',
      createdAt: '2026-10-15T00:00:00.000Z',
      completedAt: '2026-10-15T00:01:00.000Z',
      agents: {
        configured: 3,
        queued: 0,
        starting: 0,
        planning: 0,
        running: 0,
        completed: 3,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        interrupted: 0,
      },
      findings: { total: 0 },
    };
    const canonical = { runId, description: 'ü ' + 'large output '.repeat(110000) };
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const frame = JSON.parse(raw);
          if (frame.type === 'hello') {
            socket.write(
              JSON.stringify({
                type: 'welcome',
                protocolVersion: 1,
                product: { name: 'Sentry', version: '1.0.1' },
              }) + '\n',
            );
            continue;
          }
          seen.push(frame);
          let result, error;
          if (frame.command === 'projects:add' || frame.command === 'projects:update')
            result = { project: { id: projectId }, revision: { id: revisionId } };
          else if (frame.command === 'projects:list') result = [];
          else if (frame.command === 'projects:delete') result = { projectId, deleted: true };
          else if (frame.command === 'runs:start')
            result = { runId, operationId: 'dop_fixture', status: 'agents_running' };
          else if (frame.command === 'runs:status') result = status;
          else if (frame.command === 'runs:cancel')
            result = { runId, status: 'already_terminal', cancelledAgents: 0 };
          else if (frame.command === 'runs:export-content')
            result = {
              contentBase64: Buffer.from(
                frame.payload.format === 'json' ? JSON.stringify(canonical) : 'fixture log ü',
                'utf8',
              ).toString('base64'),
            };
          else if (frame.command === 'doctors:environment') result = { agentStacks: [] };
          else error = { code: 'RUN_NOT_FOUND', message: 'fixture not found' };
          socket.write(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: !error,
              ...(error ? { error } : { result }),
            }) + '\n',
          );
        }
      });
    });
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(pipe, ok);
    });
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((ok) => server.close(ok));
    });
    const env = {
      ...process.env,
      PATH: join(process.env.SystemRoot, 'System32'),
      SENTRY_CLI_PIPE_PATH: pipe,
      SENTRY_CLI_TRANSPORT: 'direct',
      SENTRY_DATA_ROOT: join(temporary, 'must-not-create'),
    };
    const invoke = async (args) =>
      processResult(ps, ['-NoProfile', '-File', join(bin, 'sentry-launch.ps1'), 'cli', ...args], {
        env,
        cwd: join(process.env.SystemRoot, 'System32'),
      });
    const machine = async (args, exit = 0) => {
      const r = await invoke([...args, '--json']);
      assert.equal(r.code, exit, r.stderr + r.stdout);
      return JSON.parse(r.stdout);
    };
    assert.equal((await machine(['capabilities'])).data.productVersion, '1.0.1');
    assert.deepEqual((await machine(['project', 'list'])).data.projects, []);
    const path = 'C:\\Projects\\Sample ü & folder\\';
    assert.equal((await machine(['project', 'add', path])).data.projectId, projectId);
    assert.equal(seen.at(-1).payload.sourcePath, path);
    await machine(['project', 'update', projectId, path]);
    const instructions = 'quoted "value" with trailing slash \\';
    await machine([
      'run',
      'start',
      projectId,
      '--mode',
      'full',
      '--agents',
      'opencode,deepseek,glm',
      '--instructions',
      instructions,
    ]);
    assert.equal(seen.at(-1).payload.instructions, instructions);
    await machine([
      'run',
      'start',
      projectId,
      '--mode',
      'targeted',
      '--agents',
      'deepseek',
      '--paths',
      'src/auth,src/api',
    ]);
    assert.deepEqual(seen.at(-1).payload.includePaths, ['src/auth', 'src/api']);
    await machine(['run', 'status', runId]);
    assert.deepEqual((await machine(['run', 'result', runId])).data.result, canonical);
    for (const format of ['json', 'log']) {
      const out = join(temporary, 'export ü ' + format);
      await machine(['run', 'export', runId, '--format', format, '--out', out]);
      assert.equal(
        await readFile(out, 'utf8'),
        format === 'json' ? JSON.stringify(canonical) : 'fixture log ü',
      );
    }
    await machine(['run', 'cancel', runId]);
    await machine(['project', 'delete', projectId, '--yes']);
    assert.equal(
      (await machine(['project', 'delete', projectId], 2)).error.code,
      'INVALID_ARGUMENT',
    );
    assert.equal((await machine(['run', 'show', runId], 3)).error.code, 'RUN_NOT_FOUND');
    assert.equal((await machine(['agent', 'list'])).ok, true);
    const cmd = await processResult(
      join(process.env.SystemRoot, 'System32/cmd.exe'),
      ['/d', '/s', '/c', 'sentry cli capabilities --json'],
      {
        env: { ...env, PATH: bin + ';' + env.PATH },
        cwd: join(process.env.SystemRoot, 'System32'),
        windowsVerbatimArguments: true,
      },
    );
    assert.equal(cmd.code, 0, cmd.stderr);
    assert.equal(JSON.parse(cmd.stdout).ok, true);
    const help = await invoke(['--help']);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.stdout, /Nexus|run simulate/);
    assert.match(help.stdout, /run export/);
    const missing = await processResult(
      ps,
      ['-NoProfile', '-File', join(bin, 'sentry-launch.ps1'), 'cli', 'capabilities', '--json'],
      { env: { ...env, SENTRY_CLI_PIPE_PATH: pipe + '-missing' } },
    );
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stdout).error.code, 'SENTRY_DESKTOP_NOT_RUNNING');
    await assert.rejects(lstat(join(temporary, 'must-not-create')), {
      code: 'ENOENT',
    });
  },
);
