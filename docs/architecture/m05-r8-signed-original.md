# M05 R8 — SignedOriginal end-to-end

Дата: 2026-11-04, Europe/Sofia. Изолирана native qualification; без production activation или независима security approval.

## A. Git preflight

Branch: `feature/nodes-integration`. Начален HEAD: `4a4f046d6068a27e4e137720819252f33208269d` (`test(sync): qualify physical Windows Android LAN sync`). Началното дърво беше чисто. Branch/HEAD/status/log/diff бяха проверени преди промените. R8 забранява stage, commit, push, merge, rebase и PR.

## B. Exact integration design

```text
committed canonical journal core, existing owner
 -> SignedImportStore::export_signed
 -> real OS author identity + persistent canonical SignedOriginal
 -> existing SyncEngine, negotiated signed profile
 -> one bounded SignedMetadata + existing Chunk messages
 -> existing pinned mutual TLS 1.3 / AE01 transport
 -> exact Identity + bounded canonical reassembly
 -> SignedImportStore::retain_signed -> existing retain_in
 -> verified registry/origin/signature/chain/G3-D4 policy
 -> same IMMEDIATE transaction: domain + original + seal + proof + cursors
 -> receipt after successful COMMIT and cleanup
```

Няма втори engine, transport, SQLite owner, import ledger, journal format, runtime или crypto algorithm. Engine не замества atomic author verifier. Dependency direction остава `sync -> sync_api <- storage`.

Десетте предварителни архитектурни отговора: (1) committed core/import ledger са истината; (2) един owner притежава транзакцията и OS binding; (3) shared typed port пази dependency direction; (4) explicit candidate profile; (5) typed fail-closed outcomes; (6) persistent signatures и bounded session state; (7) disposable real owners/keys/TLS и отделни evidence classes; (8) additive qualification SQL без historical migration; (9) categorical diagnostics без private-key/raw-knowledge logging; (10) registry/permissions преди COMMIT, без G5 или activation bypass.

## C. Files changed

Точните repository-relative пътища и diff спрямо началния HEAD са по-долу; новите untracked файлове са включени.

| Файл | Добавени/изтрити редове | Състояние |
| --- | --- | --- |
| `apps/arthur/src-tauri/gen/android/app/src/androidTest/java/dev/kaloyan/arthur/security/CrossDeviceSyncTest.java` | +1/-0 | modified |
| `apps/arthur/src-tauri/gen/android/qualification-network/src/androidTest/java/dev/kaloyan/arthur/security/NativeIdentityBridgeTest.java` | +1/-0 | modified |
| `apps/arthur/src-tauri/gen/android/verify-cross-device.ps1` | +23/-3 | modified |
| `apps/arthur/src-tauri/src/storage/enrollment_store.rs` | +54/-0 | modified |
| `apps/arthur/src-tauri/src/storage/layering_tests.rs` | +4/-0 | modified |
| `apps/arthur/src-tauri/src/storage/journal/cross_device_qualification.rs` | +185/-15 | modified |
| `apps/arthur/src-tauri/src/storage/mod.rs` | +3/-0 | modified |
| `apps/arthur/src-tauri/src/storage/security_android_instrumentation.rs` | +1/-1 | modified |
| `apps/arthur/src-tauri/src/storage/signed_import.rs` | +381/-3 | modified |
| `apps/arthur/src-tauri/src/storage/sync_store.rs` | +45/-1 | modified |
| `apps/arthur/src-tauri/src/sync/engine.rs` | +95/-15 | modified |
| `apps/arthur/src-tauri/src/sync/security/tls_socket_lab.rs` | +1/-0 | modified |
| `apps/arthur/src-tauri/src/sync/trust.rs` | +64/-0 | modified |
| `apps/arthur/src-tauri/src/sync_api/ports.rs` | +22/-0 | modified |
| `apps/arthur/src-tauri/src/sync_api/protocol.rs` | +46/-0 | modified |
| `apps/arthur/src-tauri/src/sync_api/validation.rs` | +3/-0 | modified |
| `apps/arthur/src-tauri/src/storage/signed_profile_candidate.sql` | +16/-0 | new |
| `apps/arthur/src-tauri/src/storage/signed_profile_fault_tests.rs` | +845/-0 | new |
| `apps/arthur/src-tauri/src/storage/signed_sync_tests.rs` | +665/-0 | new |
| `docs/architecture/m05-r8-signed-original.md` | +238/-0 | new |

Код, SQL и тестове: **19 файла, +2455/-38 реда**. С доклада: 20 файла. Няма промени в Cargo manifest/lock, CI, frontend, production permissions, historical migrations, canonical codec/reducer или `signed.rs`.

## D. Signing ownership

Export прочита committed original през existing store port и отново сравнява exact identity/core под owner write transaction. Verified registry свързва origin с author public key; `bound_key` проверява действителния локален CNG/Keystore key. Използват се existing `SignedOriginal::sign/bytes/decode/verify`. Не се подписва преди journal COMMIT и private key не влиза в SQLite.

Новият immutable FK cache `e2_export_signatures` пази само signatures за committed local `sync_bundles`: максимум 256, всяка 1–16384 bytes. Retry/reopen връща същите bytes въпреки randomized ECDSA. Foreign export изисква verified accepted prefix и запазения author signature от `e2_originals`; forwarder не re-sign-ва. Третият peer проверява original author, различен от TLS peer.

Windows fixtures използват истински CNG keys и sockets/TLS, disposable synthetic data и signed registry configuration. Отделен ephemeral CNG admin подписва genesis/grants, а всеки endpoint pin-ва public history със собствения OS key. Това е изрично fixture trust, без pairing или автоматично TLS-to-membership conversion. Няма embedded private keys или exported private keys.

## E. Wire and capability behavior

Scoped extension: `m05-signed-original-candidate-v1`, Hello version **2**, feature mask **47**. Legacy R7 остава `m05-ledger-candidate`, version **1**, features **31**. Profile/version/required-capability mismatch връща `Protocol`.

Една `SignedMetadata` предхожда chunks; exact Identity се проверява през целия assembly. Metadata е 1–16384 bytes, максимум две metadata/assembly позиции. Дублирана/липсваща/inconsistent metadata отказва. Incomplete core остава Syncing без publication/ACK; error/cancel изчиства buffers. Existing frame/chunk/queue/event/deadline limits не са увеличавани.

Signed profile отказва всички unsigned snapshot variants и bootstrap entrypoint с `Protocol`. Legacy profile отказва SignedMetadata. Няма unsigned fallback, snapshot bypass или release-format approval.

## F. Atomic signed import

`RegistryTrust` е само test/Android debug qualification producer с exact Hello/root/epoch/network/endpoints. `TestTrust` без registry binding отказва signed summary/ingress. Existing registry verifier проверява подписаната история и projections; TLS possession само по себе си не е membership или author authorization.

Existing `CandidateSyncStore::write` държи един IMMEDIATE transaction и owner lock. Преди работа и отново непосредствено преди COMMIT проверява актуалния registry root, local/remote membership, expiry/capabilities и durable origin permissions. `retain_in` проверява author/origin ownership, signature, exact core/hash, incarnation/sequence и previous hash. Domain effects, import proof/progress, original signature и локалният OS-signed accepted seal се commit-ват заедно.

Legacy retain запазва refresh behavior. Signed retain класифицира само текущия original; не promote-ва други unsigned deferred cores. `e2_pending_signatures` пази bounded signature evidence за core в същия import ledger, без второ event body/outcome/cursor. Signed settle повтаря full verifier преди domain/seal promotion.

Unsupported history остава в existing bounded quarantine, без accepted seal/applied cursor. Verified quarantine lookup спира безкрайното повторно заявяване, без forwarding на quarantine като accepted history. Missing predecessor не се измисля; explicit exact retry след predecessor може да успее. Не се твърди автоматична реконструкция на липсваща sequence history.

**Contract incompatibility, спрян subpath:** `enrollment_e2.sql` има един seal с PK(origin), UNIQUE incarnation, `e2_originals UNIQUE(origin,seq)` и prefix verifier за една incarnation/позиции 1..256. Genuine нов JournalKernel incarnation след стар seal е `UnsupportedImportPolicy`; старите proofs/seals остават. Нужен е owner-reviewed multi-incarnation contract/schema decision. Frozen schema не е променяна за принудителен успех. Retry/reopen на вече committed originals работи.

Receipt се връща след COMMIT и cleanup. `CommitUncertain` изисква reconciliation/reopen. `CommittedCleanupFailed` запазва факта на успешния COMMIT и отказва ACK; не се представя като rollback. G4 остава UnverifiedBounds; G5 не получава actor authorization.

## G. Test matrix

Dedicated модул: **16 PASS /0 FAIL /0 ignored**, 85.30 s, Windows. Използва actual engine/TLS/importer; adversarial messages минават през receiving engine. Owner reopen е в същия Windows test process, не физически process restart.

| ID | Evidence class | Доказателство / граница |
| --- | --- | --- |
| S01 | PASS — EXECUTED ON WINDOWS | Истински CNG author, committed original, stable persistent signature. |
| S02 | NOT EXECUTED — ENVIRONMENT UNAVAILABLE | Keystore signed export е имплементиран и ARM64/x86_64 build-нат; няма R8 Android runtime. |
| S03 | PASS — EXECUTED ON WINDOWS | Strict canonical SignedOriginal round-trip. |
| S04 | PASS — EXECUTED ON WINDOWS | Exact metadata/Identity/chunks; missing/partial/duplicate/oversize откази. |
| S05 | PASS — EXECUTED ON WINDOWS | Random/swapped signatures отказват през TLS engine. |
| S06 | PASS — EXECUTED ON WINDOWS | Wrong author, unregistered signer и registered друг signer отказват. |
| S07 | PASS — EXECUTED ON WINDOWS | Wrong-network signed body отказва. |
| S08 | PASS — EXECUTED ON WINDOWS | Tampered origin/incarnation отказват; genuine нов incarnation остава Unsupported. |
| S09 | PASS — EXECUTED ON WINDOWS | Core/hash/canonical metadata tampering отказва преди publication. |
| S10 | PASS — EXECUTED ON WINDOWS | Journal -> signed export -> mutual TLS -> engine -> atomic signed import. |
| S11 | PASS — EXECUTED ON WINDOWS | И двата owners reopen; exact original signatures/provenance остават. |
| S12 | PASS — EXECUTED ON WINDOWS | Lost ACK/retry: offered delivery остава pending, после точно 3 originals/2 captures без duplicates. |
| S13 | PASS — EXECUTED ON WINDOWS | Трети CNG peer получава непроменения A signature през B, без re-sign. |
| S14 | PASS — EXECUTED ON WINDOWS | Missing predecessor: quarantine/no seal/no applied; exact retry след predecessor успява. |
| S15 | PASS — EXECUTED ON WINDOWS | Signed registry revocation и отделна origin permission mutation след TLS отказват. |
| S16 | PASS — EXECUTED ON WINDOWS | Actual deferred-FK COMMIT failure, no applied ACK/proof/domain transition. |
| S17 | PASS — EXECUTED ON WINDOWS | CommitUncertain се запазва; reopen/retry reconciles. |
| S18 | PASS — EXECUTED ON WINDOWS | Actual G4 post-COMMIT restore fault: committed evidence остава, ACK липсва; retry е idempotent. |
| S19 | PASS — EXECUTED ON WINDOWS | Downgrade/profile mixing/unsigned snapshot отказват. |
| S20 | PASS — EXECUTED ON WINDOWS | Valid signed review не одобрява proposal; local heads остават, attention=true. |
| S21 | PASS — EXECUTED ON WINDOWS | Existing R7 native/TLS regressions PASS в пълния run; R7 physical остава исторически unsigned evidence. |
| S22 | PASS — EXECUTED ON WINDOWS | Schema9/STEPS9, production ActivationPending, ClosedTrust/ClosedLan отказват. |

Deferred-child тестът проверява, че corrupt retained signature не се promote-ва покрай parent import; reconnect с истински original възстановява разрешеното състояние. Actual TLS от unregistered peer не може да започне signed engine или да прочете inventory. Нито един Windows test не е обозначен като Android hardware evidence.

## H. Security negative results

| Вход / fault | Точен outcome и запазена граница |
| --- | --- |
| Random/swapped signature; wrong author/network; unregistered signer | `Trust`; no unauthorized publication/proof/seal/applied cursor/ACK. |
| Измислен origin | `Trust` преди core import. |
| Incarnation/core/hash mismatch; noncanonical whitespace; unknown/duplicate fields | `Integrity`; no publication/receipt. |
| Същият event ID с различен валидно CNG-подписан core | `Integrity`; accepted history/signatures не се заменят. |
| Missing/duplicate metadata; profile mismatch; unsigned snapshot | `Protocol`; no applied ACK. |
| Empty/oversize metadata или трети assembly | `Limit`; без увеличени ceilings. |
| Metadata без всички chunks | `Syncing`, без partial publication/seal/ACK. |
| Revoked registry/disabled origin permission след TLS | `Trust` или transport `Cancelled`; no publication. |
| Missing prefix/genuine нов incarnation | `UnsupportedImportPolicy`, quarantine/attention, без old-seal overwrite. |
| Corrupt deferred signature | `Trust` при signed settle; child не се прилага unsigned. |
| Failed COMMIT | `CommitUncertain`; no ACK и no persisted original/proof за отказалата транзакция. |
| COMMIT success + cleanup fault | `CommittedCleanupFailed`; durable evidence остава, sender offer чака reconciliation. |
| Signed approval/foreign head без G5 permission | Няма silent approval или local-head replacement; attention остава. |

Red/green: source capability първо FAIL `Protocol`, после PASS; same-ID collision първо връщаше Unsupported, после exact `Integrity`; G5 quarantine discovery първо циклираше до timeout, после quiesces за 2.95 s без увеличени лимити. Initial test-audit deadlock беше спрян/поправен; interrupted run не е PASS. Окончателният 16/16 е след поправките. Логове: `arthur-r8-source-before/after.log`, `arthur-r8-collision-before.log`, `arthur-r8-targeted-v3.log`, `arthur-r8-g5-after.log`, `arthur-r8-targeted-final.log`.

Existing E2 `e2_16_rejected_fork_does_not_seal_a_prefix` отделно проверява validly signed different event на същата origin/incarnation/sequence: `RejectedIntegrity`, без seal или domain overwrite. Това е existing direct-store evidence, не нов TLS scenario.

Първият comprehensive run откри липсваща explicit qualification registration за новия test fixture. Поправката добавя точно двата нови файла и проверява точната `#[cfg(test)] #[cfg(windows)]` declaration/inherited parent в existing allow-list; production assertions не са променени. Първият full run е **1478 PASS /1 FAIL /26 ignored**, 688.41 s, Cargo101; единственият failure е `storage::layering_tests::production_storage_and_sync_have_no_cross_imports`. Пази се в `arthur-r8-native-registration-red.log` и съответния result JSON. Focused correction е **3 PASS /0 FAIL**, 0.12 s (`arthur-r8-layering-after.log`). Преждевременен focused rebuild срещна Windows `LNK1104`, защото първият native test executable още работеше; това е failed build attempt, не test PASS. Следващите native builds/runs са последователни.

Self-review не намери оставащ blocker в проверения write/security/ownership path. Incarnation incompatibility и непроверените platform/release граници остават изрично отворени. Това е same-agent review, не независим криптографски одит. Existing assertions не са отслабвани.

## I. Regression

Всички Cargo команди по-долу са от root с `--manifest-path apps/arthur/src-tauri/Cargo.toml`. Check/test/clippy използват `--locked --offline`. Evidence е в локалния `%TEMP%`, без Git artifacts.

| Изпълнена команда / gate | Exit | Резултат / лог |
| --- | --- | --- |
| `cargo check --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --all-targets` | 0 | PASS, 9.29 s; `arthur-r8-check-final.log`. |
| `cargo fmt --manifest-path apps/arthur/src-tauri/Cargo.toml -- --check` | 0 | PASS; `arthur-r8-fmt-final.log`. |
| `cargo clippy --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- -D clippy::all` | 0 | PASS за точния gate; 496 rustc warnings остават, не се твърди `-D warnings`; `arthur-r8-clippy-final.log`. |
| `cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib storage::signed_sync_tests -- --test-threads=1` | 0 | 16 PASS /0 FAIL /0 ignored, 85.30 s; `arthur-r8-targeted-final.log`. |
| `cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib e2_ -- --test-threads=1` | 0 | 22 PASS /0 FAIL /1 ignored; `arthur-r8-e2-regression.log`. |
| `cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- --test-threads=1` | 0 | **1479 PASS /0 FAIL /26 ignored**, 611.76 s; `arthur-r8-native-final.log` и durable `arthur-r8-native-final-result.json`. |
| `npm run test:architecture` | 0 | 88 PASS /0 FAIL, 2416.38 ms; `arthur-r8-architecture-final.log`; existing assertions непроменени. |
| `npm run arthur:check` | 0 | 561 PASS /42 files, typecheck/Vite production web build PASS; `arthur-r8-frontend-final.log`; bundle-size warning остава. |
| `src/sync/security/qualification/verify-isolation.ps1 -OutputDirectory $env:TEMP/arthur-r8-isolation` | 0 | 6/6 graph controls: Windows, x86_64 Android, ARM64 Android, default и qualification. |
| `gen/android/test-qualification.ps1` | 0 | 33 host checks, synthetic device facts. |
| PS Parser `verify-cross-device.ps1` | 0 | PASS syntax. |
| `verify-identity.ps1 -Target aarch64 -BuildOnly` | 0 | Actual Rust/Java/Kotlin/Gradle APK + ABI/package/JNI inspection PASS; `arthur-r8-arm64-build.log`. |
| `verify-network.ps1 -Target aarch64 -BuildOnly` | 0 | Standalone qualification APKs PASS; no release variant; `arthur-r8-network-build.log`. |
| `verify-identity.ps1 -Target x86_64 -BuildOnly` | 0 | Emulator ABI build PASS; `arthur-r8-x86-build.log`. |
| `verify-network.ps1 -Target x86_64 -BuildOnly` | 0 | Network APKs PASS; `arthur-r8-network-x86-build.log`. |
| Default `npm run tauri -- android build --debug --target aarch64 --apk --ci` от `apps/arthur` | 0 | Ordinary ARM64 APK PASS; `arthur-r8-default-android.log`. |
| Actual default APK `apkanalyzer` + extracted library `llvm-nm` | 0 | Ordinary package `dev.kaloyan.arthur`; INTERNET/RECORD_AUDIO/app dynamic-receiver permissions only; без LAN/network-state permissions; точно install/networkChanged security JNI, без test/restart exports. |
| R8 Android runtime/emulator/physical | — | UNVERIFIED; BuildOnly не инсталира/изпълнява. |
| Signed release artifact / packaged smoke | — | UNVERIFIED; debug APK не доказва release readiness. |

Финалният full run е след qualification-registration correction; 16/16 R8 и 3/3 layering PASS са част от него. Локален R7 baseline: 1463/0/26; R8: **1479/0/26**, +16 tests. Overlapping subsets от същия лог: `r1_tls_` 10, `r2_` 6, `r3_` 6, `r4_` 6, `r5_` 11, `r6_` 10, `r7_` 3, `m05_v10_tests::` 24 PASS; не са допълнителни executions. Hosted-failing maximum-bootstrap test е PASS и в двата локални R8 full runs. Последният fmt/clippy повторен check след регистрацията също е exit0 (Clippy 5.53 s).

**R7 hosted CI — отделен baseline failure:** [M05 regression gates 41780478549](https://github.com/Kaloyan3D/A.R.T.H.U.R/actions/runs/41780478549) за началния `4a4f046...` е FAILURE. Native: **1462 PASS /1 FAIL /26 ignored**, 983.20 s. Exact failed test: `sync::tests::r1::history::r6::r6_tls_bootstrap_maximum_native_event_and_row_counts`; `storage/sync_history_tls_tests.rs:61` връща `SnapshotTooLarge` при bootstrap. Hosted check/fmt/clippy са PASS; architecture/frontend/isolation след него са skipped.

Предишният локален R7 резултат 1463/0/26, physical 49 instrumentation +1+1 restart и 4 network probes са исторически, не R8 evidence или hosted PASS. Петсекундният bootstrap guard може да зависи от натоварването, но причината не е доказана; лимити/timeouts/maximum fixture/assertions не са увеличавани/отслабвани. R8 не променя bootstrap implementation; signed profile отказва snapshots. Няма hosted R8 run, защото няма commit/push. Baseline CI failure не е waived.

## J. Physical testing readiness

Физически R8: **NOT EXECUTED — DEVICE UNAVAILABLE**. `adb devices` е празен. Няма R8 emulator runtime. R7 S22 direct-LAN резултатът е валиден само за тогавашния unsigned Envelope/mutual-TLS scope.

Runner има изричен `-SignedOriginal`: public signed registry се provision-ва с existing test dispatcher case49; същите native TLS/route/owner checks и lost-ACK/restart phases се използват повторно. Profile, author/signature bytes, accepted seals, 3 originals/2 captures, proof/cursor parity и pending receipts 2 -> 0 се сравняват. Physical mode няма ADB reverse; USB е control/public fixtures/results канал. Няма production dispatcher/enrollment.

Reproduction от repository root след USB authorization и текущи изрично разрешени private IPv4 addresses; вече инсталираният toolchain:

```powershell
$env:JAVA_HOME = 'C:/Program Files/Java/jdk-25.0.2'
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME/ndk/29.0.14206865"
$serial = Read-Host 'Authorized ARM64 phone ADB serial'
$windowsLan = Read-Host 'Explicitly permitted Windows private IPv4'
$androidLan = Read-Host 'Explicitly permitted phone private IPv4'
& "$env:ANDROID_HOME/platform-tools/adb.exe" devices
& ./apps/arthur/src-tauri/gen/android/verify-identity.ps1 -Target aarch64 -Serial $serial
& ./apps/arthur/src-tauri/gen/android/verify-network.ps1 -Target aarch64 -Serial $serial
& ./apps/arthur/src-tauri/gen/android/verify-cross-device.ps1 -Serial $serial `
    -Physical -SignedOriginal -LanAddress $windowsLan -AndroidAddress $androidLan
# Отделен legacy R7 regression със същите qualification APKs:
& ./apps/arthur/src-tauri/gen/android/verify-cross-device.ps1 -Serial $serial `
    -Physical -LanAddress $windowsLan -AndroidAddress $androidLan
```

Identity build е преди network build за същия ABI; standalone project преизползва qualification `.so` и заменя само dedicated `.identitytest` package. Windows interface трябва вече да е Private; runner не променя profile/firewall. След ordinary build qualification трябва да се rebuild-не, понеже native-library symlink вече сочи default `.so`. Emulator reproduction е със същите скриптове, `-Target x86_64`, explicit emulator serial и `-SignedOriginal` без `-Physical`; това е ADB-mediated loopback, не physical LAN.

Възстановяване на ordinary build след qualification, без feature/config:

```powershell
$bin = "$env:NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64/bin"
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$bin/aarch64-linux-android24-clang.cmd"
$env:CC_aarch64_linux_android = $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
$env:AR_aarch64_linux_android = "$bin/llvm-ar.exe"
Push-Location apps/arthur
try { npm run tauri -- android build --debug --target aarch64 --apk --ci }
finally { Pop-Location }
```

Това са reproduction инструкции, не physical execution report. В R8 са изпълнени само BuildOnly и ordinary build; APK не е инсталиран.

## K. Open production gates

- **N1:** existing locked PAKE/crypto-bigint advisory и независим composition audit остават unresolved/unapproved. Без dependency override, suppression или PAKE replacement.
- **G4:** UnverifiedBounds; candidate budgets/fault evidence не са approved worst-case disk/WAL/scratch/staging/recovery bounds на всички платформи.
- **G5:** липсва approved historical actor/approval/foreign-head contract. Valid author signature не е local review permission.
- **Platform/release:** physical R8 Keystore/direct LAN, API37 policy acceptance, signed release packaging/clean smoke и N2/N3/N7/G3–G7 decisions.
- **Incarnation:** E2 multi-incarnation contract/schema decision от §F.
- **Activation:** schema9/STEPS1..9, ClosedTrust/ClosedLan, `SignedImportStore::production -> ActivationPending` остават. Без production JournalKernel/SyncNow/listener/AutoSync/background/live enrollment/v10.

## L. Git integrity

Изпълнени след native regression: `git diff --stat`, `git diff --check`, `git status --short --branch`, `git diff --cached --name-only`, `git rev-parse HEAD`. Diff whitespace PASS; index е празен. Branch/HEAD остават `feature/nodes-integration` / `4a4f046d6068a27e4e137720819252f33208269d`. Работното дърво съдържа само тези task промени: 16 modified +4 untracked, всички unstaged.

`git diff --stat` за tracked файловете: **16 files, +929/-38**. С четирите untracked файла: **20 файла, +2693/-38**; този доклад е 238 реда. Няма stage, commit, push, merge, rebase или PR. Generated Gradle suffix е възстановен byte-for-byte от qualification helper-а; ordinary build е без identity feature. Protected migrations/schema/crypto/Cargo/production entrypoints/manifests/generated configuration имат нулев diff. Test DBs/keys/APKs/raw logs не са Git files.

## M. FINAL VERDICT

**R8 SIGNED ORIGINAL — IMPLEMENTED, PHYSICAL VALIDATION PENDING**

Свързаният signed path е имплементиран и проверен с real Windows CNG/TLS/SQLite и пълния локален regression. Android ARM64/x86_64 build evidence е PASS. Физически R8: **NOT EXECUTED — DEVICE UNAVAILABLE**. Incarnation contract decision, R7 hosted CI failure и production gates от §K остават отворени; M05 production readiness не се заявява.
