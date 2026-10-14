// Real fish execution; checksum/archive/npm/launcher are fixture boundaries.
// No package install, graphical app, provider request or owner profile is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const fish = process.env.SENTRY_TEST_FISH_BINARY || 'fish';
const available = process.platform === 'linux' && spawnSync(fish, ['--version']).status === 0;
const skip = available ? false : 'Actual Linux fish interpreter unavailable';
const helper = fileURLToPath(new URL('./cachyos-rc1-smoke.fish', import.meta.url));
const archiveName = 'sentry-1.0.0-rc.1-8a75e9924a41-cachyos-x64.tar.gz';
const folderName = archiveName.replace('.tar.gz', '');

async function fixture(t, failSetup = false) {
  const root = await mkdtemp(join(tmpdir(), 'sentry fish operator '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'original home'),
    bin = join(root, 'bin'),
    trace = join(root, 'trace');
  await mkdir(join(home, 'Downloads'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, 'Downloads', archiveName), 'synthetic archive boundary');
  await writeFile(trace, '');
  // A minimal PATH with real utilities but no ambient pnpm.
  for (const tool of ['env', 'mkdir', 'mktemp', 'cp', 'chmod'])
    await symlink('/usr/bin/' + tool, join(bin, tool));
  const executable = (path, content) =>
    writeFile(path, '#!/bin/sh\nset -eu\n' + content, { mode: 0o755 });
  await executable(join(bin, 'sha256sum'), 'printf "fixture checksum: OK\\n"\n');
  const launcher = join(root, 'launcher');
  await executable(
    launcher,
    `
printf '%s\\n' "$1" >> "$SENTRY_SMOKE_FIXTURE_TRACE"
case "$1" in
setup)
  command -v pnpm >/dev/null || { echo 'missing pnpm'; exit 1; }
  [ "$(pnpm --version)" = 9.12.3 ] || exit 1
  [ "$SENTRY_SMOKE_FIXTURE_FAIL_SETUP" != 1 ] || exit 42
  mkdir -p "$HOME/.local/share/sentry/runtime/current/apps/runtime/dist"
  printf fixture > "$SENTRY_RUNTIME_ENTRY"
  ;;
esac
`,
  );
  await executable(
    join(bin, 'tar'),
    `
mkdir -p "$4/${folderName}"
cp "$SENTRY_SMOKE_FIXTURE_LAUNCHER" "$4/${folderName}/sentry"
`,
  );
  await executable(
    join(bin, 'npm'),
    `
printf 'npm-install\\n' >> "$SENTRY_SMOKE_FIXTURE_TRACE"
prefix=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then shift; prefix="$1"; fi
  shift
done
[ -n "$prefix" ]
case "$prefix" in "$HOME"/*) ;; *) exit 71 ;; esac
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/sh\\nprintf "9.12.3\\\\n"\\n' > "$prefix/node_modules/.bin/pnpm"
chmod +x "$prefix/node_modules/.bin/pnpm"
`,
  );
  return {
    root,
    home,
    trace,
    env: {
      ...process.env,
      HOME: home,
      PATH: bin,
      SENTRY_SMOKE_FIXTURE_TRACE: trace,
      SENTRY_SMOKE_FIXTURE_LAUNCHER: launcher,
      SENTRY_SMOKE_FIXTURE_FAIL_SETUP: failSetup ? '1' : '0',
      SENTRY_SMOKE_HELPER: helper,
    },
  };
}

test(
  'fish helper provisions pinned pnpm inside test home before setup and launch',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const result = spawnSync(fish, ['--no-config', '-c', 'source "$SENTRY_SMOKE_HELPER"'], {
      env: f.env,
      encoding: 'utf8',
      timeout: 30000,
    });
    const calls = (await readFile(f.trace, 'utf8')).trim().split('\n');
    assert.ok(calls.includes('npm-install'), 'Missing pnpm must be provisioned');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(calls.indexOf('npm-install') < calls.indexOf('setup'));
    assert.ok(calls.includes('open'));
  },
);

test(
  'fish helper refuses subsequent open when setup left no runtime entry',
  { skip },
  async (t) => {
    const f = await fixture(t, true);
    const result = spawnSync(
      fish,
      ['--no-config', '-c', 'source "$SENTRY_SMOKE_HELPER"; sentry_rc1 open'],
      {
        env: f.env,
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    const calls = (await readFile(f.trace, 'utf8')).trim().split('\n');
    assert.equal(calls.includes('open'), false, 'Do not launch Desktop after incomplete setup');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /setup/i);
  },
);
