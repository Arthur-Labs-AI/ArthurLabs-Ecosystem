# Marginalia Mobile: implementation follow-ups

> **Status: all five items below were implemented in M03.1B-2.** See `hardening-notes.md` for what was built, how it was
> verified on a device, and what is still open. The table is kept as the record of why each was needed.

Recorded separately from the design decisions (`DECISIONS.md`). None of these is implemented. None is required for the design to be correct; each is required for the production mobile build to behave as designed. `apps/arthur` and the native layer are unchanged.

| # | Follow-up | Why the mobile design needs it | Touches |
|---|---|---|---|
| 1 | **Expose durable organization state** so the client can tell *never organized* from *organized, and it validly produced zero objects*. | Home shows "Organize now" for the first and "Nothing to organize in this one." for the second. Today both are "a capture with no objects"; the difference lives in `distillation_runs`, which `ArthurClient` doesn't surface. | contracts (`Capture` field or a status query), native store, `ArthurClient` |
| 2 | **Consider persistent / recoverable organization-failure state.** | A failed organize is UI memory only; after a restart it looks like "never organized" (follow-up 1 partly covers it). Decide whether to record the failure (and its code) durably. | native store, `ArthurClient`, auto-organize subscriber |
| 3 | **Batch relation and revision summary counts.** | Ideas rows, Home kids and detail each need link and revision counts per object; the client has only per-object calls, i.e. N+1. Mobile makes it worse. Suggested shape: one `listObjectSummaries()` returning `{objectId, linkCount, revisionCount, currentRevisionAt}`. | contracts, native store, `ArthurClient`, `use-knowledge` |
| 4 | **Android permission recovery / Open Settings (later).** | After "Don't allow", the design can only say where to go. A `microphonePermission()` query and an `openAppSettings()` action would turn that into a button. Not blocking: the text-only recovery ships first. | `ArthurClient` capabilities, Android bridge |
| 5 | **Temporary-audio STT retry semantics (production mobile phase).** | Implements `DECISIONS.md` 8–10: retain the app-private audio only for the active retry flow; delete on success, discard, leaving the flow, terminal failure, TTL (10–15 min) and startup cleanup. Today `voice_capture.rs` deletes the audio on every outcome (RecordingGuard). Needs: a retryable-vs-terminal classification of `SttError`, a `retryTranscription()` call, a `discardRecording()` call, a TTL, a startup purge (already exists for stale files), and tests for each deletion trigger. | `voice_capture.rs`, `stt`, `ArthurClient`, contracts error codes |

## Smaller notes carried over from the exploration

- Recording length: `MAX_RECORDING_BYTES` (24MB) fails at *stop*. A duration cap with a warning is needed alongside follow-up 5, or the retry flow can't help a recording that was too long.
- No recording telemetry (elapsed time, interruption event) in the client; the clock is the UI's own timer.
- No cancel during transcription.
- Desktop has an "Add a connection" form (`createRelation`); mobile v1 has none (not designed). Remove/confirm relation and "make an existing revision current" are not in the client.
- The demo dataset has no zero-connection objects (minimum 1). Add a few to `tools/demo-data/seed_demo_db.py` if the empty states should be visible against real data.
- The map layout must cache positions per object id in production so it is the same map after a restart.
