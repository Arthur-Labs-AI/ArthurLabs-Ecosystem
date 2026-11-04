import { spawnSync } from 'node:child_process';

const forbiddenTrackedPaths = ['.superharness/.dashboard_auth_token'];

const result = spawnSync('git', ['ls-files', '--cached', '--', ...forbiddenTrackedPaths], {
  encoding: 'utf8',
});

if (result.error) {
  console.error('Repository hygiene check could not invoke Git.');
  process.exit(1);
}

if (result.status !== 0) {
  console.error('Repository hygiene check could not inspect tracked files.');
  process.exit(1);
}

const trackedPaths = result.stdout
  .split(/\r?\n/u)
  .map((path) => path.trim())
  .filter(Boolean);

if (trackedPaths.length > 0) {
  console.error(`Repository hygiene check failed: forbidden local credential path is tracked.`);
  for (const trackedPath of trackedPaths) {
    console.error(`- ${trackedPath}`);
  }
  process.exit(1);
}

console.log('Repository hygiene check passed.');
