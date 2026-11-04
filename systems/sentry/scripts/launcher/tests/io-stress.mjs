// io-stress.mjs — high-output child for the Invoke-SentryNative deadlock test.
// Writes several megabytes to BOTH stdout and stderr with synchronous pipe
// writes (well past OS pipe buffers): a parent that drains only after exit
// would deadlock here, because the child blocks until the parent reads.
// Usage: node io-stress.mjs            -> flood both streams, exit 0
//        node io-stress.mjs hang       -> print markers, then sleep 60s
import fs from 'node:fs';
const chunkOut = 'O'.repeat(65536);
const chunkErr = 'E'.repeat(65536);
const rounds = 48;
if (process.argv[2] === 'hang') {
  fs.writeSync(1, 'HANG-MARKER-OUT\n');
  fs.writeSync(2, 'HANG-MARKER-ERR\n');
  setTimeout(() => process.exit(0), 60000);
} else {
  for (let i = 0; i < rounds; i++) {
    fs.writeSync(1, chunkOut);
    fs.writeSync(2, chunkErr);
  }
  fs.writeSync(1, 'FLOOD-DONE-OUT\n');
  fs.writeSync(2, 'FLOOD-DONE-ERR\n');
  process.exit(0);
}
