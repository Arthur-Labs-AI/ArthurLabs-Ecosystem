// Conservative refusal, no signalling or killing. Includes source launches
// without launcher markers and independent runtime processes.
import { readdir, readFile } from 'node:fs/promises';
for (const pid of await readdir('/proc')) {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
  let args;
  try {
    args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  } catch {
    continue;
  }
  if (args.some((arg) => /\/apps\/runtime\/dist\/host\.js$/.test(arg))) {
    throw new Error(
      'A Sentry runtime is still running. Cancel QA, stop its owning Desktop/runtime, then retry setup. No processes were killed.',
    );
  }
}
