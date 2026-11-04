# Phase A1: Complete Nexus import

**Delivery status — local only.** Phase A1.1 reproduced all 355 strict Linux
failures by test name on pinned Nexus and the import. The Ubuntu guest
blocked sandbox startup before the original Phase A1 execution scenarios
could be compared with real receipts. That comparison is still required
before pushing the branch.

The Nexus `main` snapshot is at `systems/nexus/`. This is a source and
history import; it does not wire Nexus into the monorepo website or start a
runtime. No separate Sentry or A.R.T.H.U.R repository was fetched or imported.
The exact Nexus snapshot includes its existing Sentry-facing UI and audit
fixtures; these are part of Nexus, not a Sentry implementation import.

| Reference | Commit or tree |
| --- | --- |
| [Nexus source main](https://github.com/Kaloyan3D/Nexus/tree/b58aeef8724e5645c68169d81d9525431fbb2de7) | `b58aeef8724e5645c68169d81d9525431fbb2de7` |
| [Ecosystem base main](https://github.com/Arthur-Labs-AI/ArthurLabs-Ecosystem/tree/b91a3ea839e4256c5c9397766425c4a9973d016e) | `b91a3ea839e4256c5c9397766425c4a9973d016e` |
| Local backup `refs/backup/pre-nexus-import` | `b91a3ea839e4256c5c9397766425c4a9973d016e` |
| Subtree merge | `9b1d1ef311b5ab4417de6caaf6804f61a1565c2b` |
| Nexus tree | `a818554257950dafbb231309d377e7afe685cdbf` |
| Website tree | `183eb22fb792a9623cf566beea5953ef42ba98e9` |

The source release commit and its preceding merge contain the complete Native
implementation. `native/` has the Rust workspace, execution engine, broker,
daemon, CLI, and related libraries and tests; `apps/nexus-desktop/` has the
desktop frontend, Tauri backend, and packaging; `runtime/` has the pinned DSH
dependencies, vendored agent, and patches. The import also preserves the
installers, configuration, legacy UI, benchmarks, test fixtures, and docs.
The original root README and all of `website/` are unchanged. Nexus's GitHub
workflow files are preserved inside the subtree; GitHub does not run them as
monorepo workflows from that path.

## Import and integrity checks

Run from a dedicated destination clone. The source remote was fetch-only in
practice: its push URL was set to `DISABLED`. No write was made to the source
remote or to the existing Nexus working copy.

```sh
git remote add nexus https://github.com/Kaloyan3D/Nexus.git
git remote set-url --push nexus DISABLED
git fetch --no-tags nexus refs/heads/main:refs/remotes/nexus/main
git switch --create integration/nexus origin/main
git update-ref refs/backup/pre-nexus-import "$(git rev-parse origin/main)" \
  0000000000000000000000000000000000000000
git subtree add --prefix=systems/nexus \
  --message "Import complete Nexus main with Git history" \
  b58aeef8724e5645c68169d81d9525431fbb2de7

test "$(git rev-parse HEAD:systems/nexus)" = "$(git rev-parse nexus/main^{tree})"
git merge-base --is-ancestor nexus/main HEAD
git rev-list --count nexus/main --not HEAD
test "$(git rev-parse HEAD:website)" = "$(git rev-parse origin/main:website)"
git diff --exit-code origin/main HEAD -- website
```

The subtree commit has the destination base and the original Nexus tip as its
two parents. No squash was used. Tree equality covers all 1,569 tracked
paths, including blob contents and file modes. All 449 source commits are
reachable; the missing-commit count is zero. The website tree comparison and
diff passed. Local build outputs and scan logs were excluded from the commit. The
whitespace diagnostics from the full import diff match those in the
unchanged upstream tree.

## Repository review

- Nexus is public and Ecosystem is private. GitHub reported both `main`
  branches as unprotected. The public source rules endpoint returned no
  rules; destination protection and rules endpoints returned HTTP 403 on
  the current GitHub plan, so their detailed settings could not be inspected.
- No gitlinks or submodule configuration were found at either tip. No LFS
  attributes or pointers were found in either tip. Across the two histories
  the largest blob is the Nexus tokenizer JSON (6,367,096 bytes); none
  reached 10 MB. The vendored DSH tarball is a source dependency.
- Gitleaks 8.30.1 scanned source history (including first-parent merge
  diffs) and an isolated export of the source tree (including archive
  inspection). Findings were reviewed as synthetic redaction and security
  test fixtures, a test idempotency value, or tokenizer checksums. No live
  secret was identified. No local credentials or untracked workspace data
  were imported. Public Git author metadata and upstream fixtures remain
  in the original commits. Automated scanning cannot establish that every
  historical string is non-sensitive.
- Neither repository has a detected repository-wide license. Several
  Rust crates and the vendored DSH package declare MIT in their manifests;
  the DSH archive has no standalone license file. The private DSH runtime
  wrapper declares `UNLICENSED`. This import preserves the existing
  metadata and does not establish a blanket license. Confirm rights and
  applicable notices before external redistribution.

## Build and test validation

Commands below were run from the indicated directory. The host was macOS
ARM64 (Rust 1.99.1, Node 26.13.0, npm 11.20.0); Linux checks used an
Ubuntu 24.04 ARM64 guest.

| Scope | Command and result |
| --- | --- |
| Desktop frontend (`systems/nexus/apps/nexus-desktop`) | `npm ci`, `npm run build`, `npm test`, and `npm run check:deps` passed. Vitest reported 304 tests passed across 30 files. |
| DSH (`systems/nexus`) | Staged the two runtime package manifests in the ignored `app/` directory, as `setup.sh` does. `npm ci --omit=dev --legacy-peer-deps --prefix app` passed; `node app/node_modules/@deepseek-ai/dsh/lib/bin.js --version` reported `0.1.1-rc.2` on both macOS and Linux ARM64 (using the source-pinned Node 24.18.1 on Linux). Plain `npm ci --prefix runtime` is not the installer command and rejects a vendored `workspace:^` peer specifier; that result reproduced against a source export. |
| DSH routing and installer helper (`systems/nexus`) | `node --test tests/EngineeringIsolation.Tests.cjs` passed all six assertions. `sh tests/aih-node-env.Tests.sh` exited 0 and reported 14 passed, with an unbound-variable diagnostic in one shell assertion. |
| Website build (`website`) | `npm ci`, `npm run build`, and `npm run typecheck` passed independently of Nexus. |
| Website browser tests (`website`) | With `serve@14.2.6 out` serving the static build, `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4319 npm run test:e2e` reported 123 passed and one failure. The overlap assertion in `tests/concept.spec.ts:32` at 390×667 failed on an independently built export of destination `main` too. The website tree is identical, so this is an existing baseline failure. |
| Rust on macOS (`systems/nexus`) | `cargo build --locked --workspace --manifest-path native/Cargo.toml` failed in `nexus-store/src/ext_witness.rs` because `libc::ucred` and `libc::SO_PEERCRED` are unavailable. A standalone export of source `main` failed the same way. No Rust tests ran on macOS. |
| Rust on Linux (`systems/nexus`) | `cargo build --locked --workspace --manifest-path native/Cargo.toml` passed. `cargo test --locked --workspace --manifest-path native/Cargo.toml --no-fail-fast` completed with 1,747 passed, 59 failed, and 65 ignored. A repeat in a delegated systemd scope with standard checkout permissions still failed critical broker sandbox execution tests. |
| Desktop packaging checks | `npm run test:packaging` on macOS could not load its Linux fixture `/bin/true`. On Linux ARM64, `node --test apps/nexus-desktop/packaging/*.test.mjs` passed the two bridge tests and skipped four checks requiring an x86-64 ELF fixture. The full Tauri distribution build and Windows installer were not run. |

The first Linux test run exposed guest prerequisites. The broker rejected
group-writable files and the guest Node path; the `broker_a53` and
`inspect_a55` targets passed after correcting those (25 and 17 tests,
respectively, with one ignored in `broker_a53`). Node was the official
24.18.1 Linux ARM64 distribution, verified against its published SHA-256.
The initial sandbox tests also lacked cgroup delegation. The repeat ran
under `systemd-run --user --scope -p Delegate=yes` with `umask 022`, system
Node on PATH, and guest user namespaces enabled. The `code_a56` tests for
hostile build isolation and end-to-end edit, test, and approval execution
still reported failures. These checks exercise core Nexus behavior; their
failure blocks delivery. The delegated repeat was stopped after those
failures, so it has no full-suite totals. A failed isolation test alone
does not establish that a command escaped confinement.

The Ubuntu guest's OpenSSL 3.0.13 also rejected the expired-certificate
fixture's `x509 -not_before/-not_after` flags. The upstream
`native/docs/LINUX-ARM64-PORT.md` already records that CLI limitation and
other ARM64 suite limitations. The source and website were left exact;
no runtime changes or test skips were introduced to pass the gate.

Before pushing, run the locked workspace build and test suite on a supported
Linux host with working sandbox primitives, trusted system Node, and an
OpenSSL CLI that supports the test fixtures. Compare any remaining failing
tests against the pinned source standalone and resolve critical failures
upstream before reimporting. Retain the website baseline evidence rather
than editing the website in Phase A1.

## Phase A1.1 paired validation

Tested the standalone pinned source at
`b58aeef8724e5645c68169d81d9525431fbb2de7` and the monorepo checkout at
`9bee6d8542a660c2f09fca23302afc845fd51d6c`. The website baseline was
`b91a3ea839e4256c5c9397766425c4a9973d016e`. Both Linux checkouts were
detached and verified against the recorded trees. The import still has
1,569 tracked paths, zero missing source commits and the original website
tree. The only change outside the subtree is this report. Phase A1's
history and archive credential scan remains applicable to the identical
Nexus tree, and no test outputs were staged.

### Linux environment

Both runs used the same Ubuntu 24.04.5 ARM64 Lima guest, kernel
6.8.0-142-generic, Rust 1.99.1, systemd 255.4, Bubblewrap 0.9.0, Node
24.18.1 and OpenSSL 3.0.13. Checkouts and ancestors used standard
non-group-writable modes. `/usr/bin/node` is root-owned, mode 0755,
and works with an empty environment. The user systemd manager was running
and a delegated cgroup-v2 scope could create and remove a child cgroup.

The kernel exposes user namespaces, seccomp filters and Landlock. Direct
seccomp architecture checks passed in both runs. Landlock reported ABI 4,
which is below the ABI 6 requirement for scoped networking and signals.
The guest's stock AppArmor user-namespace restriction was active. A direct
namespace probe failed on the UID map and Bubblewrap failed setting up
loopback with `RTM_NEWADDR: Operation not permitted`. No sandbox protection
or test was changed in the paired run.

The M4.7 verification report records a 1,806-pass Fedora workspace run
before the final hysteresis and default changes, followed by targeted
sandbox reruns on the final code. The ARM64 port report records a Fedora
environment with Landlock ABI 7 and newer Bubblewrap and OpenSSL. Those
historical runs are not a paired validation of the pinned release and
this import. The pre-existing Fedora VM was stopped and was not used.

### Source versus import matrix

Commands ran sequentially, from the respective Nexus roots, with
`umask 022`, the same Cargo target directory, incremental compilation
disabled, and dev/test debug info disabled.

```sh
cargo build --locked --workspace --manifest-path native/Cargo.toml
NEXUS_REQUIRE_SANDBOX=1 systemd-run --user --scope -p Delegate=yes -- \
  cargo test --locked --workspace --manifest-path native/Cargo.toml \
    --no-fail-fast -- --test-threads=4
```

| Check | Standalone source | Imported tree | Assessment |
| --- | --- | --- | --- |
| Locked Linux workspace build | Passed | Passed | Equivalent |
| Strict workspace suite | 1,451 passed, 355 failed, 65 ignored | 1,451 passed, 355 failed, 65 ignored | Same 355 failing test names and nine failing test targets. Exit 101 on both. |
| Hostile-build isolation and sandboxed edit/test/approval flow (`code_a56`) | Same Bubblewrap loopback preflight refusal | Same preflight refusal | Environment blocker. Neither test reached command execution or emitted a successful execution receipt in this run. |
| Expired TLS fixture (`tls_a52`) | OpenSSL rejected `-not_before/-not_after` | Same CLI error | Environment dependency. The fixture could not generate the certificate. |
| Same-size snapshot modification (`process_a34`) | Expected error, received `StageReport` | Same result and digest | Reproduces upstream. The ARM64 report also records timing-sensitive snapshot detection. |
| Busy runtime restart (`lifecycle_a614`) | Broker timed out waiting for daemon. Socket missing. | Broker timed out waiting for daemon. Connection reset. | Same failing assertion and startup phase. The terminal socket errors differ, so the diagnostics are not identical. No execution receipt. |
| Website 390×667 Playwright assertion | Failed, overlap 34.83607805427164 against threshold < 1 | Same assertion and measured overlap | Independently served static exports confirm a destination baseline failure. |
| macOS desktop Rust tests | Historical M4.7 evidence only | 54 passed, 0 failed, 21 ignored | Current run covered the supported Tauri crate on Apple Silicon. Live cases stayed ignored. |
| macOS desktop app build | Historical evidence only | `npm run tauri -- build --bundles app -- --locked` produced an arm64 `Nexus.app` | Bundle creation passed. Strict codesign verification found the linker-only signature did not seal app resources. Signing, notarization and live engine connection were not verified. |

For 354 failures, diagnostics matched after removing run-specific PIDs,
ports, paths, load averages and Rust's one-time backtrace hint. The only
remaining diagnostic difference is the busy-runtime socket error above.
There were zero import-only failing tests in the paired run.

This establishes that the stock-guest failure set is shared, including the
absence of receipts where the sandbox probe refuses to start. It does not
reproduce the original Phase A1 receipt-level failures under a guest where
the sandbox actually launches. The next check is to run the two critical
`code_a56` cases in both checkouts on a Linux guest with functioning
Bubblewrap and the required kernel features, with
`NEXUS_REQUIRE_SANDBOX=1`. Compare their command exit classifications and
execution receipts before delivery. No integration-only code fix is
supported by the evidence so far.

## Synchronizing future Nexus changes

From a fresh integration branch based on Ecosystem `main`, configure the
same fetch-only Nexus remote. Review the incoming changes and history, then
merge a pinned upstream commit:

```sh
git fetch --no-tags nexus refs/heads/main:refs/remotes/nexus/main
git subtree merge --prefix=systems/nexus "$(git rev-parse nexus/main)"
```

Keep the import unsquashed. Recheck ancestry, subtree and website trees, and
the applicable build and tests before opening a PR. Keep any Nexus fixes
upstream so that the subtree can continue to match the source tree exactly.
Preserve the subtree merge commit when landing this PR: use a merge commit
so the original Nexus history remains reachable from Ecosystem `main`.

For later phases, review the Sentry and A.R.T.H.U.R repositories separately,
including access, licensing, and history, before planning their imports.
Define the runtime contracts and wiring in a separate phase.
