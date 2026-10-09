# Mobile runtime hardening (M03.1B-2)

Runtime correctness, durability, Android recovery and performance for the approved mobile UI. No visual change: every
state below is one the design already had; this milestone made the runtime able to honour it.

## 1. Android root Back abort

**Symptom.** Back at the root of the app killed the process with `FORTIFY: pthread_mutex_lock called on a destroyed mutex`.

**Investigation (emulator, API 37).**

* The abort is on the Rust event-loop thread, after the Activity window is destroyed. The exit status is 0, not a normal
  crash dump: WebView's crash handler turns the abort into a clean-looking exit, which is why there is no tombstone.
* A diagnostic build logged the sequence: `RunEvent::Exit` fired, **78 ms later the libc `atexit` handlers started, 250 ms
  after that the abort**, always on that thread, with **64 to 66 threads still alive** (Chromium's `Chrome_IOThread`,
  `NetworkService`, `ThreadPool*`, `CrAsyncTask*`, plus four `tokio-rt-worker`). It reproduced in 1 of 5 runs in that build,
  and almost every time in the earlier ones.
* The caller: `tao-0.37.1/src/platform_impl/android/mod.rs:204-205`. `run()` calls `run_return()` and then
  `std::process::exit(exit_code)`. That is libc `exit()`: it runs every `atexit` handler and C++ static destructor in the
  process, including those of the in-process Chromium WebView, while those threads are still running.
* How Back gets there: `WryActivity` handles Back by `finish()`, so `onDestroy` → `Rust.onDestroy` → `Destroyed` event →
  the loop ends → `process::exit`.

**What it is not.** Not Arthur's Rust state (no Arthur mutex is involved; our managed state is never dropped on that path),
not the audio plugin (`onDestroy` only discards a recording), not a Back callback registration problem (the callback is
unregistered cleanly before the abort).

**What I could not establish.** *Which* static destructor destroys the mutex that the next one locks. There is no native
backtrace (see above) and no root on this image. The evidence says the hazard is `exit()` with a live WebView; the specific
object is in a library we do not own.

**Fix, two parts.**

1. `MainActivity.onBackPressed()` → `moveTaskToBack(true)` for **Back at the root** (the web view has no history left, so the
   UI has no page, sheet or typing mode to close). That is Android's own convention for a root screen: the task goes to the
   background, the process and web view stay alive, and returning finds the same screen and state. Back with an open layer is
   still handled by the UI (the history stack from M03.1B-1), not swallowed.
2. `src/lifecycle.rs`: on `RunEvent::Exit` (Android only) the process ends with `libc::_exit(0)`, so the destructors that
   abort never run. This covers every other way the Activity can end (the system, recents). Nothing Arthur owns needs those
   destructors: SQLite commits are durable when they return, and leftover temporary audio is purged at the next launch.

**Verified on the emulator.** 12 background/restore cycles (same pid, same screen and data afterwards); 8 forced Activity
destructions (`am stack remove`), 0 aborts; the final acceptance run's full logcat has no `FORTIFY` and no Arthur crash.
`tests/architecture/foundation_shell.test.ts` pins both parts (the `onBackPressed` override, no `finish()`, the `_exit`).

Trade-off: `_exit` skips Rust destructors and `atexit` handlers on exit. That is intended and documented in the module.

## 2. Temporary-audio STT retry

Raw audio is temporary and is never Arthur knowledge. Lifecycle (`src-tauri/src/audio/voice_capture.rs`):

```
record → app-private cache file → speech-to-text
  success            → persist the transcript Capture → delete the audio
  retryable failure  → keep the audio → "Retry transcription" / "Discard recording"
  retry succeeds     → persist the Capture → delete the audio
  retry fails again  → keep it (same file, same deadline) or, if the failure is final, delete it
  discard            → delete
  leaving the retry flow (another tab, a page, Settings, typing instead, recording again) → delete
  15-minute deadline → delete, even if nobody asks
  empty transcript / any final failure → delete
  app restart (also after a crash or kill) → purge everything left in the recordings directory
```

* **Retryable** means it may pass: no connection, HTTP 408/425/429/5xx. Final: rejected credentials (401/403), no key,
  an unreadable answer, other 4xx. The distinction is one function, `is_retryable`, with a table test.
* The retry transcribes **the same file** (same name, size, hash; verified on the device); a Capture exists only after a
  successful transcription (verified: 3 attempts, 1 Capture).
* **TTL**: 15 minutes from the first failure, never extended by retries, enforced by a timer task and re-checked on retry.
  Unit-tested with short deadlines and measured on the device (below).
* **Private by construction**: the file lives in the app cache directory; its path never leaves the module (commands return
  Captures and errors only; a test checks the command file); audio is never written to the database or logged (a test checks
  the module for log macros and SQL); `allowBackup="false"`.
* **Contract**: `VoiceCaptureError` gains `stt_retryable` (the recording is kept) and `no_retained_recording`. `ArthurClient`
  gains `retryVoiceTranscription()` and `discardVoiceRecording()`. Only semantic state crosses the boundary.

UI (mobile Home): the approved warm card, "Couldn't transcribe yet", the native message (which names the cause and says the
recording is kept up to 15 minutes), **Retry transcription** and **Discard recording**. A final failure keeps the existing
copy ("The recording isn't kept…"). Leaving Home discards.

## 3 and 4. Durable organization state, recoverable failure

Whether a capture was organized is already durable: `distillation_runs` has a row exactly when a distillation succeeded,
including one that found no objects. The missing piece was a failed attempt. **One small migration, v5**:

```sql
CREATE TABLE organization_failures (
    capture_id TEXT PRIMARY KEY REFERENCES captures(id),
    code       TEXT NOT NULL CHECK (code IN ('llm_not_configured','llm_failed','llm_refused','llm_invalid_output','storage_failed')),
    message    TEXT NOT NULL CHECK (length(message) > 0),
    failed_at  TEXT NOT NULL CHECK (length(failed_at) > 0)
);
```

* No queue, no history, no copy of the capture or the model output. One row per capture: the latest failure.
* A success deletes the row **in the same transaction** that writes the run, so they cannot disagree. A late failure cannot
  overwrite a success (the insert is conditional).
* **States** (`listOrganizationStates()`, one query): `pending` (never organized, or the app died mid-attempt), `running`
  (this process is working on it; memory only, so it can never be stale), `succeeded` (`objectCount` 0 means "organized,
  nothing found"; never inferred from the object count), `failed` (with code, safe message, time).
* **Retry** is the existing `distillCapture`: it reuses the capture, never creates one, and distillation was already
  idempotent, so a prior commit is returned instead of duplicated (M01D atomicity untouched).
* UI: failures and "organized into nothing" are read at launch, so Home shows "Your thought is saved. Retry organizing", or
  "Nothing to organize in this one", after a restart. "Not organized yet" appears only for `pending`, and only once the states
  are known.

**Migration safety.** v4 → v5 is one transactional step; existing tables are untouched. Tested: upgrade keeps every row
(fingerprints), a failing step rolls back to v4 and stays usable, a newer database is refused untouched. **Run for real**
on the emulator against the live v4 database (17 captures, 51 objects, 54 relations, 73 revisions, 25 parent links):
`user_version` 4 → 5, the SHA-256 of every existing table's rows identical before and after, `integrity_check` ok, 0 foreign
key violations, 0 failures invented.

## 5. Microphone permission and Open Settings

* `ArthurClient.getMicrophonePermission()` → `unknown | granted | denied | denied_permanently`. It only **reads**: no code path
  in the query can raise a dialog (an architecture test checks the Kotlin function).
* Android cannot tell "never asked" from "told not to ask again", so the plugin remembers whether Arthur has asked in
  private preferences: not granted and never asked → `unknown`; asked and `shouldShowRequestPermissionRationale` → `denied`;
  asked and no rationale → `denied_permanently`.
* `ArthurClient.openAppSettings()` opens this app's page in the system settings. The intent and package name stay in Kotlin.
* The UI re-reads the permission at launch, when the app returns to the foreground, and after every start attempt.
  Capture tab: `granted` → records at once; anything else → opens Home first. Only Speak can raise the system dialog.
  `denied_permanently` → Home says so up front with **Open settings**; returning with the microphone allowed removes the card
  and the Capture tab records.
* Verified on the device, in order: fresh launch `unknown` (Capture tab: Home + hint, focus stayed in Arthur, no dialog);
  Speak → dialog → Don't allow → `denied`; Speak → dialog → Don't allow → `denied_permanently` + Open settings; Open settings
  put the system Settings in front; allowing the microphone and pressing Back returned to Arthur with the card gone;
  Capture tab then recorded.

## 6. Batched summaries

`getKnowledgeSummaries(ids?)` → `{ objectId, relationCount, revisionCount, updatedAt, currentRevisionId }[]`: **one SQLite
statement**, at most 1,000 ids (none means all), no cache. `LineageSummariesProvider` now makes that one call. A full history
(`getObjectLineage`) is read only when a screen draws it (the mobile idea page; the desktop inspector, Recently evolving and
the Evolution picker) and only for an idea with more than one revision; an idea that was never edited has its single
revision derived from the object itself (it is identical), so it needs no read. A cached history is dropped as soon as its
summary says the object changed.

| | Before | After |
|---|---|---|
| Native reads to show 49 ideas with counts | 1 history read per idea (49) | **1** summaries read, 0 history reads |
| Per-idea history reads on the Ideas screen | N | 0 (tests assert it with spies) |
| 55 objects on the emulator, same work | 367 / 575 / 475 ms (N reads in parallel) | **54 / 47 / 40 ms** (one read) |

The relation counts were never N+1 (the graph was always one `list_relations`); they now also come from the summary.
On the device the web view's `invoke` is hardened and cannot be wrapped, so the call counts above are asserted in the app
tests (spies on the client) rather than counted on the device; the timings are measured on the device.

## Acceptance on the emulator (Pixel_10 x86_64, API 37, debug build)

| Check | Result |
|---|---|
| Root Back, 12 cycles; state restored | Pass. Same pid; Ideas tab and 51 rows still there |
| Forced Activity destruction, 8 times | 0 aborts |
| Record real audio; force a retryable failure (network off) | Retry card, audio kept on disk (name, size, hash noted) |
| Retry offline | Same file, still kept |
| Retry online | One Capture; the file is gone; ideas organized |
| Discard / leave Home / record again / app killed | File deleted each time; after the kill the file was still on disk and was purged at the next launch |
| 15-minute deadline | The kept file was still there at +879 s and gone at +889 s after my timer started (about 11 s after the failure), i.e. deleted at 15:00 with nobody asking. A retry afterwards answers `no_retained_recording`. The card on screen stays until used (it does not know the time ran out), then says "That recording is gone". |
| Organization failure offline → kill → relaunch | Failure still shown; DB has one `organization_failures` row |
| Retry organizing | Success; failure row gone; 1 new run and 1 new object; the capture count unchanged |
| Permission: unknown → denied → denied_permanently → Open settings → allowed | As listed in section 5 |
| 55 ideas on Ideas | Counts from one request |
| Logcat of the whole acceptance run | No `FORTIFY`, no Arthur crash or abort; no API key (first 16 / last 12 chars absent, no `sk-` token, no `Authorization` header); none of the spoken or typed sentences; no recording path from Arthur (the only matches are my own `adb` commands) |

## Known limits after this milestone

* The specific mutex behind the exit abort is unidentified (no backtrace); the fix removes the hazard (no `exit()` with a
  live WebView) rather than patching a named object.
* A recording that fails for a *final* reason is still deleted; only retryable failures keep audio.
* There is still no recording length cap or telemetry (the 24 MB upload limit fails at stop; see `FOLLOW-UPS.md`).
* `running` is not durable by design: an app killed mid-organization comes back as `pending`, which is honest.
* On desktop the retry/permission methods exist but are inert (no recorder).
