// Native build only. No publishing, tagging or access credentials.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inventory, parseIdentity, sha256, validate } from './contract.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2];
if (!['windows-x64', 'cachyos-x64'].includes(target))
  throw new Error('Usage: node scripts/distribution/build.mjs windows-x64|cachyos-x64');
if (process.arch !== 'x64' || process.platform !== (target === 'windows-x64' ? 'win32' : 'linux'))
  throw new Error('Native x64 build host required');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=all'))
  throw new Error('Artifacts require a clean committed build input');
if (!process.env['npm_execpath']) throw new Error('Invoke through pnpm distribution:build');
// Compile the committed input, rather than trusting arbitrary ignored dist files.
execFileSync(
  process.execPath,
  [process.env['npm_execpath'], 'exec', 'turbo', 'run', 'build', '--force'],
  { cwd: repo, stdio: 'inherit' },
);
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(await readFile(join(repo, 'apps/desktop/package.json'), 'utf8'));
const identity = parseIdentity({
  schemaVersion: 1,
  product: 'Sentry',
  version: pkg.version,
  sourceCommit: git('rev-parse', 'HEAD'),
  runtimeProtocol: 1,
});
if (desktopPkg.version !== pkg.version) throw new Error('Desktop version mismatch');
const name = `sentry-${pkg.version}-${identity.sourceCommit.slice(0, 12)}-${target}`;
const output = join(repo, 'dist/distributions', name);
// Refuse overwrite: reruns use a new external output directory or remove only
// the reviewed generated directory. Never recurse over caller-provided paths.
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const app = join(output, '.app-stage');
await mkdir(join(app, 'dist/main'), { recursive: true });
const meta = await build({
  entryPoints: [join(repo, 'apps/desktop/dist/main/index.js')],
  outfile: join(app, 'dist/main/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  metafile: true,
  minify: false,
});
for (const file of Object.values(meta.metafile.outputs))
  for (const item of file.imports) {
    if (item.external && item.path !== 'electron' && !item.path.startsWith('node:'))
      throw new Error('Unbundled main dependency: ' + item.path);
  }
for (const path of ['dist/preload', 'dist/renderer', 'assets'])
  await cp(join(repo, 'apps/desktop', path), join(app, path), {
    recursive: true,
    filter: (p) => !p.endsWith('.map') && !p.endsWith('.icns'),
  });
await writeFile(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'sentry',
      productName: 'Sentry',
      version: pkg.version,
      type: 'module',
      main: 'dist/main/index.js',
      description: 'Sentry independent agent QA Desktop',
      author: 'Sentry project contributors',
    },
    null,
    2,
  ) + '\n',
);
await writeFile(join(app, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
// electron-builder runs with a separate dependency-free application directory.
const desktopRequire = createRequire(join(repo, 'apps/desktop/package.json'));
const builder = desktopRequire('electron-builder');
await builder.build({
  targets: (target === 'windows-x64'
    ? builder.Platform.WINDOWS
    : builder.Platform.LINUX
  ).createTarget('dir', builder.Arch.x64),
  projectDir: join(repo, 'apps/desktop'),
  config: {
    appId: 'io.sentry.qa.desktop',
    productName: 'Sentry',
    electronVersion: desktopPkg.devDependencies.electron,
    directories: {
      app,
      output: join(output, '.electron-stage'),
      buildResources: join(repo, 'apps/desktop/assets'),
    },
    files: ['dist/**/*', 'assets/**/*', 'build-identity.json', 'package.json'],
    asar: false,
    npmRebuild: false,
    win: {
      target: 'dir',
      icon: join(repo, 'apps/desktop/assets/sentry-icon.ico'),
      signAndEditExecutable: false,
    },
    linux: {
      target: 'dir',
      executableName: 'sentry',
      icon: join(repo, 'apps/desktop/assets/sentry-icon.png'),
    },
  },
  publish: 'never',
});
const unpacked = join(
  output,
  '.electron-stage',
  target === 'windows-x64' ? 'win-unpacked' : 'linux-unpacked',
);
await cp(unpacked, join(output, 'desktop'), { recursive: true });
// Payload is selected from tracked build input, never by recursive checkout copy.
const paths = git('ls-files', '-z').split('\0').filter(Boolean);
const roots = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.nvmrc',
  'tsconfig.base.json',
  'turbo.json',
  'eslint.config.js',
  'prettier.config.js',
]);
for (const path of paths) {
  const runtimeSource =
    roots.has(path) ||
    /^(apps\/runtime|packages\/[^/]+)\/(src\/.*|package.json|tsconfig[^/]*\.json)$/.test(path);
  const launcher =
    /^scripts\/launcher\/(linux\/.*|[^/]+\.(ps1|psm1|mjs))$/.test(path) &&
    !path.includes('/tests/');
  const distribution =
    /^scripts\/distribution\/[^/]+\.(mjs|sh|ps1)$/.test(path) &&
    !path.endsWith('build.mjs') &&
    !path.endsWith('smoke.mjs');
  if (
    !runtimeSource &&
    !launcher &&
    !distribution &&
    path !== 'apps/runtime/scripts/deploy-inner.sh'
  )
    continue;
  const dest = join(output, runtimeSource ? 'runtime-source' : '', path);
  if (!(await stat(join(repo, path))).isFile()) throw new Error('Non-file source input');
  await mkdir(dirname(dest), { recursive: true });
  await cp(join(repo, path), dest);
}
await writeFile(join(output, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
await writeFile(
  join(output, 'runtime-source/build-identity.json'),
  JSON.stringify(identity, null, 2) + '\n',
);
await cp(
  join(repo, 'scripts/distribution', target === 'windows-x64' ? 'release.ps1' : 'release.sh'),
  join(output, target === 'windows-x64' ? 'sentry.ps1' : 'sentry'),
);
if (target !== 'windows-x64') await chmod(join(output, 'sentry'), 0o755);
await cp(join(repo, 'LICENSE'), join(output, 'LICENSE'));
await cp(join(repo, 'docs/setup/distribution.md'), join(output, 'INSTALL.md'));
// Generated staging is outside the artifact root before inventory/extraction.
const { rm } = await import('node:fs/promises');
await rm(app, { recursive: true });
await rm(join(output, '.electron-stage'), { recursive: true });
const manifest = {
  ...identity,
  buildPlatform: process.platform + '-' + process.arch,
  targetPlatform: target,
  artifactType: 'versioned-archive',
  toolchain: {
    node: process.version,
    pnpm: pkg.packageManager,
    electron: desktopPkg.devDependencies.electron,
    electronBuilder: desktopPkg.devDependencies['electron-builder'],
    esbuild: '0.21.5',
  },
  components: [
    'Electron Desktop',
    'Linux runtime source bootstrap',
    'platform launcher',
    'application assets',
  ],
  prerequisites: [
    'Linux Node >=22',
    'Linux pnpm 9.12.3',
    'internet for frozen dependencies and provider tooling',
    'systemd user services',
    'bubblewrap',
    'socat',
    ...(target === 'windows-x64'
      ? ['Windows 11 x64', 'WSL2 (Ubuntu preferred)']
      : ['native CachyOS x64', 'graphical session', 'pacman']),
  ],
  checksumAlgorithm: 'SHA256',
  files: await inventory(output),
};
await writeFile(join(output, 'distribution.json'), JSON.stringify(manifest, null, 2) + '\n');
await validate(output);
const archive = output + (target === 'windows-x64' ? '.zip' : '.tar.gz');
if (target === 'windows-x64') {
  execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(output), name], {
    stdio: 'inherit',
  });
} else execFileSync('tar', ['-czf', archive, '-C', dirname(output), name], { stdio: 'inherit' });
await writeFile(
  archive + '.sha256',
  sha256(await readFile(archive)) + '  ' + archive.split(/[\\/]/).pop() + '\n',
);
const extracted = join(repo, 'dist/distributions', name + '-extracted');
await mkdir(extracted);
execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', extracted], {
  stdio: 'inherit',
});
await validate(join(extracted, name));
console.log(
  JSON.stringify({
    archive,
    sourceCommit: identity.sourceCommit,
    checksum: sha256(await readFile(archive)),
    extractionVerified: true,
  }),
);
