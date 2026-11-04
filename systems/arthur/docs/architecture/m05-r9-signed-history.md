# M05 R9 — Signed Historical Bootstrap & Recovery

Инженерен доклад на български; 2026-11-04, Europe/Sofia. Резултатите са за локалния R9 working tree; hosted R8 не е hosted R9.

## A. Състояние на repository

Първоначално чисто дърво, branch `feature/nodes-integration`, HEAD `d9be78ffa12e576557e6137eb1c72f6dcaac1959` (`feat(sync): integrate signed originals through TLS engine`). R8 Windows job 126466489555 в [run 41797961694](https://github.com/Kaloyan3D/A.R.T.H.U.R/actions/runs/41797961694) е проверен чрез GitHub API: success, включително native/fmt/clippy/isolation/architecture/frontend. Това е историческата база, а не проверка на непубликувания R9 diff.

Използвани са само disposable fixtures. Няма stage, commit, push, reset, stash, rebase, merge или PR. Финалното състояние и пълният списък са в L.

## B. Имплементация и ownership

`sync -> sync_api <- storage` остава посоката. `sync_api/signed_bootstrap.rs` съдържа само чистия versioned manifest; protocol/bootstrap/ports добавят R9 capability и отделни typed messages. Същият `SyncEngine`, pinned TLS 1.3 driver, `CandidateSyncStore` и signed importer обслужват bootstrap и catch-up. Няма втори SQLite owner, втори domain/import ledger или нов transport.

`storage/signed_bootstrap.rs` композира existing bootstrap transaction с оригиналните подписи. `signed_import.rs` избира един accepted-proof representation чрез immutable version marker и използва bounded `Admission` cache само за живота на една IMMEDIATE transaction: registry и проверен prefix се валидират веднъж, всеки оригинален подпис продължава да се проверява. Cache не е persistent authority и се изхвърля при rollback/close. `bootstrap_store.rs` преизползва parse/validation резултати и sealed `VerifiedImage` вместо повторна пълна проверка на същите immutable bytes.

`journal/g3.rs` оптимизира доказания capture hot path: един guarded observer на capture group, отделен exact-row **one-use** Grant за всеки INSERT, revoke след всяко използване, RAII restore и проверка на точния observer SQL. Не дава batch capability и не променя G3 admissibility. Останалите mutation paths остават на existing scoped effect.

`storage/signed_profile_r9_candidate.sql` е additive qualification extension: `r9_signed_profile`, `r9_origin_seals`, `r9_originals`, `r9_bootstrap_evidence`, `r9_evidence_chunks`, реални FK/unique/check/immutable/retention guards. Не са редактирани `enrollment_e2.sql`, `m05_v10.sql` или production migrations. Инсталаторът е само test/Android debug qualification; production factory отказва.

Архитектурните решения преди кода: native DB е truth; един owner/transaction; pure wire boundary; fail-closed signature/authorization; immutable lifecycle; синтетични fixtures с реални CNG/Keystore/TLS; проверена additive compatibility; bounded numeric diagnostics; никакво изведено human approval; никакво самоволно rotation authorization.

## C. Подписан snapshot поток

Нов profile `m05-signed-history-candidate-v1`, protocol version **3**, capability mask **127**. R8 остава `m05-signed-original-candidate-v1`, version2/mask47; legacy version1/mask31. Signed receiver отказва legacy unsigned snapshot messages; друг profile отказва R9 variants. Няма downgrade.

1. Под същия IMMEDIATE owner transaction се capture-ват unchanged `SnapshotImage`/canonical cores, exact H, row projection/causal metadata и signed evidence. Local подписи се записват в existing immutable export cache; чуждите подписи се препращат byte-for-byte. Няма подписване от името на чужд автор.
2. Sidecar обвързва network/epoch/current registry digest, snapshot descriptor, exact H, positional complete original coverage, всеки `SignedOriginal`, prefix attestations и source key. Canonical core/provenance остава byte-identical; подписване сега на pre-pairing core не доказва минало network/human authorization. `SignedOriginal` няма отделно поле за attestation class. Whole manifest е JCS и е подписан чрез existing domain-separated OS API и изричен R9 preimage tag. Source prefix/manifest signature **не заменя** author signatures.
3. Offer/image/evidence/publish са отделни bounded съобщения; по един chunk на tick. Receiver запазва image в existing `bootstrap_units/chunks`, proof в FK sidecar. Повторен chunk се допуска само при точни bytes/hash/index/descriptor.
4. Receiver проверява цял image/hash/closure/H, manifest, всеки author binding/signature, predecessor/dependency и G3/D4/G5 policy. Използва existing importer в същата outer transaction. Domain rows, import facts/proofs, accepted signatures/seals, cursors и snapshot outcome са една commit единица. Current authorization се проверява отново непосредствено преди COMMIT.
5. Само durable receipt след успешен commit/cleanup води до applied ACK. `CommitUncertain` и `CommittedCleanupFailed` не издават applied ACK; reopening/retry reconciles exact durable state. Replay на applied snapshot проверява отново accepted signature evidence.
6. Retry използва immutable staged image и proof; не добавя нови live rows към стар H. Post-H event минава отделно през existing signed incremental path. Не се правят network awaits или AI/provider inference под SQL lock; OS signing остава native identity операция в същия доказан owner boundary.

Лимити: image **4,194,304 B**, **64 events**, **2,048 rows**, chunk **262,144 B**, AE01 frame **65,536 B**, serialized-message/assembly **1,048,576 B**. Sidecar има отделен cap **1,114,112 B = 64 × 16,384 + 65,536**, максимум **5 chunks**. Няма нарастване на image/frame/message caps. Existing image staging budget е 8 MiB; отделният sidecar aggregate е максимум 4 units ×1,114,112 B. Това е qualification logical bound, **не G4 physical storage approval**.

Изпълненият near-4-MiB fixture: image **4,156,228 B**, proof **55,944 B**, общо **4,212,172 B**; 16 image chunks +1 proof chunk, 61 events/62 rows. Общата стойност над 4 MiB не се подава като един image/frame/message. Максималният metadata cap е проверен с over-limit отказ; реалният closed SignedOriginal формат е значително по-малък от 16 KiB. Не се твърди, че произволни padding bytes са легитимен максимален original.

## D. Multi-incarnation model и точният blocker

Composite accepted identity е `(origin, incarnation)`; originals са unique по event и `(origin,incarnation,seq)`, incarnation е globally unique. I1 не се презаписва с I2, авторът/identity са immutable, prefix е monotone.

**Приемането на легитимна I2 е BLOCKED.** Existing registry `Action` има само `Genesis`, `Grant`, `Revoke`. Няма одобрен rotation action/wire proof, който да обвърже network, origin, author, I1 accepted tip seq/hash, I2/start, epoch, restore/rotation intent и anti-sibling/rollback fence. Existing reader отказва повече от една accepted incarnation за origin без такова authorization; genuine OS-signed I2 и sibling I3 остават `UnsupportedImportPolicy` в quarantine, I1 proofs/signatures/cursors не се променят.

Owner/storage/security review трябва да определи: кой разрешава transition; exact versioned domain/preimage и registry binding; единствен допустим successor; durable anti-rollback anchor при restored backup; allowed key-loss/new-key membership transition; как transition се пренася/проверява през bootstrap и compatible schema activation. R9 не изобретява тези правила. Нов key за стар origin не се авторизира автоматично. Composite schema е groundwork, **не доказателство за завършена rotation functionality**.

## E. E2 compatibility

Инсталаторът проверява pinned local OS key/registry, всеки стар E2 prefix seal и всеки exact author signature/core chain. В една transaction копира непроменените seal bytes и original envelopes в R9 representation; добавя incarnation от проверения parent seal. Едва след успешното копиране активира immutable version1 marker.

След marker R9 е единствената accepted-proof authority; старите E2 rows са frozen read-only compatibility evidence. Повторен install проверява R9 prefixes и exact E2 subset, historical seal signatures/tips и key binding; не поправя противоречия мълчаливо. Тестове проверяват exact copy, idempotence, frozen E2 и corrupt prefix/original отказ без partial DDL. Production schema остава v9.

## F. Snapshot CI issue — диагностика и измерване

По-ранното R8 обяснение за line61 като capture е неточно: actual `sync_history_tls_tests.rs:61` е **receiving `eb.tick()`**, след source capture и transfer. Instrumented baseline възпроизведе receiver `SnapshotTooLarge` при **нормален run2/3** и **single-core run1/3**. Actual image около **2,309,800–2,309,912 B**, raw cores около637,000 B, точно64events/2048rows; byte/count caps не са причината. И source capture може да надвиши5s под натоварване. Error contract остава същият; numeric phase/watchdog diagnostics различават time от actual cardinality/bytes.

Доказаният hot path е repeated guarded-trigger drop/create по всеки capture row, със schema invalidation и повторни SQL/validation разходи. Детерминистичният regression първо FAIL: **32 observer scopes вместо1**, после PASS: **1 за същите32 rows**, със същите one-use grants. Само тази оптимизация не беше достатъчна при stress: запазени са последвалите capture/publish timeouts и един TLS deadline failure. Допълнително премахнати repeated parse/validation и повторно prefix-chain verification в една immutable transaction. Не е вдигнат или изключен 5s watchdog; добавена е финална проверка след serialization/staging. Signed extension използва същия начален Instant за image, originals, prefix signatures, manifest и sidecar staging; signing не получава нов5s budget. Expired-budget tests покриват cores/signed_originals/signed_manifest/signed_stage с transaction rollback. В cfg(test) numeric trace се показва автоматично при error/panic, включително в CI; env flag добавя и success traces.

Финални exact R6 repeats, normal и ProcessorAffinity=1/BelowNormal, test-threads=1:

| Run | Capture ms | Publish apply/projection ms | Резултат |
|---|---:|---:|---|
| normal1 |1084|1856|PASS exit0|
| normal2 |1077|1863|PASS exit0|
| normal3 |1103|1869|PASS exit0|
| single-core1 |1456|2503|PASS exit0|
| single-core2 |1424|2445|PASS exit0|
| single-core3 |1667|3110|PASS exit0|

Логове `%TEMP%/arthur-r9-max-final-{normal,single-core}-{1,2,3}.{log,err.log}`. Това установява и намалява локално възпроизведения workload, а не гарантира произволна hosted CPU скорост. Hosted R9 gate остава **UNVERIFIED**: R9 не е push-нат. Изпълнен е отделен deterministic expired-watchdog negative, който отказва staging; oversize count/bytes negatives са разграничени с watchdog=false.

### Допълнително открит independent-endpoint stall

Първите R9 emulator exchanges не преминаха: Windows `transfer: Trust` след idle deadline, Android `Disconnected`; един instrumented run премина phase1, но отказа phase2. R8 signed control премина. Бounded counters показаха Windows с818,328 sent bytes, 4 queued messages, 20,046 queued bytes и partial cipher28,672/65,654B; Android бе обработил само Hello+Offer и не бе получил complete image message. Това не беше invalid author signature или image overflow.

Independent `Endpoint::step_after_work` връщаше към engine/store след едно OS write, докато bounded output оставаше queued. Така owner authorization/summary се повтаряше между4KiB writes и следващ large chunk можеше да бъде enqueue-нат преди drain. Новият `native_security::tls_socket_lab::r9_endpoint_drains_bounded_output_before_another_engine_turn` е **RED→GREEN**: преди промяната2nonempty output/cipher components вместо0; след нея0. Предварителният incoming-fragment probe премина още преди поправката; не се представя като RED reproducer.

Driver вече прилага backpressure чрез existing bounded `flush`, преди следващ engine turn, и запазва productive-no-output behavior. Existing R7 idle-peer test премина. Няма промяна на4096B OS steps,15s record idle/60s session deadlines, AE01 framing, TLS, queue/message/image caps или per-I/O permit checks. R9 receiving fixture не приключва restart phase само защото старият cached unit вече е applied: изчаква ordered Hello/Offer/image/evidence/Publish. Numeric-only progress/wire files са bounded overwritten qualification diagnostics, не нов protocol.

Финалните emulator повторения и exact exit codes са в J; неуспешните pre-fix logs са запазени като `arthur-r9-emulator-{signed-history,signed-history-diag,signed-history-diag2,wire-diag}.log`. Отделно emulator debug-APK replacement върна `INSTALL_FAILED_INSUFFICIENT_STORAGE`; премахнати/инсталирани наново бяха единствено двете dedicated qualification packages в task-owned read-only VM. Не е променян ordinary package или лична база.

## G. R9-01–R9-26 matrix

Native evidence е Windows CNG + real pinned TLS engine/importer върху disposable synthetic stores. `history::` означава `storage::signed_sync_tests::history::`. Докладът е работен: първият comprehensive run е FAIL (1500 PASS,1 FAIL,26 ignored); focused PASS не заменя този gate. Platform evidence е отделно в J.

| ID | Статус / доказателство |
|---|---|
|R9-01|PASS — EXECUTED: unchanged R8 signed-engine/fault tests в full native suite.|
|R9-02|PASS — EXECUTED: `r9_02_12_single_h_cached_image_does_not_absorb_a_post_h_write`; същият H при image+proof capture.|
|R9-03|PASS — EXECUTED: exact signature equality, signed knowledge и third-peer forwarding `r9_03_forwarded_snapshot_preserves_original_author_signatures`.|
|R9-04|PASS — EXECUTED: real-engine hello negotiation, R8/legacy/unsigned snapshot refusal `r9_04_legacy_or_r8_negotiation_and_unsigned_snapshot_cannot_enter_r9`.|
|R9-05|PASS — EXECUTED: signed max/near-4MiB TLS chunking + exact signature reassembly.|
|R9-06|PASS — EXECUTED: `r9_02_03_05_06_real_engine_signed_bootstrap_publishes_original_signatures_atomically`, knowledge closure и precommit rollback negatives.|
|R9-07|PASS — EXECUTED: parameterized `r9_07_08_15_signed_snapshot_tampering_missing_evidence_and_wrong_projection_never_publish`.|
|R9-08|PASS — EXECUTED: същият TLS test: wrong author/network/epoch/registry.|
|R9-09|PASS — EXECUTED: `r9_09_valid_signed_review_snapshot_is_retained_non_clean_without_approval` плюс `r9_09_signed_snapshot_cannot_replace_an_independently_selected_local_head`; zero approved proposals, unchanged local head/signatures и no applied ACK.|
|R9-10|PASS — EXECUTED: `r9_10_signed_staging_resumes_after_offer_partial_chunks_and_before_publish`, image>=2chunks; offer-only/partial-image/full-image+proof then reopen. Synthetic interruption, не process kill.|
|R9-11|PASS — EXECUTED: `r9_10_11_22_signed_snapshot_lost_ack_both_owners_reopen_and_exact_retry`; cached image/proof equality и one publication.|
|R9-12|PASS — EXECUTED: same-incarnation post-H write отделно през signed incremental importer.|
|R9-13|PASS — EXECUTED: max case (64 events/2,048 rows) 6/6 (3 normal, 3 one-core) след смяна на publish бюджета на 5s per retained event (+ собствен бюджет за projection). Лимити/counts непроменени; общата работа остава ограничена от 64 events. Останалите 43 signed теста PASS. Пълен native suite НЕ е презапуснат след промяната.|
|R9-14|PASS — EXECUTED: `r9_14_near_four_mib_image_keeps_its_cap_and_accounts_separate_signed_evidence`; exact bytes в C.|
|R9-15|PASS — EXECUTED: corrupted/missing manifest/chunks/coverage/projection, no authoritative rows/proofs/ACK.|
|R9-16|PASS — EXECUTED: `r9_16_registry_revocation_after_tls_cannot_publish_staged_history`, `r9_16_final_transaction_permission_recheck_rolls_back_domain_signatures_and_outcome`; final barrier на същия owner transaction.|
|R9-17|PASS — EXECUTED: I1 exact signatures/seal/cursor preserved при genuine I2/I3 отказ и при E2 upgrade.|
|R9-18|BLOCKED — CONTRACT / APPROVAL DECISION: няма approved I1-tip→I2 rotation authorization; model groundwork е изпълнен, acceptance не е разрешен.|
|R9-19|PARTIAL — EXACT MISSING EVIDENCE: actual signed same-sequence fork/same-ID altered-core и sibling I2/I3 откази са PASS; complete R9 restored-old-backup→authorized-I2 exchange чака R9-18. Existing journal restore regressions са отделни, не заместващи доказателства.|
|R9-20|PASS — EXECUTED: `r9_19_20_signed_old_sequence_fork_and_replacement_key_preserve_accepted_history`, genuine unapproved OS key отказва Trust.|
|R9-21|PASS — EXECUTED: `r9_21_e2_history_upgrades_exactly_once_and_remains_immutable_compatibility_evidence` и corrupt E2 prefix/original rollback test.|
|R9-22|PASS — EXECUTED: both Windows owners close/reopen exact DB и exact immutable signature/cursor checks; Android process evidence е отделно в J.|
|R9-23|PASS — EXECUTED: `r9_23_commit_uncertainty_and_cleanup_failure_send_no_applied_ack_and_reconcile`, real deferred-FK COMMIT failure + actual budget-restore fault, reopen/retry.|
|R9-24|PARTIAL — EXACT MISSING EVIDENCE: root workload isolated/reproduced locally, deterministic32→1scopes и6/6 final repeats; старият hosted fail няма новите phase counters, hosted R9 rerun не е изпълнен без push.|
|R9-25|PASS — EXECUTED: full native suite плюс exact R6 target; Android regressions се отчитат отделно.|
|R9-26|PASS — EXECUTED: architecture88/88 + closed-factory/schema tests в full native; no changed production DDL/activation; package/JNI isolation в J.|

## H. Negative security резултати

Реални Windows CNG/TLS engine tests, synthetic registry/data: corrupt signature; missing originals; swapped original; wrong pinned author; random genuine OS key; wrong network/epoch/registry/H/image binding; corrupted chunks; missing proof chunk; noncanonical manifest; oversized sidecar/inner metadata; forged projection с unchanged authentic originals. Всички отказват authoritative publication/applied ACK. Отделни тестове проверяват revocation след TLS и final precommit permission recheck с пълен rollback. Review snapshot остава non-clean/attention, без approved proposals и без accepted signed prefix.

G5 policy не е редактирана. Full regressions допълват проверките за foreign selected-head; signature доказва author, не човешко съгласие. Fault barriers са synthetic: deferred-FK COMMIT error и actual G4 cleanup-restoration failure в disposable owner. Не са hardware power-cut доказателства.

## I. Regression и gate evidence

Първи focused signed-history pass: **18 passed,0failed,0ignored**,83.32s; `%TEMP%/arthur-r9-focused-v1.log`. Финален focused pass след fork/replacement-key, foreign-head, multi-chunk interruption и whole-signed-capture watchdog tests: **20 passed,0failed,0ignored**,157.47s; `%TEMP%/arthur-r9-focused-final.log`. Backpressure RED→GREEN и unchanged R7 scheduling regression са отделно изпълнени. Финалният comprehensive native result предстои.

Проверени: architecture **88/88**, без edits на existing assertions; frontend **561/561**,42files и successful typecheck/Vite build; host qualification **34 checks**; dependency isolation **6/6** actual graphs. Required clippy `--lib -- -D clippy::all` PASS exit0; ordinary Rust unused/dead-code warnings остават (541 lib при финалния gate), не се твърди `-D warnings` cleanliness. Vite предупреждава за bundle>500kB. Първоначален clippy run откри needless borrow и enum postfix; отстранени са, без lint suppression. Първоначален default build откри qualification-only SnapshotOffer serde mismatch; поправен е чрез private versioned descriptor adapter.

## J. Android qualification

ARM64 identity и standalone network debug APK build/inspection PASS. Dedicated packages са само `dev.kaloyan.arthur.identitytest` и `.test`; ABI arm64-v8a; qualification native SHA256 `BF05526E4BEE055B5AD203531E8BA90850C849DE934535DE54C6FE3752ED2F7C`. Това е build, не physical runtime evidence.

AVD `Medium_Phone_API_36.1`, task-owned read-only headless `emulator-5582` е стартиран за actual Keystore/TLS runtime. Actual emulator е **API36 / Android16 / x86_64**, не физически телефон. Identity/Keystore/TLS suite **49/49**,0failures/0skipped, плюс2 actual restart invocations (`NativeIdentityRestartTest#prepare`, `#reopen`) са PASS. След backpressure fix **3/3** complete R9 exchanges преминаха (`arthur-r9-emulator-backpressure-{1,2,3}.log`). Rebuilt APK с whole-capture watchdog също премина R9, R8 signed-original и legacy exchange, всеки с двата process restarts;4 selected native network probes са PASS след това.

Финален R9 fixture: `%TEMP%/arthur-r3-f0def261-3088-442d-90c7-30679823277f`, Windows PID7348→21704. Image **245,965B**, evidence **3,182B**,1+1chunks; exact image/proof descriptor, original signatures/seals, import proofs/cursors и3event IDs са проверени между фазите и между peers. Phase1 source unit=`staged`, status=`Syncing`; phase2 същият unit=`applied`, status=`CleanlyApplied`. Original-event outstanding count е0 и в двете фази; това **не** означава получен snapshot ACK в phase1. R9 receiving restart изчаква fresh Publish, вместо да приключи само по стария applied outcome. Няма нов local write в I2 след process restart; това е отделният blocked rotation path.

Final-source qualification .so SHA256: ARM64 `BF05526E4BEE055B5AD203531E8BA90850C849DE934535DE54C6FE3752ED2F7C`, x86_64 `5B2773FC799D1FE761D7C6C5D79836A9818C8F66138C4B59E73DB4982AEA735C`. Последващата cfg(test)-only промяна прави numeric failure traces видими автоматично; тя не се компилира в Android instrumentation APK.

**Ordinary ARM64 debug APK**, built without qualification feature/config: package=`dev.kaloyan.arthur`, sole native ABI=`arm64-v8a`, ELF64/AArch64, qualification JNI exports=**0**. Native SHA256=`5E1B74E7B4F88F40AE6CDF057C6F8A9B363396380526D0962CBC43D8848E8624`. Merged permissions са само existing dynamic-receiver permission, INTERNET и RECORD_AUDIO; ACCESS_NETWORK_STATE/ACCESS_LOCAL_NETWORK липсват. APK е inspected, **не installed** в ordinary package. `%TEMP%/arthur-r9-default-arm64-{build.log,inspection.json}`. Task-owned emulator е затворен с explicit `adb -s emulator-5582 emu kill`, без snapshot save.

 **PHYSICAL R9 — NOT EXECUTED**: няма свързан physical ADB device. R7 Samsung S22 резултатът не е R9 evidence.

Reproduction (PowerShell; JDK/SDK/NDK configured):

```powershell
& apps/arthur/src-tauri/gen/android/verify-identity.ps1 -Target aarch64 -BuildOnly
& apps/arthur/src-tauri/gen/android/verify-network.ps1 -Target aarch64 -BuildOnly
& apps/arthur/src-tauri/gen/android/verify-identity.ps1 -Target x86_64 -Serial emulator-5582
& apps/arthur/src-tauri/gen/android/verify-cross-device.ps1 -Serial emulator-5582 -SignedHistory
# Physical: dedicated ARM64 network APK installed, permission explicitly granted,
# trusted Private Windows interface and both real authorized LAN addresses:
& apps/arthur/src-tauri/gen/android/verify-cross-device.ps1 -Serial <serial> -Physical -LanAddress <windows-private-ip> -AndroidAddress <phone-private-ip> -SignedHistory
```

SignedHistory и SignedOriginal са mutually exclusive; host check отказва двете преди ADB. R9 runner използва existing case50 install, existing engine/TLS/importer, cached snapshot ID и двата process restarts; не разрешава нова incarnation. Loopback emulator е ADB-mediated data path, не direct physical LAN.

## K. Production readiness

**НЕ е production release acceptance.** N1 PAKE/security review остава; G4 physical resource policy остава; G5 historical authority остава; incarnation transition contract остава; R9 physical/hosted evidence остава. `SCHEMA_VERSION=9`, STEPS1..9, ClosedTrust/ClosedLan, closed production SignedImportStore/enrollment/listener/SyncNow factories не се активират. Няма AutoSync/background scheduler, лични DB migrations, Internet/VPN/relay/cloud/HomeNode dependency или нов pairing protocol.

## L. Git integrity и changed-file accounting

Финалният diff/stat/status/HEAD ще се впишат след всички build cleanup и проверки. Не stage/commit/push.

## M. Final verdict

**R9 — VERIFICATION INCOMPLETE**
