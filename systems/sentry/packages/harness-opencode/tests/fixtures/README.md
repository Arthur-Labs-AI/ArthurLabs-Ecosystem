# Real OpenCode wire fixtures

Captured from the real `opencode-ai@1.18.32` binary (`opencode run --format json`)
driven against a local stub OpenAI-compatible provider (zero provider spend).
Session/part/message IDs are verbatim wire values (single-use random IDs,
no sensitive content). Local filesystem paths were sanitized to
`C:\sentry-fixture`.

- `planning-output.jsonl`: real step/text/step-finish envelopes; the text
  payload was substituted with a valid Sentry plan JSON (envelope structure
  untouched). Regression: must yield the exact plan text.
- `text-only.jsonl`: minimal real assistant-text turn.
- `tool-read.jsonl`: real completed `read` tool envelope.
- `tool-error.jsonl`: real error-state `read` envelope (missing file).
- `task-subagent.jsonl`: real completed `task` (subagent) envelope — must be
  blocked by the adapter.
- `bash-exit.jsonl`: real completed `bash` envelope with
  `state.metadata.exit` (exact exit code source).
- `bash-denied.jsonl`: real error-state `bash` envelope for a rejected
  external read (`../` traversal blocked by upstream permissions).
- `invalid-tool.jsonl`: real envelope for an unknown tool call (mapped to
  tool `invalid`).
- `error-output.jsonl`: real top-level `error` envelope (provider
  connection failure).
- `reasoning.jsonl`: shape taken from the official OpenCode SDK part types
  and CLI emission code (`part.type === "reasoning"`); the CLI only emits
  it with `--thinking`, which Sentry never passes. Must always be dropped.
- `malformed-mixed.jsonl`: real envelopes interleaved with a garbage line
  and an unknown future envelope type (must be skipped, never evidence).
