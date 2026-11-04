# M05 Fast Track R7 — физическа Windows ↔ ARM64 Android лаборатория

Дата на квалификацията: 2026-11-03, Europe/Sofia. Това е изолирана debug
квалификация, не активиран потребителски Sync. При изпълнението няма commit,
stage, push, merge или PR. На 2026-11-04 собственикът изрично разреши commit
и push на тези промени; това не променя резултатите или release gates по-долу.

## A. Начално състояние и обхват

Проверени: `feature/nodes-integration`, HEAD
`419ff1ff939af23c0f3a5c792d852d9d6a380ff6`, първоначално чисто работно дърво.
При приключване на квалификацията промените остават само в работното дърво;
последващото разрешение за публикация е отбелязано по-горе.

Променени файлове спрямо този HEAD:

- `apps/arthur/src-tauri/gen/android/verify-identity.ps1`
- `apps/arthur/src-tauri/gen/android/verify-network.ps1`
- `apps/arthur/src-tauri/gen/android/verify-cross-device.ps1`
- `apps/arthur/src-tauri/gen/android/qualification-common.ps1` (нов)
- `apps/arthur/src-tauri/gen/android/test-qualification.ps1` (нов)
- `apps/arthur/src-tauri/gen/android/qualification-network/build.gradle.kts`
- `apps/arthur/src-tauri/gen/android/qualification-network/src/main/AndroidManifest.xml`
- `apps/arthur/src-tauri/gen/android/qualification-network/src/androidTest/java/dev/kaloyan/arthur/security/NativeIdentityBridgeTest.java`
- `apps/arthur/src-tauri/src/sync/security/qualification/verify-isolation.ps1`
- `apps/arthur/src-tauri/src/storage/journal/cross_device_qualification.rs`
- `apps/arthur/src-tauri/src/sync/security/tls_socket_lab.rs`
- настоящият документ.

Няма промени в Rust двигателя, импорта, SQLite схемата, writer адаптерите,
ArthurClient, React, production manifest или production Cargo features.
В съществуващия qualification-only cross-device fixture е добавена bounded
`failure.json` диагностика за затворените I/O/Sync error enums, с regression
test за запазване на причината през boolean JNI boundary. Няма raw panic text,
ключове или payload-и в този diagnostic. Security/route/budget проверки не са
променени. Controller-ът показва само валидирани stage/code полета.
Самият съществуващ single-endpoint lab driver вече изпълнява bounded socket poll
и връща управлението към engine-а след productive local tick; при idle engine
чака реален I/O. Lost-ACK фазата изисква quiescent `Syncing`/2 pending,
а normal/resume фазата — quiescent `CleanlyApplied`/0 pending. Native резултатите
включват реалния status/attention и original origin/incarnation/sequence.
Генерираният `app/build.gradle.kts` се връща към точните начални байтове след
временното добавяне на `.identitytest` от Tauri CLI. Неочаквана едновременна
редакция се отказва, вместо да се презапише. Не пускайте паралелни Android builds.

## B. Използвана функционалност

Съществуващите `cross_device_qualification.rs`, `tls_qualification.rs`,
`SyncEngine`, `CandidateSyncStore`, `JournalKernel`, `Fixture` и
`NativeRuntime` остават реалният native път. Всеки endpoint има един owner и
собствена SQLite база. Windows използва CNG, Android — Keystore. Съществуващият
`Endpoint::authenticate` изпълнява pinned mutual TLS 1.3, проверката на hello,
exporter/session binding и store authorization. Native I/O кодът избира и
проверява действителния интерфейс, bind-ва същия socket и проверява route fence.

Не е създаден нов транспорт, engine, SQL owner, wire enum или trust bypass.
Зависимостите остават `sync -> sync_api <- storage`; native primitives и
runtime-owned transport pool са непроменени. ADB в `-Physical` режима е само
за управление и публични fixture конфигурации/резултати; Sync payload-ите
използват съществуващите native LAN sockets. Самостоятелният emulator режим
без `-Physical` и без LAN адреси запазва изрично означения ADB reverse поток.

## C. ARM64 резултат

На Windows е добавен липсващият Rust target `aarch64-linux-android`.
Използвани са JDK 25.0.2, инсталираният Android SDK и NDK
`29.0.14206865`, с реалния linker
`toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd`.

`verify-identity.ps1 -Target aarch64 -BuildOnly` използва поддържания Tauri
Android build, после генерираните `assembleArm64Debug` и
`assembleArm64DebugAndroidTest` задачи, като използва вече построената от
Tauri feature-enabled библиотека. `-Target x86_64` остава emulator изборът
по подразбиране. `-BuildOnly` не инсталира и не изпълнява instrumentation.

`verify-network.ps1 -Target aarch64 -BuildOnly` строи отделния съществуващ
qualification Gradle проект с `-PqualificationAbi=arm64-v8a`. Той не е включен
в стандартния Tauri Gradle settings и няма release variant.

В двата APK комплекта се проверяват действителните application IDs,
debuggable флагът, instrumentation targetPackage/runner, точно една Arthur ABI
библиотека, ELF machine=183 и положителният debug JNI export.
Не се допуска инсталиране през тези скриптове
на package `dev.kaloyan.arthur`.

Действителни package IDs:

- приложение: `dev.kaloyan.arthur.identitytest`;
- instrumentation: `dev.kaloyan.arthur.identitytest.test`;
- runner: `androidx.test.runner.AndroidJUnitRunner`.

Доставени ARM64 LAN APK-и (локални build artifacts, не Git файлове):

| Файл под `gen/android/qualification-network/build/outputs/apk/` | SHA256 |
| --- | --- |
| `debug/arthur-network-qualification-debug.apk` | `694BCBF0662DB6D26F5937E93C2BD3C589C4FF083753D15F0EC853976F3F3608` |
| `androidTest/debug/arthur-network-qualification-debug-androidTest.apk` | `8E2B93EC22B524536A48B8364E6803EF8123D3422F33824B4EEB00B6B5231426` |

Native библиотеката, извлечена от ARM64 LAN APK, има SHA256
`5D54DCB1B18F5941FB87A18B8B1B6501DFC2A423D3E5557113D56242A22DC4BE`.
Тези hashes са измерени върху крайния package, не изведени от source или ABI име.

**Физическо устройство: Samsung S22 / SM-S901B**, `arm64-v8a`, Android API36,
`ro.kernel.qemu=0`, USB ADB authorization потвърдена. Първоначалният празен
ADB списък е преодолян след свързване на телефона от собственика.
`verify-identity.ps1 -Target aarch64 -Serial <actual serial>` е изпълнен:
**49 PASS / 0 failures / 0 errors / 0 skipped**, XML duration 196.112 s;
отделните process-restart `prepare` и `reopen` са **1 + 1 PASS**.
Съществуващите четири standalone native network/history probes също са
**4 PASS** на този телефон. Няма emulator execution в тази R7 сесия.
Serial-ът и пълните test logs остават в локалните `%TEMP%/arthur-r7-s22-*`
artifacts; не се публикува device identifier в repository документа.

## D. LAN и permissions

`-Physical` изисква ARM64 device, Android API >=29, две различни изрично
подадени частни IPv4 стойности и отказва emulator. Не преминава към ADB reverse.
Serial-ът не допуска whitespace или shell синтаксис. Windows адресът трябва
да принадлежи на точно един preferred локален интерфейс с Private profile.
Скриптът не променя network profile, firewall или permissions автоматично.

Преди listener или fixture preparation Android `preflight` проверява test
package/debug identity, network-state permission, API37 local-network grant,
актуален Wi-Fi/Ethernet source адрес и direct route без gateway. Това е само
ранна диагностика; съществуващите native bind/route/fence проверки преди dial
и pinned TLS остават задължителни. IP адресът и SSID не дават membership.

Само отделният test manifest декларира `ACCESS_LOCAL_NETWORK` и
`ACCESS_NETWORK_STATE`, `allowBackup=false`, `usesCleartextTraffic=false`.
При Android 17/API37 и target37 local-network достъпът изисква runtime grant:
[Android Developers](https://developer.android.com/privacy-and-security/local-network-permission).
Ако липсва, preflight връща видима `PermissionRequired` assertion; няма
автоматичен grant, trust fallback или plaintext endpoint. Собственикът трябва
изрично да разреши Nearby devices/local network за **M05 Sync Lab (qualification)**
от Android Settings → Apps → Permissions и да повтори командата.
Production manifest не получава нова permission.
Съществуващата read-only `broad` assertion вече сравнява наблюдението с
действителния OS permission state: API37 grant може да е true в този dedicated
variant. Това не приема route snapshot за socket binding или trust approval.

Разрешената двойка е Windows Wi-Fi `192.168.0.102/24` ↔ S22 Wi-Fi
`192.168.0.100/24`, Android source port37432. Собственикът потвърди общата
мрежа и изрично разреши промяна само на Windows Wi-Fi interface5 от Public
на Private. Промяната е извършена с еднократна elevated Windows команда;
обикновеният PowerShell опит беше отказан от OS. Другите interfaces и firewall
rules не са променяни. Това е отделно разрешено host действие; runner-ът сам
не променя profile.

Първият physical LAN опит мина Android preflight и fixture preparation, но
Android exchange отказа преди durable result publication. Controller-ът
почисти двете изолирани бази. Артефактите са в
`%TEMP%/arthur-r3-b56b3293-ffdc-404a-b414-b2e7aa1d8447` и
`arthur-r7-s22-lan.log`. Причината не се виждаше през boolean JNI; това
мотивира qualification-only diagnostic regression/fix. Диагностичният повторен
run показа, че Android вече е публикувал 3 валидни events/2 import proofs и
0 outstanding, а Windows изтича при transfer (`Trust`, съществуващото mapping
за I/O expiry). Двете stale harness предпоставки са възпроизведени отделно:
productive engine tick не трябва да чака нов network message; intentional
receipt loss не може да изисква `CleanlyApplied`.

**Крайният direct physical run: PASS — EXECUTED ON PHYSICAL DEVICE.**
`arthur-r7-s22-lan-final.log` и
`%TEMP%/arthur-r3-572fe04f-dd10-49f6-a6b9-7a608a547243` съдържат успешните две
фази. Actual socket endpoints са Wi-Fi адресите по-горе, server ports61745 и
61763, client source port37432. ADB reverse list е празен преди и след run-а.
Няма добавени firewall rules, loopback bridge или WAN fallback.

## E. Двупосочни данни и ACK

При действително стартиране съществуващият runner:

1. Създава временна Windows база под `%TEMP%/arthur-r3-<GUID>/db` и отделна
   Android база под cache на dedicated package: `r3-cross-device/db`.
2. Windows създава Project `Windows → Android R3` и реален journaled Capture
   с детерминистично synthetic съдържание. Android импортира и създава свой
   journaled Capture `Android → Windows А́ 原文\n😀` в получения проект.
3. Двата процеса обменят оригиналните canonical events през съществуващия
   TLS/engine/importer. Fixture manifest-ите съдържат публични ключове и origins,
   не частни ключове или pairing secrets.
4. Native проверките сравняват точно 3 original events, bytes/hash и действителни
   материализирани rows, integrity/FK проверки, G3 proofs и import cursors.
5. Фаза 1 умишлено губи Windows receipts след encrypted transport. Двата
   outstanding event IDs **не означават up-to-date**. Скриптът вече показва това
   изрично и изисква native engine status `Syncing`, а не `CleanlyApplied`.
6. Спира Android процеса и стартира нов Windows endpoint; двата owner-а
   отварят собствените си бази отново. Фаза 2 изисква нула outstanding receipts,
   същите originals/rows/proofs/cursors и нов PID на всеки endpoint.

Това вече е **изпълнено физическо доказателство за canonical-event/mutual-TLS
обхвата**, със synthetic journaled test data, не лична база. Конзолата извежда
counts, PIDs и delivery state, не Capture content.

| Фаза | Windows PID / status / pending | S22 PID / status / pending |
| --- | --- | --- |
| Lost ACK | 4012 / `Syncing` / 2 | 23061 / `CleanlyApplied` / 0 |
| Restart/resume | 34616 / `CleanlyApplied` / 0 | 23165 / `CleanlyApplied` / 0 |

И двата endpoint-а имат същите 3 originals/bytes/hashes/rows след reopen.
Windows има1 remote applied proof/cursor stored=integrated=applied=1; S22 има2
proofs/cursor stored=integrated=applied=2. Proofs/cursors и OS public-key hashes
са стабилни между фазите. Independent origin IDs са различни. Отделен read-only
audit провери и domain-separated journal hash по действителния codec:
`SHA256("ARTHUR-M05-LOCAL-BUNDLE-v1" || 0x00 || canonical_bytes)`.

Действителните Capture IDs са:

- Windows original: `53bdc3e1-ff08-4e11-9e29-72d61bec8d25`, source seq2,
  content SHA256 `E976639E06D3B8327400C6F391CD2ECF208F5A36F5875E39D2A1EAAD2B6AB2C0`;
- Android original: `c81f1999-8c4d-45de-a365-f9616cf95117`, source seq1,
  content SHA256 `0E0F10437D6BB22A7BDC097AB17D5657AAF4848A2E38EE3791B5650BC3D213BC`.

Пълният safe summary е `%TEMP%/arthur-r7-s22-physical-summary.json`, със
source event IDs/hashes/counts и phase evidence. И двете disposable DB
директории са проверени като премахнати след успешния native cleanup; test
results остават за review. Това не е cleanup на ordinary Arthur data.

**Ограничение на signatures:** този съществуващ transport обменя `Envelope`
под mutually authenticated TLS, а не отделния versioned `SignedOriginal`.
`SignedImportStore`/`SignedOriginal` не са свързани с този wire път.
Следователно CNG/Keystore TLS signatures и canonical event parity не доказват
пренос/проверка на per-original signatures. Не е добавен алтернативен wire
формат или out-of-band подпис, който да се представи за engine authentication.
Тази част от R7-10 остава непокрита и изисква отделно конкретно integration
решение преди да се заяви целият P2 за изпълнен.

## F. Debug Sync Lab

Използваемата подготовка е CLI/instrumentation harness-ът и inspected APK-ите.
Networking не стартира при installation/Application bootstrap. `Sync now` е
изричното извикване на `verify-cross-device.ps1 -Physical ...`; Cancel е Ctrl+C.
В `finally` runner-ът прекратява собствените endpoint/ADB процеси, спира само
dedicated Android app и извиква съществуващите fixture cleanup entrypoints.
Успешният physical cleanup е изпълнен и проверен; отделен physical Ctrl+C fault
scenario още не е изпълнен.

Не е добавен React екран, SQL API или нов JNI dispatcher. Заданието поставя
debug UI **след** успешния физически native сценарий. Native сценарият вече
минава за описания ограничен обхват. Доставеният безопасен command surface е
`Sync now` чрез physical runner, native status/attention/origin/sequence и
imported rows чрез public results, и Ctrl+C/cleanup. Няма нов production-facing
UI, enrollment API или release доверие; per-original signatures и останалите
release gates още блокират представянето му като пълен потребителски Sync.

## G. Откази и изолация

Host-only regression script проверява ARM64/emulator mapping, отказ за
public/loopback/неcanonical/еднакви IP адреси, wrong package, missing device,
unauthorized device, wrong ABI, emulator в physical mode, unsupported API,
serial syntax, `-Physical` без LAN и безопасно възстановяване на generated
Gradle файла. Това са **синтетични факти**, не ADB/Keystore/LAN изпълнение.

Съществуващите Windows native тестове продължават да покриват TLS binding,
wrong identity/network, cancellation, corrupted transport/payload, deferred
dependency, unsupported approval, foreign head, staging interruption и ACK
recovery. Тези резултати не заместват същите откази на физическата връзка.
Controlled lost-ACK/restart сценарият е изпълнен на direct physical LAN (§E).
Останалите отделни physical fault injections не са изпълнени и са означени
като UNVERIFIED в §H.

Диагностиката използва съществуващата терминология, не нов wire enum:

| Семантичен резултат | Съществуващ native резултат / проверка |
| --- | --- |
| CleanlyApplied | `SyncStatus::CleanlyApplied` / `Outcome::CleanlyApplied`; за delivery се изискват и matching durable receipts, без outstanding/attention |
| DeferredDependency | `Outcome::DeferredDependency`, `SyncStatus::DeferredDependency`, retained import/progress state |
| ConflictRetained | `Outcome::ConflictRetained`, `needs_attention`; retained conflict не е convergence |
| Unsupported | `Outcome::UnsupportedImportPolicy` / `SyncStatus::UnsupportedImportPolicy` |
| StorageLimited | `Error::StorageLimited` / `SyncStatus::StorageLimited`; `CommitUncertain` и `CommittedCleanupFailed` остават различни откази без ACK |
| IntegrityFailure | `Error::Integrity` / `SyncStatus::RejectedIntegrity` |
| TrustFailure | `Error::Trust` / `SyncStatus::RejectedTrust` |
| PermissionRequired | `route_observer::Unavailable::MissingPermission` / `DeniedOrRevoked`; ранна Android preflight assertion с този diagnostic label |
| Unavailable | съществуващите route `Unavailable` откази или `Error::Disconnected`, според действителния отказ; не се заменят с успешен receipt |

## H. R7 acceptance matrix

Нито един build/synthetic/emulator резултат не се означава като физически PASS.
`BLOCKED` означава неприключен gate; допълнителното Windows доказателство в
същия ред не променя този статус.

| ID | Статус и точен обхват |
| --- | --- |
| R7-01 | **PASS — EXECUTED ON WINDOWS**: branch, пълен HEAD, чист начален status и последните 12 commits |
| R7-02 | **PASS — EXECUTED ON WINDOWS**: действителни ARM64 qualification application + instrumentation APK builds и ELF/ABI inspection; не execution на телефон |
| R7-03 | **PASS — EXECUTED ON PHYSICAL DEVICE**: dedicated app/test IDs, Keystore/JNI fixtures и private cache DB на S22; production root не е отварян |
| R7-04 | **PASS — EXECUTED ON WINDOWS**: default ARM64 APK е production ID, без новите permissions и без qualification JNI; шест dependency graphs PASS. Release APK не е построен |
| R7-05 | **PASS — EXECUTED ON PHYSICAL DEVICE**: S22 49/49 + restart1+1; real Keystore/native TLS, плюс cross-device pinned TLS1.3 |
| R7-06 | **PASS — EXECUTED ON PHYSICAL DEVICE**: distinct Wi-Fi endpoints, server61745/61763, client37432; празен reverse list преди/след; no bridge/WAN fallback |
| R7-07 | **PASS — EXECUTED ON PHYSICAL DEVICE**: mutual CNG/Keystore identity, exact pins/session/exporter/store checks и actual bound route; qualification trust, не production approval |
| R7-08 | **PASS — EXECUTED ON PHYSICAL DEVICE**: Windows Project/Capture originals са реално импортирани на S22, с2 applied proofs |
| R7-09 | **PASS — EXECUTED ON PHYSICAL DEVICE**: S22 Capture original е реално импортиран в Windows, с1 applied proof |
| R7-10 | **PARTIAL / BLOCKED — INTEGRATION GAP**: original IDs/domain-separated hashes/bytes/rows имат physical parity; per-original `SignedOriginal` не е в текущия fixture wire, вж. §E |
| R7-11 | **PASS — EXECUTED ON PHYSICAL DEVICE**: phase1 Windows pending2/Syncing; phase2 pending0/CleanlyApplied; stable applied cursors и matching durable receipts |
| R7-12 | **PASS — EXECUTED ON PHYSICAL DEVICE**: Windows4012→34616, S22 23061→23165, real owner reopen и същите OS public-key hashes |
| R7-13 | **PASS — EXECUTED ON PHYSICAL DEVICE**: lost ACK replay след restart; същите точно3 originals/rows/proofs, без дубликати |
| R7-14 | **UNVERIFIED — direct Windows↔S22 LAN fault** за interrupted/incomplete snapshot; existing Windows и same-phone qualification evidence са отделни |
| R7-15 | **UNVERIFIED — direct Windows↔S22 LAN fault** за missing dependency; existing retained-dependency tests не се преименуват на physical peer fault |
| R7-16 | **PASS — EXECUTED ON WINDOWS**, synthetic histories: съществуващите unsupported approval и foreign-head ограничения; няма одобрен G5 policy или physical acceptance |
| R7-17 | **PARTIAL / UNVERIFIED — direct LAN negatives**: positive actual route/pins и same-phone/Windows wrong-peer tests PASS; отделните Windows↔S22 wrong identity/network/route injections не са изпълнени |
| R7-18 | **PARTIAL / UNVERIFIED — physical Ctrl+C fault**: physical normal cleanup PASS, native phone cancellation tests PASS; отделен mid-LAN Cancel case не е изпълнен |
| R7-19 | **PASS — EXECUTED ON PHYSICAL DEVICE**, CLI milestone: explicit native Sync command, status/attention/origin/sequence/records/evidence и cleanup; няма production-facing UI; Ctrl+C fault остава UNVERIFIED |
| R7-20 | **PASS — EXECUTED ON WINDOWS**: schema9/STEPS1–9, default APK/build checks и production-owner tests; няма activation, AutoSync или background mode |
| R7-21 | **UNVERIFIED** за hosted CI на новото дърво: промените са непубликувани и publication е забранена в тази задача; локалните gates са в §J |
| R7-22 | **PASS — EXECUTED ON PHYSICAL DEVICE**: actual S22 ARM64/API36, свеж XML/logs и two-phase native LAN evidence, отделно от emulator/synthetic резултати |

Няма `PASS — EXECUTED ON EMULATOR` в тази R7 сесия. Има physical ARM64/LAN
доказателство само за изброените сценарии. Няма blanket hardware fault
acceptance, physical disk-full/power-loss или independent security certification.

## I. Възпроизвеждане — PowerShell от repository root

За собственика е запазен и локален скрипт с действително разрешените device/LAN
стойности: `%TEMP%/arthur-r7-s22-reproduce.ps1`. Той е извън Git, parser-ът му
е проверен; самият комбиниран скрипт не е изпълняван повторно след успешния run.
В repository командите по-долу serial-ът се въвежда от собственика.

Предпоставки: Rust/MSVC Windows toolchain, Node/npm dependencies от lockfiles,
JDK, SDK37/build tools/cmdline-tools, NDK29.0.14206865, USB drivers, ARM64 Android
телефон API29+, USB debugging и изрична device authorization. Двата endpoints
трябва да са на разрешена обща private Wi-Fi/Ethernet мрежа без VPN, cellular
fallback, router/client isolation или portal. Не отваряйте публичен firewall
порт. Ако Windows откаже връзката, проверете локалната Private-profile policy
със собственика на машината; runner-ът не създава разрешителни firewall правила.

Build, без телефон:

```powershell
$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'C:/Program Files/Java/jdk-25.0.2' # действителният JDK на този host
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME/ndk/29.0.14206865"
$android = Join-Path (Get-Location) 'apps/arthur/src-tauri/gen/android'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
rustup target add aarch64-linux-android
if ($LASTEXITCODE -ne 0) { throw 'ARM64 Rust target installation failed' }
& "$android/test-qualification.ps1"
& "$android/verify-identity.ps1" -Target aarch64 -BuildOnly
& "$android/verify-network.ps1" -Target aarch64 -BuildOnly
```

Build-овете трябва да завършат успешно преди следващата стъпка. И двата
скрипта проверяват package/ABI/JNI; при грешка не продължавайте ръчно с APK.
Не вмъквайте ordinary Android build между qualification build и network
packaging: той правилно заменя `.so` с вариант без test JNI и следващата
qualification inspection ще го откаже. Повторете qualification build вместо
да пропускате проверката.

Installation и direct LAN (попълват се само действителни разрешени стойности):

```powershell
& $adb devices -l
$serial = Read-Host 'Authorized physical ARM64 ADB serial'
$windowsLan = Read-Host 'Permitted Windows LAN IPv4 address'
$androidLan = Read-Host 'Permitted Android LAN IPv4 address'
& $adb -s $serial shell getprop ro.product.cpu.abilist
& $adb -s $serial shell getprop ro.build.version.sdk
& $adb -s $serial install -r "$android/qualification-network/build/outputs/apk/debug/arthur-network-qualification-debug.apk"
if ($LASTEXITCODE -ne 0) { throw 'Qualification APK installation failed' }
& $adb -s $serial install -r "$android/qualification-network/build/outputs/apk/androidTest/debug/arthur-network-qualification-debug-androidTest.apk"
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation APK installation failed' }
# На API37 дайте изрично local-network permission в Settings за test app.
& "$android/verify-cross-device.ps1" -Physical -Serial $serial `
    -LanAddress $windowsLan -AndroidAddress $androidLan -AndroidSourcePort 37432
```

За пълните съществуващи Keystore/TLS device probes, преди network installation,
може да се изпълни `verify-identity.ps1 -Serial $serial -Target aarch64`.
`verify-network.ps1 -Serial $serial -Target aarch64` инсталира standalone
пакетите и избира точно четирите действителни native network/history probes;
не отчита assumption-skipped LAN methods като извършено тестване.

При завършен transfer конзолата показва `Evidence: <directory>`. Следният
read-only преглед извежда IDs/hashes на действително импортираните Capture rows:

```powershell
$evidence = Read-Host 'Evidence directory printed by the runner'
$sha = [Security.Cryptography.SHA256]::Create()
try {
    foreach ($endpoint in @('result','android-result')) {
        $value = Get-Content -LiteralPath (Join-Path $evidence "$endpoint-2.json") -Raw | ConvertFrom-Json
        "Endpoint $endpoint; PID $($value.pid); outstanding $($value.outstanding.Count)"
        foreach ($event in $value.events) {
            foreach ($row in $event.rows) {
                if ($row.PSObject.Properties.Name -contains 'content') {
                    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($row.content))).Replace('-','')
                    [pscustomobject]@{ Endpoint=$endpoint; Capture=$row.id; Event=$event.event; ContentSHA256=$hash }
                }
            }
        }
        $value.cursors | Format-Table
        $value.proofs | Format-Table
    }
} finally { $sha.Dispose() }
```

И двата endpoint резултата трябва да имат двата Capture IDs/content hashes,
3 еднакви events и phase2 `outstanding.Count=0`. Exact bytes/rows/proofs/cursor
и restart assertions вече се изпълняват от native runner/контролера.
Фаза 2 е reconnect проверката. Повторно извикване на целия runner създава
нова изолирана Windows fixture и почиства/подготвя dedicated Android fixture;
то не е продължение на стара лична база.

За спиране използвайте Ctrl+C и изчакайте cleanup. При device disconnect
cleanup може да остане непотвърден; върнете същия телефон и изпълнете само
dedicated cleanup:

```powershell
& $adb -s $serial shell am force-stop dev.kaloyan.arthur.identitytest
& $adb -s $serial shell am instrument -w -e arthurR4Lan true `
    -e class 'dev.kaloyan.arthur.security.NativeIdentityBridgeTest#cleanup' `
    dev.kaloyan.arthur.identitytest.test/androidx.test.runner.AndroidJUnitRunner
```

При непотвърдено Windows cleanup пазете отпечатания temp път и лога за
диагностика; не трийте произволни Arthur директории. Възможно е повторно
извикване на exact Windows cleanup entrypoint със същия temp root, както прави
`finally`; първо проверете root/PID/log, не използвайте production data root.
Dedicated app може да се деинсталира през Android Settings. Не изтривайте
`dev.kaloyan.arthur` или неговите данни.

Изолацията е по package identity, проверката в native `test_directory()`,
cache-only fixture root и Windows temp-root ограничението. Нито build, нито
controller командите отварят личния production `arthur.db`. Това е проверка
на обхвата на инструментите; няма извършено отваряне/хеширане на личната база
за „доказателство“.

## J. Regression evidence

Командите са изпълнени локално върху това непубликувано работно дърво.
Log файловете са в `%TEMP%/arthur-r7-*.log`.

| Команда | Изпълнена среда / резултат | Log suffix |
| --- | --- | --- |
| `cargo check --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --all-targets` | **PASS — EXECUTED ON WINDOWS**, exit0 | `final-check.log` |
| `cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- --test-threads=1` | **PASS — EXECUTED ON WINDOWS**, exit0, 1,463 PASS / 0 FAIL / 26 ignored, 1,123.42 s; завършил на 2026-11-03 22:42:50 Europe/Sofia | `s22-final-native-complete.log`, completion record `.json` |
| `cargo fmt --manifest-path apps/arthur/src-tauri/Cargo.toml -- --check` | **PASS — EXECUTED ON WINDOWS**, exit0 | `fmt.log` |
| `cargo clippy --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- -D clippy::all` | **PASS — EXECUTED ON WINDOWS**, exit0; 493 съществуващи rustc warnings, не warning-free build | `final-clippy.log` |
| `npm run test:architecture` | **PASS — EXECUTED ON WINDOWS**, 88/88, без промяна на съществуващите assertions | `final-architecture.log` |
| `npm run arthur:check` | **PASS — EXECUTED ON WINDOWS**, 561/561 в 42 файла, typecheck и frontend production build; изпълнен преди последните qualification-only Rust промени, без последващи frontend edits; съществуващ bundle-size warning | `frontend.log` |
| `git diff --check` | **PASS — EXECUTED ON WINDOWS**, exit0 | финална проверка на работното дърво |
| `gen/android/test-qualification.ps1` | **PASS — SYNTHETIC ONLY**, 33 host safety checks, без device/network/SQLite | `s22-host-final.log` |
| PowerShell parser за петте `gen/android/*.ps1` и локалния reproduction script | **PASS — EXECUTED ON WINDOWS**, 6 scripts без syntax errors | локална parser проверка |
| `src/sync/security/qualification/verify-isolation.ps1` | **PASS — EXECUTED ON WINDOWS**, 6 normal/lab graphs: Windows, x86_64 Android, ARM64 Android | `isolation.log`, `arthur-r7-isolation/` |
| `verify-identity.ps1 -Target aarch64 -BuildOnly` | **PASS — EXECUTED ON WINDOWS**, final application + instrumentation build и inspection | `s22-final-build.log` |
| `verify-identity.ps1 -Target x86_64 -BuildOnly` | **PASS — EXECUTED ON WINDOWS**, emulator-ABI build compatibility; няма emulator execution | `x86-build.log` |
| `verify-network.ps1 -Target aarch64 -Serial <actual serial>` | **PASS — EXECUTED ON PHYSICAL DEVICE**, standalone ARM64 application + instrumentation build/inspection, installation и 4 native probes, 5.135 s; няма release variant | `s22-final-network.log` |
| APK inspection след крайния helper update | **PASS — EXECUTED ON WINDOWS**, actual ARM64 APK/targetPackage; wrong ABI и actual production APK са отказани, без install | `apk-inspection.log` |
| `npm run tauri --prefix apps/arthur -- android build --debug --target aarch64 --apk --ci` | **PASS — EXECUTED ON WINDOWS**, final ordinary default APK, без test feature/config; не е release build | `s22-final-default.log` |
| Default APK manifest + LLVM dynamic exports | **PASS — EXECUTED ON WINDOWS**, production ID; INTERNET/RECORD_AUDIO и existing receiver permission; без LAN permissions; точно двата existing security JNI exports install/networkChanged | `s22-final-isolation.log` |
| `verify-identity.ps1 -Target aarch64 -Serial <actual serial>` | **PASS — EXECUTED ON PHYSICAL DEVICE**, S22/API36, 49/49, 196.112 s, restart prepare1/reopen1 | `s22-identity.log`, `s22-identity-results.xml` |
| `verify-cross-device.ps1 -Physical ...` | **PASS — EXECUTED ON PHYSICAL DEVICE**, canonical events/mutual TLS, двупосочни данни, lost ACK и двата process restarts; останалите fault injections са UNVERIFIED (§H) | `s22-lan-final.log`, §E evidence directory |
| Нов hosted CI / release packaging | **UNVERIFIED**; няма publication или release build | няма new hosted run |

Пълният по-ранен R7 baseline е 1,460 PASS / 0 FAIL / 26 ignored, 946.26 s
(`native.log`). След физическите дефекти са добавени точно три native R7
regressions. Всяка е възпроизведена като FAIL преди съответната поправка и PASS
след нея: diagnostic cause през boolean JNI, idle-peer scheduling и lost-ACK
publication. Последното поправя stale harness очакване: negative phase трябва
да е `Syncing`/2 pending, resume — `CleanlyApplied`/0 pending, без attention.
Не са отслабвани engine/security assertions, budgets, timeouts или fixture
limits. Host safety checks са отделна серия и не се добавят към native/Android
броя. Крайният завършил run е 1,463 PASS / 0 FAIL / 26 ignored: +3 PASS
спрямо baseline, същите 26 ignored. Предишният прекъснат процес
(`s22-final-native.log`) няма summary и не се брои за завършил.

Трите нови native regressions са:

- `r7_io_failure_survives_the_boolean_jni_boundary_without_payloads`;
- `r7_local_engine_work_does_not_wait_for_an_idle_peer`;
- `r7_lost_receipt_publication_is_pending_and_resume_requires_durable_clean`.

Преди поправките: `diagnostic-before.log`, `scheduling-before.log`,
`publication-before.log` — по1 FAIL. След поправките: `targeted-final.log`
— трите R7 tests PASS, без промяна на production assertions. Всички тези имена
имат префикс `%TEMP%/arthur-r7-`.

В този run минаха включително:

- `r5_tls_approval_history_remains_unsupported_without_automatic_review` и
  `r5_tls_foreign_selected_head_cannot_overwrite_locally_authored_head`;
- `r6_tls_missing_chunk_and_wrong_offer_never_publish_or_acknowledge`;
- `r6_tls_unavailable_original_dependency_quiesces_with_durable_attention`;
- `r6_tls_committed_budget_restore_failure_sends_no_ack_then_reopens_and_converges`;
- `r6_tls_published_bootstrap_without_durable_receipt_is_not_clean`;
- двете near-cap/bootstrap row-count regressions и съществуващите native
  cancellation/identity/route откази.

Това са Windows tests със synthetic histories/локални test sockets. Отделното
physical Android LAN доказателство е в §E; Windows tests сами по себе си не го
заместват и не доказват per-original signature integration или G4 worst-case
bounds. Предишен успешен
[hosted CI на началния HEAD](https://github.com/Kaloyan3D/A.R.T.H.U.R/actions/runs/41540444352)
е само baseline и не доказва новите непубликувани промени.

## K. Неприключени release gates

N1 остава blocked: няма независима security approval и няма промяна/потискане
на advisory за locked `crypto-bigint 0.5.5` в qualification PAKE closure.
Няма промяна на OPAQUE, шестцифрено raw-secret pairing, trust-all TLS или
публично enrollment. G4 остава `UnverifiedBounds`; синтетичната candidate v10
fixture policy не е одобрен production worst-case bound. G5 historical
approval/foreign-head решенията остават fail-closed. Другите N/G approvals,
physical fault acceptance и истинските release artifacts остават отделни gates.

Production остава `SCHEMA_VERSION=9`, `STEPS=1..=9`, dormant Sync/ClosedTrust/
ClosedLan, без AutoSync/background mode. Няма production migration или лични
данни в тази задача.

## L. Присъда

**R7 PHYSICAL SYNC LAB — BLOCKED BY CONCRETE INTEGRATION DEFECT**

Direct Windows ↔ S22 canonical-event/mutual-TLS lab е изпълнен успешно в две
фази: 3 persisted originals/rows от двата origins, lost ACK, двата process
restarts, 0 pending при resume и без дубликати/ADB reverse. Изолираните бази са
почистени. Двете stale harness предпоставки са поправени и имат regressions;
добавена е bounded диагностика, без промяна на production engine/wire/security.

Пълният P2 не е изпълнен: съществуващият fixture transport
не пренася `SignedOriginal`, което оставя per-original signature изискването
непокрито и след успешния физически run. Това е конкретна липсваща интеграция,
не нов възпроизведен runtime regression в тези промени. Не е добавен собствен
wire/security протокол, за да се прикрие липсата.

Физическото устройство и разрешеният LAN вече са проверени; телефонът може
да бъде изключен след завършилия cleanup. R7-14/15/17/18 остават частично или
изцяло UNVERIFIED за отделните physical fault injections. Per-original signature
integration, N1, G4, G5, hosted CI върху това дърво и release artifacts остават
неприключени. Доставеният CLI milestone не е production activation или release
approval. При квалификацията няма stage, commit, push, merge или промяна на
лична база. Последващата Git публикация е изрично разрешена от собственика.
