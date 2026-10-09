import { test } from "node:test";
import assert from "node:assert/strict";

import { RingBuffer } from "../../src/voice/audio/ring_buffer";
import { silenceFrame } from "../../src/voice/contracts";

test("ring buffer keeps a bounded time window and drains cleanly", () => {
  const rb = new RingBuffer({ maxMs: 200, maxBytes: 1024 * 1024 });
  // 30 frames x 20 ms = 600 ms; only the newest ~200 ms may be retained.
  for (let i = 0; i < 30; i++) rb.push(silenceFrame(i, i * 20));
  assert.ok(rb.length <= 11, `time window must stay bounded (got ${rb.length} frames)`);
  const drained = rb.drain();
  assert.ok(drained.length >= 1);
  assert.equal(rb.length, 0, "drain() must clear the buffer (privacy: ownership transferred)");
  assert.equal(rb.oldestTimestampMs, undefined);
  // After drain the buffer accepts new frames (no stale audio repeats).
  rb.push(silenceFrame(99, 999));
  assert.equal(rb.length, 1);
  rb.clear();
  assert.equal(rb.length, 0);
});

test("ring buffer enforces the byte bound as well as the time bound", () => {
  const rb = new RingBuffer({ maxMs: 10_000, maxBytes: 640 * 5 });
  for (let i = 0; i < 20; i++) rb.push(silenceFrame(i, i * 20)); // 640 bytes each
  let totalBytes = 0;
  for (const frame of rb.drain()) totalBytes += frame.data.byteLength;
  assert.ok(totalBytes <= 640 * 5, `byte bound must hold (got ${totalBytes} bytes)`);
});

test("ring buffer evicts oldest frames first (FIFO pre-roll semantics)", () => {
  const rb = new RingBuffer({ maxMs: 60, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 10; i++) rb.push(silenceFrame(i, i * 20));
  const drained = rb.drain();
  const sequences = drained.map((f) => f.sequence);
  // 60 ms window at 20 ms frames retains at most the last 4 pushes (3,4,5
  // span 40 ms; adding 2 would span 60 ms which is <= maxMs, so 2..5 may
  // remain). Strictly: the retained set must be a suffix of the pushes.
  assert.ok(sequences.length >= 1 && sequences.length <= 5);
  assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b), "FIFO order must be preserved");
  for (let i = 1; i < sequences.length; i++) {
    assert.equal((sequences[i] as number) - (sequences[i - 1] as number), 1, "contiguous suffix retained");
  }
});
