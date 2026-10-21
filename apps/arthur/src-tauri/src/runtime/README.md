# P1a native storage ownership

`NativeRuntime::acquire(absolute_app_data_root)` is the production storage entry point. It returns
an `Arc<NativeRuntime>` (`RuntimeHandle`) and needs no Tauri handle, Activity, WebView, executor,
provider configuration or credentials. Only the existing app composition root starts its existing
provider/services and poll tasks. This module starts none of them.

## Ownership contract

- Canonicalize the app-private directory to converge ordinary relative-component/symlink-root
  aliases. Relative input is rejected rather than resolved against a process working directory.
- A process-wide `OnceLock<Mutex<HashMap<canonical root, reservation/Weak owner>>>` is solely an
  ownership registry. It holds no copy of knowledge, service globals or independent connection.
  The mutex covers short map operations only, never I/O/migrations/provider work.
- Reacquisition returns the identical live Arc. A same-root initialization race returns the typed,
  retryable `RuntimeError::Initializing`; it does not wait indefinitely or open another store.
  Different roots may initialize independently. A failed initialization removes its reservation.
- Before SQLite is opened, acquire a nonblocking, exclusive OS-backed lock on
  `.arthur-runtime.lock`. Rust >=1.89 `File::try_lock` uses the standard platform implementation;
  no crate is added. Contention returns `OwnershipError::InUse`; unsupported locks/I/O fail closed.
- The non-cloneable capability is consumed by `CaptureStore::open_owned`. The store retains it,
  closes its connection before dropping it, and cannot be cloned or detached from the runtime.
  Existing `Mutex<Connection>`, FULL synchronous commits and v1-v9 migrations are preserved.
- Never unlink or replace the ownership file. Its continued presence after exit is normal: the
  OS-held lock, not the file contents or a PID, determines ownership. Crash/kill/`_exit` releases
  handles without application cleanup. App data must live on a trusted local filesystem with
  functioning OS locks, not a network share or externally modified directory.
- Database/lock-file symlinks and nonregular files are refused. This is coordination among
  cooperating Arthur instances, not protection against privileged code replacing private files,
  database hard links, or old binaries/external SQLite tools that ignore the ownership protocol.
- Raw `CaptureStore::open` and in-memory stores are test-only. Existing two-connection CAS tests
  deliberately retain their lower-level fixture seam; shipped code must use the runtime factory.

Tauri manages `RuntimeHandle`; command handlers and app-handle tasks acquire that same managed
type. `Deref<Target=CaptureStore>` preserves service calls without changing IPC names, inputs,
outputs, business rules or the public ArthurClient interface. A future Application-context worker
in the **same default process** can acquire/retain the handle; no worker/JNI binding is implemented
here. It must handle `Initializing` with a bounded retry in its own lifecycle policy.

## Lifecycle and verification limits

The Android `_exit` workaround is unchanged. P1a makes storage acquisition Activity-independent;
it does not keep a worker alive through Activity teardown or provide background scheduling.
Cross-process exclusion fails fast rather than focusing an existing desktop window; window
activation/single-instance UX remains outside this task.

Focused tests: `cargo test --manifest-path apps/arthur/src-tauri/Cargo.toml --lib runtime::tests -- --nocapture`.
They cover reuse, canonical aliases, first creation, initialization races/reservations, independent
roots, OS-lock lifetime, corrupt/future-schema failure recovery, existing v9 bytes/provenance/DAG,
capture validation/durability, absence of service-state initialization, and real subprocess
exclusion, graceful child shutdown and forced-termination recovery. They use temporary synthetic
data and no network/provider. Windows tests case and verbatim-path aliases. Unix additionally
tests symlinked roots and database-symlink rejection; those Unix tests have not run on Windows.

## Task 03 verification on 2026-10-21

Branch: `feature/nodes-integration`; HEAD: `e1879f6fa2e34d2e54367c301a372a6bd6b56b44`.
All pre-existing local P1a/UI work was retained. No branch, commit, push, PR, merge, rebase,
reset, clean, dependency upgrade or architecture-document edit was performed.

The user installed Rust between the initial blocked inspection and this verification. Actual
versions: rustc/Cargo 1.99.1, rustup 1.29.2, active/default
`stable-x86_64-pc-windows-msvc`, installed target `x86_64-pc-windows-msvc`. Visual Studio
Community 2026 supplies the C++ tools; Windows SDK 10.0.22621.0 and 10.0.26100.0 are installed.
Codex retained its old PATH, so commands prepended the existing `.cargo/bin` in the child
PowerShell process only. This task installed no tools and changed no persistent PATH.

Executed commands (from the repository root):

```powershell
rustc --version
cargo --version
cargo fmt --manifest-path apps/arthur/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/arthur/src-tauri/Cargo.toml --all-targets
cargo test --manifest-path apps/arthur/src-tauri/Cargo.toml --lib runtime::tests -- --nocapture
cargo test --manifest-path apps/arthur/src-tauri/Cargo.toml --lib
npm run typecheck
npm run test:architecture
npm run arthur:check
git diff --check
```

Rust >=1.89 is the floor for the ownership API, not a claim that every locked dependency has
been compiled on that minimum version. The successful checks below used 1.99.1, not 1.89.

| Check | Actual result |
|---|---|
| `cargo check ... --all-targets` | PASS, including a final rerun after the test-helper fix; existing unused/dead-code warnings remain |
| `cargo test ... --lib runtime::tests -- --nocapture` | PASS: 28 passed, 0 failed, 900 filtered out. The substring filter includes 20 `runtime::tests` tests and 8 existing `evolution_runtime::tests` tests |
| `cargo test ... --lib` | FAIL: 901 passed, 5 failed, 22 ignored; all five failures independently reproduced without P1a as described below |
| `cargo fmt ... -- --check` | FAIL: existing formatting differences also present in an archived HEAD copy. Differences in 121 unchanged files match that baseline. Broad formatting was not applied |
| `rustfmt --check --edition 2021 --config skip_children=true` on `runtime/mod.rs`, `runtime/tests.rs`, `storage/ownership.rs` | PASS |
| `npm run typecheck` | PASS, freshly executed |
| `npm run arthur:check` | PASS: 561 tests / 42 files, frontend typecheck and Vite production build; large-chunk warning remains |
| `npm run test:architecture` | FAIL: 86 passed / 2 failed. The schema-v6 and speech checks have the same verified LF-only regex/CRLF causes as before P1a |
| `git diff --check` | PASS |
| Protected tracked paths / approved document SHA256 comparison | PASS: migrations, lifecycle, Android, contracts, React UI, hardware and lockfiles unchanged; both P0 document hashes unchanged |
| Four untracked P1a files | PASS: present, final newlines, no trailing whitespace; not inferred from `git diff --check` |

### Stabilization and ownership evidence

The new graceful-child regression test initially failed with Windows BrokenPipe (OS error 232).
The probe reader stopped and closed stdout immediately after READY; the child's test harness then
failed while printing its final result. The fix keeps draining stdout until EOF while reporting
READY immediately. The regression test failed before the fix and passed afterward. Production
ownership logic required no correction. Only the three new P1a Rust files were formatted.

Windows execution confirms identical Arc/store reuse, canonical and case/verbatim aliases,
eight-way initialization races, retryable reservations, independent roots, retained ownership
through the last handle, and lock-before-SQLite behavior. A failed contender is explicitly
checked not to release the established owner's lock. Real child processes confirm exclusion,
graceful release and recovery after `Child::kill`, without deleting a stale marker or consulting
a PID. Corrupt/future-schema failures release their reservation and lock; existing synthetic v9
capture/provenance/revision-DAG data and database bytes are preserved. Runtime acquisition
creates only the database and ownership file, with no service/provider/WebView initialization.
Paid/live/real-data tests were inspected and left ignored; none were explicitly enabled.

### Independently reproduced native baseline failures

A temporary copy used HEAD versions for the 13 modified tracked files, omitted the new P1a
runtime/ownership files, and retained working-tree bytes (including CRLF) for unchanged native
files and the external revision-diff fixture. The same `cargo test --lib` command there gave
**881 passed / 5 failed / 22 ignored**, with exactly the following same failures and assertions:

- `jev::tests::the_real_transport_posts_json_with_a_bearer_header_and_never_leaks_the_key_in_errors`:
  the local dead-endpoint request returns `Timeout`, while the unchanged test expects `Network`.
- `synthesis::architecture_tests::a_same_family_pass_is_wired_to_hold_for_review_and_the_shipped_verifier_is_not_called_independent`:
  an LF-only multiline source needle does not match CRLF.
- `synthesis::architecture_tests::the_real_synthesis_endpoint_is_only_reachable_through_the_production_constructor`:
  an LF-only `#[cfg(test)]` source needle does not match CRLF.
- `synthesis::tests::the_commit_time_permission_check_includes_the_synthesis_authorizations`:
  an LF-only multiline source needle does not match CRLF.
- `synthesis::eval::tests::the_corpus_is_frozen`: the recorded LF corpus checksum differs from
  the unchanged CRLF working-tree bytes. For `dev_revision.json`, normalizing CRLF to LF in a
  diagnostic in memory yields the pinned checksum. Neither corpus nor checksums were edited.

No unrelated test expectations, transport logic, line endings or frozen corpus were changed.
The isolated comparison demonstrates no additional native failures from P1a on this machine;
it does not turn either failed full-suite run into PASS.

**Verdict: P1a PARTIALLY VERIFIED.** Windows compilation and all P1a ownership tests are verified,
but the mandatory full-native, full-format and architecture commands still fail on independently
confirmed baseline issues. Full gate closure is not claimed. Linux/Android builds, Unix symlink
tests, Android file-lock/lifecycle behavior and packaged-app acceptance remain UNVERIFIED. The
existing Android `_exit` code is unchanged. P1b, migrations, LAN, pairing and UI were not started.
