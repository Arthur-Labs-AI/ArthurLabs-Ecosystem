'use strict';
// Deterministic whisper-cli stand-in for ARTHUR wrapper tests (TASK-0008).
// Records the engine argv it received (JSON array) when FIXTURE_ARGV_FILE is
// set, optionally writes FIXTURE_STDERR_LINE to stderr, then writes one
// segment line (FIXTURE_STDOUT_LINE or a default transcript) to stdout and
// exits with FIXTURE_EXIT_CODE (default 0) after FIXTURE_STALL_MS (default 0).
const fs = require('node:fs');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
if (process.env.FIXTURE_ARGV_FILE) {
  fs.writeFileSync(process.env.FIXTURE_ARGV_FILE, JSON.stringify(process.argv.slice(1)));
}
if (process.env.FIXTURE_STDERR_LINE) process.stderr.write(process.env.FIXTURE_STDERR_LINE);
const finish = () => {
  if (process.env.FIXTURE_STDOUT_LINE !== undefined) process.stdout.write(process.env.FIXTURE_STDOUT_LINE);
  else process.stdout.write('[00:00:00.000 --> 00:00:01.000]  hello world\n');
  process.exit(num('FIXTURE_EXIT_CODE', 0));
};
const stall = num('FIXTURE_STALL_MS', 0);
if (stall > 0) setTimeout(finish, stall); else finish();
