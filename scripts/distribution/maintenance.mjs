// Conservative refusal, no signalling or killing. Includes source launches
// without launcher markers and independent runtime processes.
import { readdir, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
for (const pid of await readdir('/proc')) {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
  let args;
  try {
    args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  } catch {
    continue;
  }
  let cwd;
  try {
    cwd = await readlink(`/proc/${pid}/cwd`);
  } catch {
    cwd = '/';
  }
  if (
    args.some(
      (arg) =>
        arg.endsWith('host.js') && /\/apps\/runtime\/dist\/host\.js$/.test(resolve(cwd, arg)),
    )
  ) {
    throw new Error(
      'A Sentry runtime is still running. Cancel QA, stop its owning Desktop/runtime, then retry setup. No processes were killed.',
    );
  }
}
