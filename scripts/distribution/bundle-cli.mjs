import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function bundleCli(repo, output, version) {
  await mkdir(join(output, 'cli'), { recursive: true });
  const result = await build({
    entryPoints: [join(repo, 'apps/cli/src/packaged-entry.ts')],
    outfile: join(output, 'cli/sentry-cli.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { SENTRY_PACKAGED_CLI_VERSION: JSON.stringify(version) },
    metafile: true,
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    if (
      /packages\/(persistence|project-manager|run-engine|harness-[^/]+)\//.test(
        path.replaceAll('\\', '/'),
      ) ||
      /apps\/cli\/src\/(application|doctors|errors)\.ts$/.test(path.replaceAll('\\', '/'))
    )
      throw new Error('Packaged CLI imports development execution: ' + path);
  }
  for (const file of Object.values(result.metafile.outputs))
    for (const item of file.imports)
      if (item.external && !item.path.startsWith('node:'))
        throw new Error('Unbundled CLI dependency: ' + item.path);
  return result.metafile;
}
