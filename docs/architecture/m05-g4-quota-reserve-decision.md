# M05 Task 14B — G4 physical-disk quota and reserve decision

Status: **G4 — OWNER APPROVAL REQUIRED / NOT ACTIVATED.** Prepared 2026-10-23.

## 1. Executive summary

**SOURCE-CONFIRMED:** The dormant kernel enforces logical resource admission. It does not query filesystem capacity. `Limits.reserve` adds bytes to the metadata counter; it neither allocates a reserve file nor proves that those bytes are available. Production remains schema v9. A synthetic `Some(0)` reserve is not a production policy.

**MEASURED:** On this Windows/NTFS host, a valid 12-object transaction encoded to 329,917 bytes, above 256 KiB. Retaining 265,850,131 payload bytes produced a 317,501,440-byte main database; the next transaction failed `PayloadQuota`. A bounded snapshot retained about 8.46 million staged bytes in addition to live data and retained cores. Experimental WAL reached 43,618,472 bytes and remained allocated in file length after PASSIVE checkpoint.

**CANDIDATE — OWNER APPROVAL REQUIRED:** Retain the 4 MiB local event ceiling and existing effect/dependency/spool ceilings; adopt the separate logical, RAM and physical contracts in sections 10–13. Recommend profile A as the starting implementation specification, with explicit growth budgets, a dynamic journal allowance and a recovery floor. Unknown physical bounds must block admission. These numbers are policy envelopes to enforce and validate, not demonstrated universal amplification bounds.

**NOT MEASURED / PLATFORM EVIDENCE MISSING:** Actual filesystem exhaustion during append/COMMIT/snapshot, I/O failure, process death and power loss were not executed. Android and Linux storage acceptance remains open. The package is ready for individual owner decisions; physical enforcement and production activation are not ready.

## 2. Exact source baseline and scope

**MEASURED:** Preflight: repository `Kaloyan3D/A.R.T.H.U.R`, branch `feature/nodes-integration`, HEAD `17368425786dfb827d181f8df83a34271bb9ddcb`, subject `feat(m05): add dormant due expiry execution adapter`. Initial `git status --short --branch` contained only the branch header; `git diff --check` exited 0. Branch, HEAD and last 12 commits were inspected before measurements.

**SOURCE-CONFIRMED:** Inspected current [kernel](../../apps/arthur/src-tauri/src/storage/journal/storage.rs), its [tests](../../apps/arthur/src-tauri/src/storage/journal/storage_tests.rs), [stream](../../apps/arthur/src-tauri/src/storage/journal/stream.rs), [SQL effects](../../apps/arthur/src-tauri/src/storage/journal/sql_effects.rs), [codec](../../apps/arthur/src-tauri/src/storage/journal/codec.rs), [snapshot](../../apps/arthur/src-tauri/src/storage/journal/snapshot.rs), [snapshot tests](../../apps/arthur/src-tauri/src/storage/journal/snapshot_tests.rs), [expiry](../../apps/arthur/src-tauri/src/storage/journal/expiry.rs), [candidate SQL](../../apps/arthur/src-tauri/src/storage/m05_v10.sql), [v10 tests](../../apps/arthur/src-tauri/src/storage/m05_v10_tests.rs), [migrations](../../apps/arthur/src-tauri/src/storage/migrations.rs), actual writers and shared domain helpers. Architecture references: [sync contract](m05-sync-contract.md), [LAN design](m05-lan-personal-network.md), [migration proof](m05-journal-migration-proof.md), [readiness](m05-activation-readiness.md), [authoritative writers](m05-authoritative-writers.md).

**SOURCE-CONFIRMED:** Tasks 07–11, MEGA A, MA-01/02 and 14A remain within their accepted dormant boundaries. `SCHEMA_VERSION=9`, `STEPS` contains 1–9. No source, SQL, manifests, lockfiles, runtime, scheduler, transport or UI was changed. Only this document and the readiness reference are task deliverables. Measurements used new synthetic databases outside the repository; no application data root was opened.

## 3. Executable limits versus architecture candidates

All numeric byte units below are binary: KiB = 1,024 bytes; MiB = 1,048,576 bytes.

| Classification | Resource | Current behavior |
|---|---|---|
| SOURCE-CONFIRMED | Canonical core | 4 MiB / 4,194,304 bytes codec ceiling; kernel may select a lower `Limits.core`, not a higher one |
| SOURCE-CONFIRMED | Effects / dependencies / JSON depth | 4,096 raw observed effects; 256 dependency references; depth 16 |
| SOURCE-CONFIRMED | Observation spool | 8 MiB / 8,388,608 UTF-8 bytes of before/after JSON images, checked by observers/context and native processing; not the entire SQL table footprint |
| SOURCE-CONFIRMED | Payload / metadata | `Limits` validation permits at most 256 MiB / 64 MiB; the caller must select a policy. `Limits::candidate()` is `#[cfg(test)]`, with these values and `reserve: Some(0)` |
| SOURCE-CONFIRMED | Snapshot | 32 MiB row-byte sum, 20,000 staged records, 256 KiB per staged row; manifest at most 256 KiB |
| SOURCE-CONFIRMED | Snapshot timing / packaging | Default capture watchdog 2 s; checks occur during image construction, not a hard deadline around SQL insertion/COMMIT. Core fragment target 120 KiB; current manifest chunk target 64 KiB, soft when one row is larger |
| CANDIDATE — OWNER APPROVAL REQUIRED | Physical snapshot/scratch reserve | Architecture reference 64 MiB; no OS capacity enforcement exists |
| CANDIDATE — OWNER APPROVAL REQUIRED | Future transport | 256 KiB snapshot transport chunks / 1 MiB frames; not current local packer chunk targets and not implemented exporter limits |
| CANDIDATE — OWNER APPROVAL REQUIRED | Warnings | 80% payload warning is an architecture proposal, not an implemented notification |

**SOURCE-CONFIRMED:** `reserve: None` returns `PolicyPending`. Values above the permitted core/payload/metadata maxima also return `PolicyPending`. `quota()` runs before activation's initialization transaction, again inside it after initialization, before append with the new encoded core as `additional`, and after append/head updates with `additional=0`. Failed admission rolls back the owning mutation. Payload checked addition, metadata conversions/additions and stream sequence advancement reject overflow. SQLite aggregate/query failure maps to an error, not spare capacity. Spool uses checked/bounded counters. None of these checks reserves filesystem bytes.

**SOURCE-CONFIRMED:** Payload is `sum(length(canonical_bytes))` over **all retained** `sync_bundles`, regardless of signing or peer state. Metadata begins with `reserve`, then sums seven tables: `sync_origins`, `sync_local`, `sync_bundles`, `sync_commit_fences`, `sync_entity_heads`, `sync_snapshots`, `sync_snapshot_rows`. Columns named `canonical_bytes` and `row_bytes` are excluded. Each non-NULL declared INTEGER counts 8 bytes; other values count `length(CAST(column AS BLOB))`; NULL counts zero. SQL record headers, B-trees, indexes and unused pages are absent from this sum. Manifest bytes are metadata; snapshot `row_bytes` use the separate image budget.

**DERIVED / CALCULATED:** Setting `reserve=Some(64 MiB)` under a 64 MiB metadata cap leaves no allowance for even the first origin/local rows. It cannot implement a 64 MiB physical reserve. A later physical policy needs separate fields, not a reinterpretation of the existing counter.

**SOURCE-CONFIRMED:** Stream replay separately estimates history/cache storage using conservative 1 KiB charges plus key bytes for records/heads/tombstones and legacy entries, against the metadata limit. It is not added to persisted metadata usage and is not measured RSS. Activation replays retained cores. A persistent quota pass therefore proves neither a RAM bound nor a startup-latency bound.

**SOURCE-CONFIRMED:** Important coverage gap: `finalize()` returns early after context cleanup when there are no observed domain effects. Snapshot-only allocate/capture/pack operations use this path and do **not** run the two finalizer `quota()` calls. They enforce their snapshot-specific bounds, but newly added snapshot metadata is not checked against `Limits.metadata` in that transaction; a later domain append or activation can detect it. The general metadata counter includes snapshots when invoked, but it is not a universal post-transaction cap. A future G4 patch must explicitly cover maintenance transactions as well as effect-bearing transactions.

## 4. Storage accounting map

**MEASURED:** Maxima below are independent maxima across fixture endpoints, not one simultaneously existing database. `L` means the logical column accounting defined above; `S` is staged `row_bytes`; physical quantities explicitly say file/page bytes. The full endpoint and dbstat records are retained in the evidence artifact (§6).

| Category / owner | Retention; current accounting / hard bound | Maximum observed fixture | Physical / restart implications and uncertainty |
|---|---|---|---|
| Twelve domain projections | Persistent; outside journal quota; native per-request validation only | Aggregate 44,429,676 L bytes (M09); individual rows/bytes below | Duplicated by cores and snapshot; retained on restart; no aggregate domain-disk cap |
| Derived FTS and indexes | Persistent/rebuildable; outside logical quota | FTS tables 102,400 page bytes (M05); selected indexes 1,339,392 page bytes | Page and write amplification; not permission to discard authoritative rows; other index populations unmeasured |
| `sync_origins` | Persistent sealed/active streams; metadata | 100 rows / 17,356 L bytes | Activation rotation retains seals; record/index overhead additional |
| `sync_local` | Persistent current owner pointer; metadata | 1 row / 88 L bytes | Recreated/updated under activation transaction |
| `sync_bundles` | Immutable retained; core payload plus header metadata | 1,001 rows; 265,850,131 payload bytes; 260,156 header L bytes (different fixtures) | Core bytes must remain for replay/closure; indexes additional |
| `sync_commit_fences` | Persistent; metadata | 1,001 rows / 36,036 L bytes | Atomicity guard; not disposable under pressure |
| `sync_write_context` | Transaction-local persistent-table rows; not metadata quota | One active context by design; logical row bytes NOT MEASURED | Must be empty after committed transaction; crash rolls back with SQLite; unexplained persisted context blocks activation |
| `sync_effects` | Transient observer rows; 8 MiB image counter / 4,096 effects | 4,085,610 image bytes; 4,088,738 all-column L bytes (M09) | Table/index/page peak can survive as freelist space; not zero physical cost after DELETE |
| `sync_entity_heads` | Persistent; metadata; separate replay-cache estimate | 4,420 rows; 548,080 L bytes | Per-facet keys/indexes and in-memory maps add costs |
| `sync_snapshots` | Persistent job/manifest; metadata | 1 row; 129,210 L bytes | Ready snapshot immutable; only one non-aborted job admitted; no ready retirement policy |
| `sync_snapshot_rows` | Persistent materialized baseline; S excluded from metadata | 1,502 rows; 8,459,519 S bytes; 202,486 L metadata bytes | Duplicates live data and hex-encoded covered cores; aborted cleanup allowed, ready deletion not authorized |
| SQLite table/index/schema pages | Persistent and freelist; no physical admission | M09 77,515 pages × 4,096 bytes, including 1,003 free pages | `dbstat` page attribution available; sums must not be added again to main file bytes |
| Main `arthur.db` | Persistent; no physical cap | 317,501,440 file bytes / same final allocated bytes (M09) | Main file may retain freed pages; free capacity is not `freelist_count` |
| `arthur.db-journal` | Transient DELETE rollback journal; uncounted | 391,208 sampled file bytes | Can disappear before sampling; hot-journal recovery needs platform proof |
| `-wal`, `-shm` | WAL experiment only; uncounted | 43,618,472 / 98,304 sampled file bytes | Checkpoint may leave WAL length; reader contention and real app WAL policy unverified |
| Filesystem allocation / temp files | Outside counters | NTFS allocation unit 4,096 bytes; endpoint AllocationSize equals main lengths in primary fixtures | Directory/MFT, temporary sort/subjournal files, allocation peaks and device write amplification NOT MEASURED |
| Future signed envelope store | NOT IMPLEMENTED; no approved accounting | NOT MEASURED | Needs own persistent/index/scratch reservation; signing unavailable must not gate journal save |
| Future importer/conflict staging | NOT IMPLEMENTED; no approved accounting | NOT MEASURED | Needs independent bounded authenticated staging and crash protocol |

**MEASURED:** Individual domain maxima (rows / L bytes): `captures` 2,210 / 44,429,595; `projects` 1 / 81; `knowledge_objects` 34 / 28,080; `object_sources` 34 / 2,992; `distillation_runs` 1 / 64; `thought_revisions` 1,000 / 291,561; `revision_parents` 999 / 71,928; `revision_evidence` 999 / 166,716; `relations` 11 / 1,660; `identity_decisions` 35 / 7,138; `pending_claims` 35 / 11,676; `revision_proposals` 35 / 14,731. Row and byte maxima may come from different fixtures.

## 5. Measurement environment and interpretation

**MEASURED:** Windows 11 Home build 26200, x86_64, NTFS; Rust/Cargo 1.99.1, Python 3.14.5; app package 0.1.0, debug/unoptimized source-path harness at the exact HEAD above. Original locked rusqlite 0.40.2 with bundled **SQLite 3.53.2**. All fixture pages 4,096 bytes. Actual `CaptureStore` sets foreign keys ON and `synchronous=FULL`; fresh production-style opens measured `journal_mode=delete`. Source does not set or validate journal mode. WAL was explicitly selected only in marked experiments, with `wal_autocheckpoint=0` to expose accumulation; it is not evidence of a shipped WAL configuration.

**MEASURED:** Artifact root `C:\Users\merte\AppData\Local\Temp\arthur-g4-1736842-evidence`. Before the primary run the volume reported 40,691,556,352 free bytes. Each case required more than 2 GiB remaining; no disk-filling experiment was performed. Database paths were newly created beneath that root, with existing-file refusal. All measurements were offline; no provider/network call is part of the harness.

**MEASURED:** Logical values are SQLite column payload lengths, not SQLite page usage. File length comes from filesystem metadata. `dbstat` reports page ownership. A 20 ms polling thread recorded per-file **observed** length maxima during primary cases; short-lived peaks may be missed. Its historical JSON field `allocated` used `GetCompressedFileSizeW`: treat that field only as that API's storage-size reading, **not a reliable block-allocation peak**. A separate `allocation-endpoints.json` uses `GetFileInformationByHandleEx(FileStandardInfo).AllocationSize` after connections close. These endpoint allocations equal primary main-file lengths. Exact instantaneous peaks, allocation peaks, filesystem metadata and device-level bytes are NOT MEASURED. Do not sum independent file maxima and call the result a simultaneous peak. M01–M04 share each replica; polling cannot attribute a transient maximum to an individual stage. M11's supplemental run records checkpoints/endpoints, not polled peaks.

**NOT MEASURED / PLATFORM EVIDENCE MISSING:** Debug-host timings include instrumentation, per-event log flush, filesystem and concurrent regression-load variability. Repeated M01–M04 and M08 timings are ranges; all other timings are single observations. No mobile latency, RAM/RSS peak, battery/storage-controller behavior or hard two-second capture guarantee follows.

## 6. Reproduction and retained evidence

**MEASURED:** The disposable evidence artifact is explicitly retained outside Git: harness `Cargo.toml`, original lockfile, `main.rs`, `storage_wrapper.rs`, `journal_wrapper.rs`, `probe.rs`, Python runner, JSONL events, environment, per-file maxima, allocations, run logs, regression logs and checksums. Synthetic databases, source/scripts and results are all retained as this explicitly documented disposable evidence artifact:18 database files total431,120,384main-file bytes (about411.15MiB), plus small lock/evidence files. Cleanup attempts were rejected by automatic approval review as “blocked by policy”, including exact literal-path deletion; no bypass was attempted. No real application file is included. This is local evidence, not a repository test target or a committed portable benchmark.

**SOURCE-CONFIRMED:** The external crate imports original modules by absolute read-only `#[path]` references. It adds a sibling probe under its own journal wrapper, without modifying production module privacy or implementing a second codec/reducer/finalizer. Dependencies and lockfile are the original application's. M03–M06 use `JournalKernel::run`, `with_domain` and unchanged shared domain helpers to inspect the actual uncommitted spool before the actual finalizer. M07 uses the actual typed `Writers` adapters. Snapshot uses actual allocate/capture/pack/verify. Candidate v10 is appended to a local copy of the migration step list for these databases only.

**MEASURED:** Primary reproduction, run from the repository root (PowerShell):

```powershell
$task14bEvidence = Join-Path $env:TEMP 'arthur-g4-1736842-evidence'
cargo build --locked --offline --manifest-path "$task14bEvidence\Cargo.toml" --target-dir apps/arthur/src-tauri/target --bin arthur-g4-probe
python "$task14bEvidence\run_measurements.py" (Get-Location).Path
```

**SOURCE-CONFIRMED:** The retained runner refuses existing fixture DBs. The original fixture paths still exist and cannot be reused without cleanup. Prefer the fresh-root runner below; never overwrite the retained databases or append a new run to the primary events. For an independent run use a fresh root named `arthur-g4-*`, set `ARTHUR_G4_EVIDENCE` to its absolute path and `ARTHUR_G4_CASE` to one of `M01-M04`, `M05`, `M06`, `M07`, `M08`, `M09`, `M10`, `M11`, `M12`, then execute `apps/arthur/src-tauri/target/debug/arthur-g4-probe.exe`. The Rust probe itself refuses existing DBs. The retained README provides a fresh-root runner that monitors all cases and records durations: `python "$task14bEvidence\run_fresh.py" (Get-Location).Path <new-absolute-arthur-g4-output-root>`. The output root must not already exist. Its corrected allocation collector was smoke-executed with M12 (exit0); the primary historical data remains unchanged. Paths embedded in wrappers must be adjusted if the checkout moves; preserve the specified HEAD. UUIDs/timestamps vary, so byte-exact cores and small header differences vary on rerun.

**MEASURED:** Primary `runs.json` exit codes were all 0: M01–M04 6.561 s, M05 31.660 s, M06 0.235 s, M07 1.415 s, M08 38.763 s, M09 75.648 s, M10 0.477 s, M12 0.082 s. Supplemental M11 and the error-code-instrumented M12 both exited 0. Per-operation durations below are narrower than total fixture construction time.

## 7. M01–M12 results

**MEASURED:** The appendix is the complete numeric endpoint ledger, including all replicas, mode, pages, freelist, simultaneous file lengths, domain/payload/metadata/S bytes and timed stages. Primary sampled maxima are separately tabulated. All cases use §5's OS/SQLite/build and §6's reproduction, with the fixture selector shown below.

### M01 — Empty v9 to synthetic v10: EXECUTED, three replicas

**MEASURED:** Main 278,528 → 462,848 bytes; pages 68 → 113; freelist 0 → 0; schema objects 101 → 175; indexes 34 → 47; DELETE mode. Growth **184,320 bytes / 45 pages**, 74 objects and 13 indexes. Default Inbox contributes 81 domain L bytes in both. Migration elapsed 13.825–39.936 ms. No registered migration changed. Stage-specific transient peak not measured; the M01–M04 combined replica maximum is in the appendix.

### M02 — First activation: EXECUTED, three replicas

**MEASURED:** Main stays 462,848 bytes using existing pages. Replica0: one origin (146 L bytes) plus one local row (88 L bytes) = **234 metadata bytes** (233–234 across replicas); no core yet. 10.992–23.526 ms. Zero main-file growth does not mean zero transactional headroom is needed: journal preimages and future rotation still need admission.

### M03 — Normal Captures: EXECUTED, three replicas

**MEASURED:** 100 sequential commits of synthetic notes, 387–388 text characters each. Replica 0: domain 81 → 49,261 L bytes, payload 0 → 122,358, metadata 234 → 54,620; main 462,848 → 839,680 bytes (+376,832). Average core 1,223.58 bytes; upper observed 1,225. Each core has one effect; image spool 556–558 bytes, all-column effect rows 648–650 bytes. Batch duration 1.525–2.100 s. FTS page footprint stays 16,384 bytes: this Capture workload does not measure revision-FTS growth. Index pages are present in dbstat; main growth includes indexes and page slack, not just domain text. This fixture average is not a universal Capture size.

### M04 — Maximum valid distillation: EXECUTED, three replicas

**MEASURED:** Twelve objects, each 200-character title and 2,000-character body, mostly U+0001 with a leading `A`; valid source spans and actual distillation/root-revision/source-link/run writes. Replica 0: **329,917-byte core**, 49 raw effects, 37 operations, 2 dependencies; image spool 645,901 bytes, all-column effect rows 650,814 bytes. Final main 1,945,600 bytes with 162 freelist pages; domain 106,943, retained payload 453,134, metadata 63,438 L bytes. This reproduces and exceeds the historical 329,420-byte lower bound, rather than copying its old value.

**DERIVED / CALCULATED:** 329,917 > 262,144 by 67,773 bytes. A universal 256 KiB local ceiling rejects this valid atomic operation. A 4 MiB ceiling admits this example but does not establish that every existing legal graph/review composition fits.

### M05 — Lineage/evidence: EXECUTED

**MEASURED:** One object, initial revision plus 999 valid system CAS revisions, 999 parent edges and 999 evidence references, approaching the 1,000-history cap without padding. Final domain 530,886 L bytes; revisions alone 291,561; parents 71,928; evidence 166,716. 1,001 retained cores total 4,497,045 bytes (average 4,492.55, max 4,503); metadata 732,024, including heads 435,598. Per revision: 4 raw effects, image spool 1,558–1,731 bytes; all-column spool max 2,177. Main 462,848 → 7,569,408 bytes; FTS pages 16,384 → 102,400; selected indexes 1,339,392 page bytes at end. Revision loop 31.450 s, one run; it is not an activation replay benchmark.

### M06 — MODEL graph replacement: EXECUTED, bounded fixture; high-bound DERIVED

**MEASURED:** Twelve real objects; insert 11 MODEL `related_to` edges, then actual integration helper removes those 11 and adds 11 `depends_on` edges. Insert: 8,306-byte core / 11 effects / 12 dependencies / 2,661-byte spool. Replacement: **15,060-byte core / 22 effects / 12 dependencies / 5,322-byte spool**, 7,368 all-column effect bytes; 18.436 ms single observation. Final domain 7,127, payload 38,081, metadata 12,350; main 516,096 at seeded stage → 532,480 bytes. Actual removal facts are in the canonical operations, not inferred from missing final rows.

**DERIVED / CALCULATED:** This is a high-bound 12-object fixture, not the global relation limit. A request with more than 4,096 observed relation effects, more than 256 distinct dependency references, or over 4 MiB encoded closure will be refused even if native v9 accepted its domain request. Existing k14 boundary tests exercise 4,096/4,097 effects and 256/257 dependencies. A maximum-size realistic graph fixture was not measured; early planning/bounding remains a next-task prerequisite. Do not split the business event automatically.

### M07 — Identity, review and dormant expiry: EXECUTED; spool partially unmeasured

**MEASURED:** Actual typed adapters create 35 uncertain claims, 35 evidence-bearing proposals, an approval, a rejection and legitimate user-separate resolution; then explicitly run one due-expiry batch of 32. Representative claim core 2,720 bytes / 2 effects (persisted core row 3); approval 9,329 / 6; rejection 3,915 / 1; user separation 7,621 / 6. Expiry: **194,312-byte core / 191 effects / 159 operations / 67 dependencies**, 178.225 ms. Derived proposal supersession is included; no scheduler was enabled. Main 876,544 → 1,314,816 bytes across expiry, domain 31,659 → 49,528; payload 202,697 → 397,009; metadata 47,745 → 68,969. Proposal core ranges and all adapter counts are retained in the derived adapter ledger.

**NOT MEASURED / PLATFORM EVIDENCE MISSING:** Typed `Writers` has no existing readonly in-flight spool seam. M07's claim/proposal/review/expiry **byte-spool peak was not measured**; `raw_effect_count` is measured from the retained actual core record. Seed-helper spool rows are not a substitute for adapter peaks. A future reviewed test-only observation seam is needed if byte-level adapter attribution is required; frozen source was not broadened for it.

### M08 — Snapshot: EXECUTED, three DELETE and three experimental WAL replicas

**MEASURED:** Each baseline has 300 approximately 8.5k-character Captures, about 2,584,740 domain L bytes and 2,804,400 retained core bytes. Actual capture stages 1,502 records and **8,459,414–8,459,519 S bytes**; `@bundle` rows use 5,774,233–5,774,329 bytes, including hex-encoded core fragments plus headers. Manifests are 128,591–128,617 bytes, counted under metadata. Pack creates descriptors in the DB, not a separate archive/chunk file. Original domain and core rows remain alongside the baseline.

**MEASURED:** DELETE main before capture 6,434,816–6,443,008 bytes; materialized 15,687,680–15,695,872; ready 15,814,656–15,822,848. Capture 553.001–825.215 ms; pack **plus verify** 1,961.816–2,614.545 ms. These pack timings are not subject to the capture watchdog. Experimental WAL before capture 34,006,512–34,121,872 bytes; ready 43,503,112–43,618,472; SHM 98,304. Capture 569.386–708.373 ms; pack+verify 1,979.462–2,121.285 ms. Main stays 278,528 until checkpoint. Separate maximum 32 MiB snapshot and 20,000-record stress timing was not measured; bounded smaller fixture only.

### M09 — Near 256 MiB retained payload: EXECUTED

**MEASURED:** Actual kernel transactions each insert 34 valid maximum 20,000-character escaped Captures; average core about 4,090,002 bytes, maximum 4,090,006, below 4 MiB. 65 commits retain **265,850,131 bytes (253.534 MiB; 99.04% of cap)**. Attempt 66 returns `PayloadQuota`; only 2,210 Captures and 65 bundles persist. Image spool max 4,085,610 bytes. Final domain 44,429,676, metadata 567,549 L bytes; main **317,501,440 bytes (302.793 MiB)** with 1,003 freelist pages. Sampled rollback-journal maximum 391,208 bytes. Loop 75.130 s. Remaining payload allowance 2,585,325 bytes, insufficient for that next core. The logical ceiling was approached, not filled exactly, and is not a main-file ceiling.

### M10 — Incarnation rotation: EXECUTED, synthetic activations

**MEASURED:** 100 actual kernel activations on the same synthetic connection: 99 sealed origins retained and one active, no bundles. Metadata 0 → 17,444 bytes; main 462,848 → 491,520 bytes (+28,672), 393.212 ms total. These are owner/kernel rotations, not 100 OS process restarts or backup restores. Existing k02 restore tests separately pass; no actual crash/restore durability is inferred.

### M11 — WAL/checkpoint/freelist: EXECUTED experiments

**MEASURED:** In M08 WAL replicas, PASSIVE returned busy=0 with 10,559–10,587 frames all checkpointed, grew main to 15,814,656–15,822,848 bytes, and **did not shorten WAL** (43,503,112–43,618,472). TRUNCATE returned `(0,0,0)` and WAL length 0 while SHM remained 98,304. No other reader was present.

**MEASURED:** Supplemental M11 creates an actual escaped distillation, checkpoints, then performs 100 typed Capture commits. Main stays **1,572,864 bytes / 384 pages**, freelist decreases **162 → 89**, proving reuse of 73 pages without shrinking the file. WAL grows 0 → **8,520,192 bytes**, SHM 32,768; PASSIVE retains that WAL length; TRUNCATE reduces it to 0. The 100 writes take 270.380 ms in one run. WAL growth despite main-page reuse must be budgeted. Supplement has endpoint maxima only; pinned-reader starvation and allocation peaks remain unmeasured. See SQLite's [WAL/checkpoint documentation](https://www.sqlite.org/wal.html).

### M12 — Controlled space failure: EXECUTED PARTIALLY

**MEASURED:** `PRAGMA max_page_count=113` on the disposable activated 113-page DELETE DB prevents page growth. Actual `Writers::create_capture` of 20,000 characters fails `Store(Database)`; supplemental extraction confirms SQLite extended code **13 / SQLITE_FULL**. Main stays 462,848 bytes; no Capture or bundle persists. After closing/reopening with a raw synthetic-v10 SQLite connection: `integrity_check=ok`, schema=10, Captures=0, effects=0, context=0. Normal production v9 opener would reject version 10; this raw recovery inspection is not production activation. The primary sampled journal maximum is 21,032 bytes; primary fixture including setup/reopen takes 81.718 ms.

**NOT MEASURED / PLATFORM EVIDENCE MISSING:** Pager growth refusal is controlled `SQLITE_FULL`, not filesystem exhaustion or a simulated device. Failure occurred during the domain statement, not a demonstrated bundle-insert or COMMIT failure. Before-domain physical admission, after-domain/pre-append FULL, append FULL, COMMIT FULL/I/O error, snapshot capture FULL, pack FULL, hot-journal crash and power loss were **NOT EXECUTED**. Existing injected stage/deferred-constraint/rollback tests cover logical atomicity only. [SQLite max_page_count](https://www.sqlite.org/pragma.html#pragma_max_page_count) describes the pager mechanism.

## 8. Logical and physical amplification

**DERIVED / CALCULATED:** M03 main growth 376,832 / (49,180 domain delta + 122,358 payload + 54,386 metadata delta) = **1.668×** selected logical growth. M05 final main / (530,886 domain + 4,497,045 payload + 732,024 metadata) = **1.314×**, including empty-schema cost. M09 main / (44,429,676 + 265,850,131 + 567,549) = **1.021×**. These different ratios reflect page occupancy, fixed schema/index cost and actual transient freelist residue; none is a safe universal multiplier.

**DERIVED / CALCULATED:** M08 DELETE replica 0 capture+pack main delta = 9,383,936 bytes, approximately **1.109×** its 8,459,501 staged row bytes. Its `@bundle` image alone is **2.059×** retained core bytes, before adding live-domain image, row/index overhead and manifest. Hex representation explains genuine duplication; do not add core bytes again to the snapshot's already inclusive S total. A 32 MiB S budget can coexist with the original domain/payload, metadata, DB pages, journal and temporary buffers. A 64 MiB physical reserve is not proven sufficient.

**DERIVED / CALCULATED:** Experimental M08 WAL length / pre-capture logical DB page bytes is approximately 5.3× after 300 small commits with autocheckpoint disabled. This is accumulated frame traffic, not a per-transaction bound. Checkpoint may temporarily require main growth while WAL remains. Existing file bytes already reduce free capacity; only additional growth belongs in the admission requirement. Page counts/dbstat and main-file length describe overlapping bytes and must not be summed.

## 9. Worst cases and compatibility

**SOURCE-CONFIRMED:** JSON escaping expands U+0001 to six ASCII bytes. Before/after observation may duplicate a changed row; domain SQL, raw effects, reducer projections, canonical Vec, replay maps and snapshot Vec may coexist. Logical quotas are not peak RAM budgets. Effects and dependencies are different counts; a closure can hit dependencies before effects. Many existing domain operations were not designed around a global atomic journal cap.

**DERIVED / CALCULATED:** Over 32 MiB of retained core history cannot fit the current full snapshot because core fragments alone exceed 64 MiB in hex, before headers/domain. Even substantially smaller histories can exceed the 32 MiB S limit. M09's near-256 MiB journal is therefore outside the current snapshot profile; a larger retained history is not automatically bootstrap-able. Also record-count and manifest-size limits can reject an image before byte limits. Ordinary journal saves may continue until their own admission fails; failed snapshot creation grants no history-retirement permission.

**CANDIDATE — OWNER APPROVAL REQUIRED:** Accept explicit `BundleTooLarge`/effect/dependency/spool refusal for previously legal requests under the bounded profile, with preflight estimation where possible. Otherwise commission a separately reviewed larger bounded profile. No silent unjournaled save, omitted effects, autonomous event splitting, tombstone deletion or policy-free quota increase is allowed. Larger unsigned/unpaired backlogs remain retained and eventually block writes without approved retirement.

## 10. Proposed physical admission contract

Every paragraph in this section is **CANDIDATE — OWNER APPROVAL REQUIRED** unless marked otherwise. No API or enforcement has been implemented.

### Formula and types

Use checked unsigned 64-bit bytes and round each independently allocated file requirement up to the actual allocation unit `A`. Unknown/overflow/unsupported mode is an explicit `SpaceUnknown` or `PolicyPending` failure. Define:

```text
F = bytes available to the caller on the actual canonical DB volume
R = recovery floor, kept available after a successful admitted operation
G = bounded additional main-file allocation for THIS operation
J = bounded ADDITIONAL rollback/WAL allocation for this operation
T = bounded additional temp/subjournal/pack-file allocation
C = already admitted but not yet allocated claims on this volume
required = round_A(R) + round_A(G) + round_A(J) + round_A(T) + C
admit iff logical checks pass AND every bound is known AND F >= required
```

Snapshot capture uses `G_capture`, pack uses only its **remaining** metadata/file growth; existing staged rows are not charged twice. Existing main/WAL/snapshot allocation is already reflected in `F`. `C` prevents overlapping storage jobs from promising the same capacity; it excludes the operation being evaluated. Current kernel serializes its owning connection, but future pack/export/import workers and other volumes still need explicit ownership of claims. RAM-only canonical buffers belong in a separate RAM budget, not filesystem `T`, unless they spill.

Profile A uses `R=32 MiB`: start with one maximum image-spool plus canonical construction unit (8+4 MiB), allow two such units (24 MiB), round to a power-of-two envelope of 32 MiB for retry/reopen bookkeeping. This is an engineering recovery allocation, not a proof that arbitrary recovery fits in 32 MiB. Profile A bounds normal operation main growth `G_tx<=32 MiB` and temp growth `T_tx<=16 MiB`, rather than presuming measured ratios cap them. The 32 MiB main-growth envelope starts from 8 MiB observer image + 4 MiB core + 4 MiB planned domain/head/index allowance, doubled. A planner must compute actual domain/head/index demand and reject or select a larger reviewed envelope if it cannot fit; 4 MiB metadata allowance is not a theorem. These growth budgets are additional constraints, potentially rejecting existing requests, and require instrumented storage tests before release.

For a first DELETE-only implementation propose conservative journal envelope `J_delete=2*B+1 MiB`, where `B=page_count*page_size` is the logical DB image **before** the operation, including pages currently only represented in WAL. This intentionally budgets preimages of the entire prior DB plus overhead, not just recently changed domain bytes. It is a candidate envelope requiring validation with the actual VFS, sector size, savepoints/spills and temporary files; do not assert it as a portable SQLite upper-bound theorem. The 1 MiB term is an explicit overhead margin. If instrumentation cannot establish the bound or temp budget, admission stays unavailable. `max_page_count` alone bounds neither journals nor temp files.

For WAL, `J_wal` must separately bound frames/spills/repeated page writes and checkpoint coexistence, based on a reviewed writer/checkpoint policy; `B` or core size alone does not bound WAL growth. Set `J_wal=UNKNOWN` until that work is verified. Profile A therefore proposes validating/pinning DELETE mode for activation; a pre-existing WAL database must be handled through a reviewed idle checkpoint/mode transition or rejected, not silently assigned DELETE assumptions. No journal-mode transition is authorized here.

Snapshot profile A: `G_capture<=128 MiB`, `T_capture<=64 MiB`, with the same dynamic `J` and `R`. The 128 MiB envelope starts from up to 32 MiB S bytes + up to 64 MiB total metadata budget + a 32 MiB page/index envelope; it is a hard proposed growth budget, not a measured amplification guarantee. The total metadata limit remains independent, so not all of that metadata need be new. The 64 MiB temp budget allows two image-size scratch units if file spills are introduced; current packer primarily uses memory. Pack must calculate remaining manifest/index/scratch demand and re-admit independently; it cannot spend capture's stale free-space observation. Ready snapshot presence still rejects a second non-aborted baseline.

**DERIVED / CALCULATED:** With profile A and M09's `B=317,501,440` bytes, `J=636,051,456`; ordinary write requirement before allocation-unit rounding is **719,937,536 bytes (686.586 MiB)**: 32 MiB floor + 32 MiB G + 16 MiB T + J. This conservative whole-DB envelope is costly even when the measured rollback journal was much smaller. With an empty synthetic v10 B=462,848, the same rule requires 85,860,352 bytes (81.883 MiB). It is not a constant 64 MiB floor for every DB.

### Platform capacity source

| Platform | Proposed API / existing repository capability | Failure and evidence needed |
|---|---|---|
| Windows | `GetDiskFreeSpaceExW`, use `lpFreeBytesAvailableToCaller` on the actual data-root volume; source already has Windows ownership FFI but no space-admission API/direct filesystem-space crate | Check return code, caller quota, UNC/reparse/mount resolution and u64 values. Unknown fails closed; investigate volume changes |
| Android | Existing Android-only `libc` dependency can support reviewed `statvfs`/`fstatvfs`; alternatively a native bridge to `StatFs.getAvailableBytes()` | `f_bavail * f_frsize`, checked; app-private volume/scoped-storage/quotas/reserved blocks and OEM behavior need device tests |
| Linux target, if supported | `statvfs`/`fstatvfs` on the opened root; no current direct non-Android libc declaration | Separate dependency/FFI review, `f_bavail` rather than total free, checked fragment-size multiplication, permissions/inodes/read-only/mount tests |

**SOURCE-CONFIRMED:** API semantics: [Microsoft GetDiskFreeSpaceExW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw), [Android StatFs](https://developer.android.com/reference/android/os/StatFs), [Linux statvfs](https://www.man7.org/linux/man-pages/man3/statvfs.3.html). No dependency was added. Available bytes are an observation, not a reservation against another process.

### Timing and failure behavior

Recheck before activation (including origin rotation/replay prerequisites), before each admitted domain transaction, before snapshot allocation/capture, before pack, and separately before future export/import staging. Hold the application's storage admission claim through COMMIT. Re-evaluate remaining demand at observable stage boundaries and check logical quotas again at finalization. Warn at logical or physical pressure before hard refusal, but a warning is not permission to cross a bound.

Capacity can disappear after any check. SQLite errors still require explicit rollback and transaction-state inspection. Publish success and invalidate/reread only after confirmed COMMIT. Map sanitized categories: `LogicalPayloadFull`, `LogicalMetadataFull`, `OperationTooLarge`, `SpaceUnknown`, `SpaceLow`, `StorageFull`, `StorageIo`, `CommitUncertain`, `RecoveryRequired`. Do not expose SQL/row content. Existing stage-specific errors can be retained internally; classification requires preserving SQLite numeric codes at appropriate boundaries in a later patch.

New replicated writes are blocked by logical/physical failure. Existing knowledge remains readable where the DB is healthy; snapshot/bootstrap and signer/export have separate availability. Unknown COMMIT outcome must not be reported as successful or blindly replayed: reopen/recover, inspect stable mutation/event identity, then resolve or require repair. Failed rollback poisons the owner; no further writes until validated recovery. No network access or signer is required to commit locally. No quota failure authorizes deleting history, resetting sequence, deleting a ready snapshot or downgrading the DB.

## 11. Quantified policy comparison

All proposed columns are **CANDIDATE — OWNER APPROVAL REQUIRED**. The reference is an architecture/test policy, not an approved production profile.

| Dimension | Reference: current logical candidate | A: bounded DELETE, recommended starting contract | B: larger physical envelopes, same logical limits |
|---|---|---|---|
| Local event / effects / deps / depth | 4 MiB / 4,096 / 256 / 16 | Same | Same |
| Image spool | 8 MiB | 8 MiB | 8 MiB |
| Retained payload / metadata | 256 / 64 MiB | 256 / 64 MiB; cache tracked separately | Same; no unsupported cap increase |
| Recovery free-space floor R | No filesystem check; `Some(0)` synthetic | 32 MiB plus dynamic operation budget | 64 MiB plus dynamic operation budget |
| Normal additional G / T | Unbounded physically | 32 / 16 MiB enforced budget | 64 / 32 MiB enforced budget |
| DELETE journal allowance | None | `2*B+1 MiB` pending VFS validation | Same conservative envelope |
| Snapshot S / growth G / scratch T | 32 MiB / unbounded / architecture reserve 64 MiB | 32 / 128 / 64 MiB plus R and J | 32 / 256 / 128 MiB plus R and J |
| Warnings | Architecture 80%, not implemented | Payload >=214,748,365 bytes, metadata >=53,687,092 bytes; physical F <2× required | Same logical warnings; physical F <2× required |
| Hard admission | Selected logical maxima only | Logical projected usage <= cap AND F>=required AND bounded growth fits | Same with larger envelopes |
| WAL amplification | Uncontrolled by logical counters | WAL unavailable until independent bounded policy; measured disabled-autocheckpoint accumulation is not a bound | Same, or separately approve a WAL policy; no automatic 2× assumption |
| M09 write requirement example | None physical | 719,937,536 bytes / 686.586 MiB | 803,823,616 bytes / 766.586 MiB |
| Existing operations | Some v9 requests already exceed dormant limits | Same logical refusals plus growth-budget refusal | Same logical refusals, fewer physical-growth rejections; higher free-capacity requirement |
| Recovery | Current rollback/poison guards; no guaranteed spare capacity | Keep R; explicit recover/retry and identity reconciliation | Larger R; same recovery semantics |
| Complexity | Existing dormant code only | New OS query, separate budgets, mode policy, growth planner/monitor, error mapping | Same machinery and greater space demand |
| Missing evidence | All physical admission | Worst-case dirty pages/temp growth, FULL at stages, Windows device/crash and Android/Linux | Same plus evidence justifying extra capacity on small devices |

**CANDIDATE — OWNER APPROVAL REQUIRED:** Recommend A for a separately reviewed implementation task, conditional on validating/enforcing every budget. B doubles A's discretionary R/G/T envelopes; this supplies more room for page/index variance but is an alternative margin, not measured necessity. Neither configuration may claim guaranteed durability on current evidence. Warn thresholds round upward to whole bytes; exactly fitting the projected hard cap can be admitted, but a larger next event is refused. Do not reserve physical capacity by reducing the logical metadata limit with `Limits.reserve`.

## 12. Failure and restart matrix

**SOURCE-CONFIRMED:** Existing kernel transactions own domain SQL, observation, core append, heads, cleanup and COMMIT. `rollback()` checks autocommit and explicitly rolls back where needed; failed rollback makes the owner unusable/read-only. Current fixed enum errors often lose low-level SQLite distinctions. SQLite documents that FULL/I/O errors may roll back either a statement or an entire transaction; callers must inspect state and roll back explicitly: [transaction error handling](https://sqlite.org/lang_transaction.html). Temporary/subjournal files are separate consumers: [SQLite temporary files](https://www.sqlite.org/tempfiles.html).

Rows distinguish current evidence from the **CANDIDATE — OWNER APPROVAL REQUIRED** error/user contract. “Prior state” means no committed domain/core/head/tip change when rollback is confirmed; it is not a power-loss guarantee.

| Scenario | Detection / error classification | Boundary; persistent state | Retry / user consequence | Current proof / missing evidence |
|---|---|---|---|---|
| Core >4 MiB | Encoded length; `BundleTooLarge` → OperationTooLarge | Owning tx rollback; prior state | Change request or approved larger policy; save failed | k14 native limits PASS; M04 demonstrates why 256 KiB is too low |
| Effects >4,096 | SQL context CHECK/native; EffectLimit | Statement failure then owner rollback; prior state | Bound domain request earlier; no partial batch success | k14 4,096 admitted/4,097 rejected PASS |
| Dependencies >256 | Reducer closure; IncompleteClosure | Entire tx rollback | Smaller reviewed request or new policy | k14 256/257 PASS |
| Spool >8 MiB | SQL CHECK/native; SpoolLimit | Entire tx rollback; prior state | Explicit oversize error, no omitted observations | k14 exact boundary/overflow PASS |
| Payload crosses 80% | Proposed projected logical counter | Warning only if hard admission passes | Warn once per pressure transition; retained data unchanged | Warning NOT IMPLEMENTED |
| Payload hard cap | `quota` PayloadQuota | Whole tx rollback; prior state | Save blocked; free capacity alone cannot cure logical retention | M09 real near-cap refusal; k14 PASS |
| Metadata cap | `quota`/cache estimates MetadataQuota | Activation abort or owning tx rollback | Distinguish persistent budget/cache; no history deletion | k14 and dependency-memory tests PASS; RSS not measured |
| Physical available space unknown | Proposed OS query/bounds failure; SpaceUnknown | Before domain mutation/activation; no new rows | Reads continue; retry after reliable capacity query | NOT IMPLEMENTED; platform tests missing |
| Physical space low before SQL | Proposed F<required; SpaceLow | No transaction published | Save blocked; explicit user storage action | NOT IMPLEMENTED |
| Space disappears during domain SQL | SQLite FULL / Store(Database) → StorageFull | Check transaction state, rollback; prior state if confirmed | No success; retry only after capacity/recovery | M12 pager FULL code13 PASS; actual filesystem FULL missing |
| FULL after domain, before append | SQLite/OS error; StorageFull | Roll back domain/effects/fence | Retry whole operation after safe recovery | k09 injected stage atomicity PASS; physical FULL NOT EXECUTED |
| FULL during bundle insert | BundleInsert internally; preserve code later | Whole tx rollback; no orphan save | Same | Injected stage PASS; physical FULL NOT EXECUTED |
| FULL or IOERR during COMMIT | Commit/SQLite code; CommitUncertain when outcome unresolved | Do not publish success; reopen may reveal all or none; reconcile event identity | No blind retry or fabricated sequence; repair if uncertain | Deferred constraint test PASS; COMMIT FULL/I/O/power-loss NOT EXECUTED |
| Snapshot logical/record/row/watchdog bound | Snapshot Limit/Timeout | Capture tx rollback; pending job intact, no partial ready image | Abort permitted pending job and retry new ID; journal saves independently admitted | s04/s05 PASS; max-device timing missing |
| Snapshot physical reserve insufficient | Proposed per-job SpaceLow | Reject capture/pack before work; no ready replacement | Snapshot/bootstrap unavailable; normal saves retain their own budget | NOT IMPLEMENTED; FULL capture/pack missing |
| Ready snapshot already exists | Snapshot Exists / SQL guards | Existing ready image intact | Owner must approve future retirement policy; no automatic deletion | s04 PASS, source guards; retirement NOT IMPLEMENTED |
| Pack interrupted/error | Immutable materialized rows + snapshot transaction | Prior materialized job retained; no partial ready publication | Retry pack/verify same image within budget | s06 PASS injected; disk/power-loss missing |
| WAL grows beyond expected envelope | Proposed mode/frame/file monitor | Reject new tx/jobs; finish or roll back current safely; do not unlink WAL | Reviewed checkpoint with no readers; storage action if blocked | M08/M11 observed growth; enforcement/pinned-reader evidence missing |
| Signer unavailable | Separate future signer admission | Local core and domain may commit within quota | Save continues; export unavailable | No signer in current local path; future envelope storage missing |
| No peer / no authenticated ACK | Retained payload counters | Backlog retained intact | Save until hard cap, then explicit blocked save | Source quota includes all bundles; no deletion/ACK implementation |
| Near cap, no ACK and snapshot too large | Separate payload and snapshot refusal | Both histories retained | Explain storage policy/action required; no promise snapshot can free space | M09 plus snapshot bounds; retirement owner decision pending |
| Restore older backup / new incarnation | Activation rotation + proposed space check | Old sealed streams retained; fresh incarnation only if init commits | Re-admit initialization; never renumber/reset old history | k02 restore PASS; physical restore/crash NOT EXECUTED |
| Restart after interrupted cleanup | SQLite recovery, then empty context/effects validation | Atomic rollback expected; unexpected committed transient rows → TransientState | Refuse writes; inspect/repair rather than blindly delete | k09/k10 injected PASS, M12 clean reopen; kill/hot-journal missing |
| Rollback itself fails | Explicit rollback + autocommit inspection; Rollback/RecoveryRequired | Owner poisoned; durable outcome untrusted | Healthy reads only via validated owner; explicit recovery before writes | Synthetic rollback-failure proof PASS; hardware fault missing |

## 13. Individually reviewable G4 decisions

Each decision below is **PROPOSED — OWNER APPROVAL PENDING** and **CANDIDATE — OWNER APPROVAL REQUIRED**. For every item: **Owner approval required: YES. Implementation authorized: NO.**

| ID | Proposal and recommendation | Evidence | Alternative / trade-off | Missing platform measurements |
|---|---|---|---|---|
| G4-01 | Retain local core 4 MiB; explicitly accept oversize refusal and require earlier planning | M04 329,917 bytes; k14 34/35 escaped Capture boundary | Larger reviewed ceiling increases RAM/disk; 256 KiB breaks existing valid atomic operation | Mobile encode/RSS/latency and large graph closure |
| G4-02 | 4,096 effects, 256 dependencies, depth16, 8 MiB image spool; bounded checked errors | Executed k14 boundaries; M04/M06/M09 actual spools | Larger budgets require SQL/codec/cache redesign; lower ones reject more requests | Actual typed review/expiry spool peak, temp files, target RAM |
| G4-03 | 256 MiB ALL retained canonical payload; warning at214,748,365 bytes; hard projected <=268,435,456 | M09 cap refusal and retained history | Larger cap requires code-policy review and replay/storage evidence; no ACK means finite offline writes | Near-cap restart replay/RSS/latency on target devices |
| G4-04 | 64 MiB persistent metadata, explicitly enforced also for snapshot-only jobs; separate64 MiB conservative cache budget as candidate, not their sum or RSS; physical reserve separate | `quota`, `stream` inspection; M10 seals; no-effects metadata gap in§3 | Shared combined budget is stricter and needs coordinated accounting; larger budget costs RAM/disk | High-origin/head/tombstone workload and real cache allocator overhead |
| G4-05 | Adopt §10 formula/profile A conditionally; unknown bounds fail closed; validate DELETE first | Logical/physical divergence, M08/M11, M12 | Profile B larger envelopes; WAL needs separate bound, not guessed multiplier | OS free queries, VFS dirty/temp bounds, quota/mount races and recovery allocation |
| G4-06 | Keep snapshot32 MiB/20k/256 KiB/2s candidate; propose G128/T64 MiB plus dynamic journal+R; separately re-admit pack | M08 duplication and pack timings; source ready immutability | Reference64 MiB not established sufficient; B G256/T128 costs capacity; no ready replacement without policy | Full32 MiB/20k image, manifest ceiling, low-end Android latency and FULL during capture/pack |
| G4-07 | Typed sanitized logical/space/FULL/I/O/uncertain/recovery errors; no success before COMMIT, no bypass | Kernel rollback checks, M12code13, injected tests | Blanket “save failed” hides repair vs retry; raw SQL errors leak data | Actual COMMIT/FULL/IOERR/kill/power loss; stable-identity retry reconciliation |
| G4-08 | Preserve local event atomicity; future authenticated bounded multi-frame staging of up to4 MiB, apply once after full verification | M04 >256 KiB; 1 MiB frame is separate candidate | Refuse export of large events until protocol exists; never silently split business transaction | Wire/signature overhead, receiver staging/free-space caps, interrupted-transfer recovery |
| G4-09 | Retain bundles/seals/tombstones/ready snapshot until explicit authenticated ACK coverage or retained authenticated bootstrap plus rebootstrap policy | Guarded immutable rows, M09 backlog, single-snapshot rule | Stop new writes at cap; future approved compaction can regain logical space, but pressure alone cannot authorize it | Authenticated peer/restore tests, retirement crash protocol, device capacity and owner policy |

## 14. Current gaps and prerequisite implementation work

**SOURCE-CONFIRMED:** No OS capacity query, physical reserve ownership, runtime growth budget, warning implementation, bounded WAL policy, unified persistent/cache/RSS accounting or production G4 profile exists. Current `Limits.reserve` is logically charged metadata. No signer/exporter/importer budget exists. Production v10 and live expiry scheduler remain dormant. Ready-snapshot retirement is absent.

**SOURCE-CONFIRMED:** Snapshot-only transactions also bypass finalizer metadata admission through the no-effects branch (§3). This source-confirmed resource-contract gap must be addressed in the next scoped enforcement task; Task14B does not repair frozen code or treat snapshot metadata as already universally capped.

**NOT MEASURED / PLATFORM EVIDENCE MISSING:** Full-scale snapshot envelope, all legal high-bound graph requests, typed-adapter spool bytes, peak allocations/RSS, near-cap restart replay and controlled filesystem failures at each stage are incomplete. Without a reviewed test VFS or capped volume and stage observation points, the frozen source cannot supply that evidence. The next task must add the test infrastructure deliberately; a second approximate implementation would not prove current kernel behavior.

**CANDIDATE — OWNER APPROVAL REQUIRED:** After individual decisions, implement separate logical/disk/RAM policy types, platform capacity provider, mode policy, checked budget planning/enforcement and sanitized error propagation in a separately scoped patch. First prove a finite bound or explicit fail-closed growth budget for each writer/snapshot stage; then add physical admission. Measurement ratios alone cannot supply that proof. Keep coordinated activation a later decision.

## 15. Platform follow-up evidence

All items are **NOT MEASURED / PLATFORM EVIDENCE MISSING** acceptance gates, not PASS:

| Platform / experiment | Required evidence before activation |
|---|---|
| Windows actual Arthur device | Capped VHD/test VFS; FULL before SQL, after SQL, append, COMMIT, capture and pack; IOERR and rollback failure; available-to-caller quotas; volume/reparse changes; allocation and simultaneous peak capture |
| Android target devices | App-private/scoped volume and available-block semantics; low-space/background/process death; fsync/rename/controller behavior; full32 MiB snapshot/20k records; cold replay near256 MiB; RAM and watchdog timing under real load |
| Linux, if a supported release target | Filesystem/mount/quota/inode/read-only handling, statvfs overflows, permission failures, rollback/WAL/temp growth and crash recovery |
| WAL policy, any platform | Pinned reader, checkpoint busy/starvation, repeated dirty-page spill, checkpoint simultaneous main/WAL allocation; safe idle recovery/mode transition |
| Durability | Child-process kill at barriers separately from hardware power cuts; verify domain/core/fence/head/tip all-or-none and immutable history preserved after reopen; no assumption destructor runs |
| Retention / export | Authenticated ACK coverage and rebootstrap semantics; framed oversized-core receive staging and retry; retirement crash safety; independently budget envelopes/importer/conflicts |

## 16. Regression evidence and next task boundary

**MEASURED:** Fresh commands from repository root, all in this task. Native prefix: `cargo ... --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml`. Test suffix: `-- --test-threads=1`.

| Command | Exit | Actual result |
|---|---:|---|
| `cargo check --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --all-targets` | 0 | PASS, warnings retained |
| `cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib storage::journal -- --test-threads=1` | 0 | 213 PASS, 0 FAIL |
| Same with `--lib storage::m05_v10_tests` | 0 | 24 PASS, 0 FAIL |
| Same with `--lib` and no filter | 101 | **1,137 PASS / 6 FAIL / 22 ignored**; differs from supplied historical1,138/5/22 |
| `npm run typecheck` | 0 | PASS |
| `npm run test:architecture` | 1 | 86 PASS / 2 historical FAIL |
| `npm run arthur:check` | 0 | 561 frontend tests /42 files PASS + production build PASS |
| Focus `storage::journal::storage_tests::k14_` | 0 | 4 selected PASS: native limits/quotas; raw effects4096/4097; dependency256/257/cache; exact spool/adapter overflow |
| Focus `storage::journal::storage_tests::k09_` | 0 | 2 selected PASS: all finalizer stages; counter/image/projection/read-failure rollback |
| Focus `storage::journal::storage_tests::k10_` | 0 | 1 selected PASS: deferred commit explicitly rolled back |
| Focus `storage::journal::storage_tests::k02_` | 0 | 2 selected PASS: cold/live activation and older synthetic disk restore |
| Focus `storage::journal::snapshot_tests::s04_`, `s05_`, `s06_`, `s08_` (four separate invocations) | 0 each | 1 selected PASS each: bounds/admission, interrupted capture, interrupted pack, incarnation rotation |

**MEASURED:** Exact focused test names and full outputs are in retained `regression/task14b-focus-*.log`; every filter selected at least one test. The relevant names are `k14_native_limits_quotas_size_and_exhaustion_roll_back`, `k14_raw_effect_4096_is_admitted_and_4097_rolls_back_every_capture`, `k14_dependency_256_admitted_257_rejected_and_context_memory_is_bounded`, `k14_exact_spool_boundary_adapter_and_real_domain_overflow_rollback`, `k09_every_finalizer_fault_rolls_back_domain_journal_tip_and_heads`, `k09_counter_drift_invalid_images_missing_projection_and_sql_read_failure_roll_back`, `k10_failed_deferred_commit_without_bundle_is_explicitly_rolled_back`, `k02_cold_activation_rotates_live_reuse_does_not_and_failed_init_rolls_back`, `k02_restored_older_synthetic_disk_uses_a_fresh_incarnation`, `s04_snapshot_bounds_and_admission_fail_closed`, `s05_interrupted_capture_recovers_through_abort_and_retry`, `s06_interrupted_pack_retries_without_losing_staged_rows`, `s08_cold_activation_seals_prior_incarnation_and_restarts_sequence`.

**MEASURED:** Five historical native failures recur unchanged by identity:

1. `jev::tests::the_real_transport_posts_json_with_a_bearer_header_and_never_leaks_the_key_in_errors`
2. `synthesis::architecture_tests::a_same_family_pass_is_wired_to_hold_for_review_and_the_shipped_verifier_is_not_called_independent`
3. `synthesis::architecture_tests::the_real_synthesis_endpoint_is_only_reachable_through_the_production_constructor`
4. `synthesis::eval::tests::the_corpus_is_frozen`
5. `synthesis::tests::the_commit_time_permission_check_includes_the_synthesis_authorizations`

**MEASURED:** Additional observed failure: `tts::service::tests::the_system_taking_audio_focus_ends_the_session_as_stopped_not_failed`; assertion at `tts/service.rs:667` expects zero audio files but finds one. Isolated exact rerun with `--lib tts::service::tests::the_system_taking_audio_focus_ends_the_session_as_stopped_not_failed -- --exact --test-threads=1` exits101, 0 PASS/1 FAIL. Its source was not changed and its cause was not established here. Do not call it a sixth historical failure or hide it behind the earlier baseline.

**MEASURED:** Architecture failures, separately: `schema v6: projects own captures and objects, and nothing else carries a project`; `voice output (M04.6): TTS goes through the provider and SecretStore layer, the audio is never persisted, and the schema is untouched`. No expectation or unrelated code was changed. Overall verification is **not all green**; these failures do not become storage-durability evidence.

**CANDIDATE — OWNER APPROVAL REQUIRED:** The next independently reviewed prompt should implement only approved G4 items and the storage-fault measurement prerequisite, with reversible synthetic fixtures first. It must not inherit activation, automatic expiry or retention authority from this evidence package.

## 17. Explicit no-activation statement

**SOURCE-CONFIRMED:** This task changes documentation only. Production schema remains v9 with registered steps1–9; no free-space API, limit change, scheduler, signer, importer, pairing, LAN, AutoSync or UI was added. No retained application history or existing application file was deleted. The newly created synthetic fixture databases remain inside the authorized disposable evidence artifact because automatic approval review rejected cleanup (“blocked by policy”); existing application files were not touched. No staging, commit, push, branch switch, merge, rebase, reset or PR operation was performed.

**CANDIDATE — OWNER APPROVAL REQUIRED:** G4 remains **OWNER APPROVAL REQUIRED / NOT ACTIVATED**. Live automatic-expiry policy, production scheduler wiring, platform crash/durability evidence, snapshot retirement, coordinated production v10 activation and future security/importer/network/UI work remain separate open gates. A decision package does not close them.


## Appendix A. Complete endpoint ledger

**MEASURED:** All numbers except `ms` are integer bytes/counts. `D/P/M/S` are logical domain, retained core payload, metadata excluding reserve, and staged row bytes. `DB/WAL/SHM/J` are simultaneous file lengths at the named stage. Elapsed ms is only the operation specified by that stage; zero means untimed, not zero duration. All pages are4,096 bytes. Primary M01–M04 repetitions use DELETE; WAL is explicitly experimental. Supplement M11/M12 are marked `sup`. Case construction, measurement method, limitations and reproduction are in sections5–7. Tables are not aggregate or transient peaks.

| Case / stage | Mode | Pages / free | DB / WAL / SHM / J bytes | D / P / M / S bytes | ms |
|---|---|---|---|---|---:|
| M01-M04-r0: empty_v9 | delete | 68 / 0 | 278528 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 0.000 |
| M01-M04-r0: empty_v10 | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 13.825 |
| M01-M04-r0: first_activation | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 10.992 |
| M01-M04-r0: 100_captures | delete | 205 / 0 | 839680 / 0 / 0 / 0 | 49261 / 122358 / 54620 / 0 | 1608.089 |
| M01-M04-r0: 12_objects | delete | 475 / 162 | 1945600 / 0 / 0 / 0 | 106943 / 453134 / 63438 / 0 | 0.000 |
| M01-M04-r1: empty_v9 | delete | 68 / 0 | 278528 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 0.000 |
| M01-M04-r1: empty_v10 | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 39.936 |
| M01-M04-r1: first_activation | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 233 / 0 | 23.526 |
| M01-M04-r1: 100_captures | delete | 205 / 0 | 839680 / 0 / 0 / 0 | 49255 / 122352 / 54619 / 0 | 1525.163 |
| M01-M04-r1: 12_objects | delete | 475 / 162 | 1945600 / 0 / 0 / 0 | 106933 / 453125 / 63438 / 0 | 0.000 |
| M01-M04-r2: empty_v9 | delete | 68 / 0 | 278528 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 0.000 |
| M01-M04-r2: empty_v10 | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 31.289 |
| M01-M04-r2: first_activation | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 12.670 |
| M01-M04-r2: 100_captures | delete | 205 / 0 | 839680 / 0 / 0 / 0 | 49260 / 122364 / 54627 / 0 | 2099.634 |
| M01-M04-r2: 12_objects | delete | 475 / 162 | 1945600 / 0 / 0 / 0 | 106937 / 453135 / 63445 / 0 | 0.000 |
| M05: seed | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 696 / 3001 / 1858 / 0 | 0.000 |
| M05: revision_251 | delete | 554 / 0 | 2269184 / 0 / 0 / 0 | 133340 / 1126787 / 184578 / 0 | 5054.615 |
| M05: revision_501 | delete | 990 / 0 | 4055040 / 0 / 0 / 0 | 266027 / 2251701 / 367305 / 0 | 12574.571 |
| M05: revision_751 | delete | 1420 / 0 | 5816320 / 0 / 0 / 0 | 398715 / 3376614 / 550030 / 0 | 21545.459 |
| M05: 1000_revisions | delete | 1848 / 0 | 7569408 / 0 / 0 / 0 | 530886 / 4497045 / 732024 / 0 | 31449.885 |
| M06: seed | delete | 126 / 5 | 516096 / 0 / 0 / 0 | 5467 / 14715 / 9053 / 0 | 0.000 |
| M06: replaced | delete | 130 / 2 | 532480 / 0 / 0 / 0 | 7127 / 38081 / 12350 / 0 | 0.000 |
| M07: before_expiry | delete | 214 / 0 | 876544 / 0 / 0 / 0 | 31659 / 202697 / 47745 / 0 | 0.000 |
| M07: after_expiry | delete | 321 / 45 | 1314816 / 0 / 0 / 0 | 49528 / 397009 / 68969 / 0 | 0.000 |
| M08-delete-r0: before_capture | delete | 1571 / 2 | 6434816 / 0 / 0 / 0 | 2584747 / 2804426 / 163498 / 0 | 0.000 |
| M08-delete-r0: materialized | delete | 3831 / 0 | 15691776 / 0 / 0 / 0 | 2584747 / 2804426 / 366456 / 8459501 | 825.215 |
| M08-delete-r0: ready | delete | 3862 / 0 | 15818752 / 0 / 0 / 0 | 2584747 / 2804426 / 495093 / 8459501 | 2614.545 |
| M08-delete-r1: before_capture | delete | 1573 / 2 | 6443008 / 0 / 0 / 0 | 2584744 / 2804418 / 163493 / 0 | 0.000 |
| M08-delete-r1: materialized | delete | 3832 / 0 | 15695872 / 0 / 0 / 0 | 2584744 / 2804418 / 366451 / 8459477 | 553.001 |
| M08-delete-r1: ready | delete | 3863 / 0 | 15822848 / 0 / 0 / 0 | 2584744 / 2804418 / 495083 / 8459477 | 2234.499 |
| M08-delete-r2: before_capture | delete | 1571 / 2 | 6434816 / 0 / 0 / 0 | 2584748 / 2804432 / 163503 / 0 | 0.000 |
| M08-delete-r2: materialized | delete | 3830 / 0 | 15687680 / 0 / 0 / 0 | 2584748 / 2804432 / 366461 / 8459519 | 557.131 |
| M08-delete-r2: ready | delete | 3861 / 0 | 15814656 / 0 / 0 / 0 | 2584748 / 2804432 / 495103 / 8459519 | 1961.816 |
| M08-wal-r0: before_capture | wal | 1571 / 2 | 278528 / 34006512 / 98304 / 0 | 2584731 / 2804413 / 163501 / 0 | 0.000 |
| M08-wal-r0: materialized | wal | 3830 / 0 | 278528 / 43350672 / 98304 / 0 | 2584731 / 2804413 / 366459 / 8459462 | 614.982 |
| M08-wal-r0: ready | wal | 3861 / 0 | 278528 / 43503112 / 98304 / 0 | 2584731 / 2804413 / 495099 / 8459462 | 1979.462 |
| M08-wal-r1: before_capture | wal | 1572 / 2 | 278528 / 34105392 / 98304 / 0 | 2584739 / 2804397 / 163477 / 0 | 0.000 |
| M08-wal-r1: materialized | wal | 3832 / 0 | 278528 / 43453672 / 98304 / 0 | 2584739 / 2804397 / 366435 / 8459414 | 569.386 |
| M08-wal-r1: ready | wal | 3863 / 0 | 278528 / 43606112 / 98304 / 0 | 2584739 / 2804397 / 495051 / 8459414 | 2121.285 |
| M08-wal-r2: before_capture | wal | 1572 / 2 | 278528 / 34121872 / 98304 / 0 | 2584743 / 2804415 / 163491 / 0 | 0.000 |
| M08-wal-r2: materialized | wal | 3831 / 0 | 278528 / 43466032 / 98304 / 0 | 2584743 / 2804415 / 366449 / 8459468 | 708.373 |
| M08-wal-r2: ready | wal | 3862 / 0 | 278528 / 43618472 / 98304 / 0 | 2584743 / 2804415 / 495079 / 8459468 | 2062.558 |
| M09: start | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 0.000 |
| M09: batch_8 | delete | 10518 / 1003 | 43081728 / 0 / 0 / 0 | 5468344 / 32720015 / 70058 / 0 | 7353.916 |
| M09: batch_16 | delete | 19921 / 1003 | 81596416 / 0 / 0 / 0 | 10936608 / 65440038 / 139882 / 0 | 15558.509 |
| M09: batch_24 | delete | 29324 / 1003 | 120111104 / 0 / 0 / 0 | 16404863 / 98160050 / 209703 / 0 | 23983.529 |
| M09: batch_32 | delete | 38725 / 1003 | 158617600 / 0 / 0 / 0 | 21873119 / 130880066 / 279527 / 0 | 32872.583 |
| M09: batch_40 | delete | 48128 / 1003 | 197132288 / 0 / 0 / 0 | 27341377 / 163600082 / 349349 / 0 | 42138.555 |
| M09: batch_48 | delete | 57532 / 1003 | 235651072 / 0 / 0 / 0 | 32809625 / 196320090 / 419173 / 0 | 51897.371 |
| M09: batch_56 | delete | 66936 / 1003 | 274169856 / 0 / 0 / 0 | 38277878 / 229040103 / 488997 / 0 | 62030.922 |
| M09: batch_64 | delete | 76339 / 1003 | 312684544 / 0 / 0 / 0 | 43746143 / 261760128 / 558821 / 0 | 72898.582 |
| M09: final | delete | 77515 / 1003 | 317501440 / 0 / 0 / 0 | 44429676 / 265850131 / 567549 / 0 | 75129.649 |
| M10: before | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 0 / 0 | 0.000 |
| M10: 100_activations | delete | 120 / 0 | 491520 / 0 / 0 / 0 | 81 / 0 / 17444 / 0 | 393.212 |
| M12: before | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 0.000 |
| M12: after_failure | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 0.000 |
| M11 sup: before_reuse | wal | 384 / 162 | 1572864 / 0 / 32768 / 0 | 57756 / 330764 / 9053 / 0 | 0.000 |
| M11 sup: after_100_reuse | wal | 384 / 89 | 1572864 / 8520192 / 32768 / 0 | 93935 / 440130 / 63444 / 0 | 270.380 |
| M11 sup: after_passive | wal | 384 / 89 | 1572864 / 8520192 / 32768 / 0 | 93935 / 440130 / 63444 / 0 | 0.000 |
| M11 sup: after_truncate | wal | 384 / 89 | 1572864 / 0 / 32768 / 0 | 93935 / 440130 / 63444 / 0 | 0.000 |
| M12 sup: before | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 0.000 |
| M12 sup: after_failure | delete | 113 / 0 | 462848 / 0 / 0 / 0 | 81 / 0 / 234 / 0 | 0.000 |

## Appendix B. Sampled primary file-length maxima

**MEASURED:** Per-file observed maxima throughout each fixture's lifetime, 20ms nominal polling. The fixture can span multiple M01–M04 stages. Values for different files may occur at different instants. `0` means no nonzero observation, not proof no transient file existed. Final allocated main-file sizes in `allocation-endpoints.json` equal final main lengths. Primary allocation peaks and exact instantaneous file peaks remain NOT MEASURED. Supplement has endpoint observations only. A separate fresh-runner M12 smoke run exercised FileStandardInfo polling: observed journal length16,928bytes versus AllocationSize20,480bytes, illustrating the distinction; DB length/allocation462,848bytes. Its whole fixture took305.577ms and exited0; these are separate observations, not retroactive corrections to primary peaks.

| Primary fixture | DB maximum | WAL maximum | SHM maximum | Rollback-journal maximum |
|---|---:|---:|---:|---:|
| M01-M04-r0 | 1945600 | 0 | 0 | 156464 |
| M01-M04-r1 | 1945600 | 0 | 0 | 156464 |
| M01-M04-r2 | 1945600 | 0 | 0 | 156464 |
| M05 | 7569408 | 0 | 0 | 230336 |
| M06 | 532480 | 0 | 0 | 127736 |
| M07 | 1314816 | 0 | 0 | 127736 |
| M08-delete-r0 | 15818752 | 0 | 0 | 131840 |
| M08-delete-r1 | 15822848 | 0 | 0 | 140048 |
| M08-delete-r2 | 15814656 | 0 | 0 | 131840 |
| M08-wal-r0 | 15814656 | 43503112 | 98304 | 8720 |
| M08-wal-r1 | 15822848 | 43606112 | 98304 | 4612 |
| M08-wal-r2 | 15818752 | 43618472 | 98304 | 8720 |
| M09 | 317501440 | 0 | 0 | 391208 |
| M10 | 491520 | 0 | 0 | 25136 |
| M12 | 462848 | 0 | 0 | 21032 |

## Appendix C. Adapter-core attribution

**MEASURED:** Core lengths/raw effects are from actual persisted M07 bundles; `m07-adapter-ledger.json` enumerates all76 records. Read-only SQLite extraction records lengths and counts, not a re-encoded approximation. Claims:2,720–2,726bytes,2 raw effects/2 operations/3dependencies. Proposals:2,381–2,386bytes,1effect/1operation/3dependencies. Approval:9,329bytes/6effects/6operations/7dependencies. Rejection:3,915/1/1/3. User-separate:7,621/6/5/6. Expiry32:194,312/191/159/67. These are one fixture's observed values, not operation maxima. Typed adapter spool bytes remain NOT MEASURED. M04 repeated operation duration82.062–125.709ms and core329,913–329,917bytes; fixed fixture text sizes, UUID/timestamp length variation.
