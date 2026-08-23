import { test } from "node:test";
import assert from "node:assert/strict";

import { SpeakableChunker } from "../../src/voice/speech/chunker";
import { SpeechFormatter } from "../../src/voice/speech/formatter";

test("chunker splits at sentence boundaries and keeps chunks bounded", () => {
  const chunker = new SpeakableChunker();
  const chunks = chunker.push("First sentence. Second sentence! Is this a question? Yes");
  // The first boundary is only 15 chars (< minChunkChars): everything is
  // held until a flush, so short sentences are never cut into fragments.
  assert.equal(chunks.length, 0);
  const rest = chunker.push(", it is.");
  assert.equal(rest.length, 0, "held until flush");
  const flushed = chunker.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.text, "First sentence. Second sentence! Is this a question? Yes, it is.");
  assert.equal(flushed[0]?.final, true);
});

test("chunker never emits chunks above the hard cap", () => {
  const chunker = new SpeakableChunker();
  const long = "word ".repeat(500);
  const chunks = chunker.push(long);
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 400, `chunk too long: ${chunk.text.length}`);
    assert.ok(chunk.text.length >= 1);
  }
});

test("chunker resets state without leaking across turns", () => {
  const chunker = new SpeakableChunker();
  chunker.push("unfinished");
  chunker.reset();
  const chunks = chunker.flush();
  assert.deepEqual(chunks, []);
});

test("formatter strips code fences, inline code, URLs, and citations", () => {
  const formatter = new SpeechFormatter();
  const out = formatter.format(
    "See https://example.com/x for details [1].\n\n```ts\nconst x = 1;\n```\nInline `code` stays readable.",
  );
  assert.ok(!out.includes("https://"));
  assert.ok(!out.includes("```"));
  assert.ok(!out.includes("[1]"));
  assert.ok(out.includes("Inline code"));
});

test("formatter truncates at a sentence boundary near the cap", () => {
  const formatter = new SpeechFormatter();
  const long = ("This is a normal sentence. ").repeat(200);
  const out = formatter.format(long);
  assert.ok(out.length <= 4000 + 50);
  assert.ok(out.endsWith(".") || out.endsWith("…"));
});

test("formatter keeps plain prose intact and collapses whitespace", () => {
  const formatter = new SpeechFormatter();
  const out = formatter.format("  Hello   there.   \n  \n Next.  ");
  assert.equal(out, "Hello there. Next.");
});