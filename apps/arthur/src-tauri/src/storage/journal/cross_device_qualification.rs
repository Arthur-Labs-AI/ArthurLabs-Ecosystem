//! Explicit disposable cross-process runner; reuses the one TLS/engine path.
#[cfg(not(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
)))]
compile_error!("Cross-device qualification is forbidden outside tests/debug instrumentation");
use super::{codec, sql_effects, storage::JournalKernel};
use crate::{
    storage::{
        capture_store::CreateCaptureInput,
        migrations,
        security_tls_tests::Fixture,
        sync_store::{self, CandidateSyncStore},
    },
    sync::{
        security::{
            self,
            identity::PublicIdentity,
            native_io_lab,
            tls::CertificateRole,
            tls_socket_lab::Endpoint,
            transport_candidate::{Expected, Interrupt},
        },
        trust::TestTrust,
        *,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;
const NETWORK: Uuid = Uuid::from_u128(7300);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Public {
    key: Vec<u8>,
    origin: Uuid,
    pid: u32,
}
// Explicit controller input inside the disposable fixture only; IPv4 LAN mode.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lan {
    windows: std::net::Ipv4Addr,
    android: std::net::Ipv4Addr,
    source_port: u16,
    server_port: u16,
}
struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        0
    }
}
fn root() -> PathBuf {
    #[cfg(windows)]
    {
        let p = PathBuf::from(std::env::var("ARTHUR_R3_DIR").expect("explicit runner directory"));
        assert!(
            p.is_absolute()
                && p.parent().unwrap().canonicalize().unwrap()
                    == std::env::temp_dir().canonicalize().unwrap()
        );
        assert!(p
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("arthur-r3-"));
        p
    }
    #[cfg(target_os = "android")]
    {
        security::android::bridge()
            .unwrap()
            .test_directory()
            .unwrap()
            .parent()
            .unwrap()
            .join("r3-cross-device")
    }
}
fn write(path: impl AsRef<Path>, value: &impl Serialize) {
    let bytes = serde_json::to_vec(value).unwrap();
    let path = path.as_ref();
    let temporary = path.with_extension("publishing");
    std::fs::write(&temporary, bytes).unwrap();
    std::fs::rename(temporary, path).unwrap();
}
fn read<T: serde::de::DeserializeOwned>(path: impl AsRef<Path>) -> T {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.len() <= 2 * 1024 * 1024);
    serde_json::from_slice(&bytes).unwrap()
}
fn checked_io<T>(
    base: &Path,
    phase: u32,
    stage: &'static str,
    result: std::result::Result<T, native_io_lab::Fault>,
) -> T {
    result.unwrap_or_else(|fault| failed(base, phase, stage, format!("{fault:?}")))
}
fn checked_sync<T>(base: &Path, phase: u32, stage: &'static str, result: Result<T>) -> T {
    result.unwrap_or_else(|fault| failed(base, phase, stage, format!("{fault:?}")))
}
fn failed(base: &Path, phase: u32, stage: &'static str, fault: String) -> ! {
    // Only the closed I/O/Sync error enums reach this boundary. No arbitrary
    // panic text, event bytes, key material or endpoint configuration is logged.
    write(
        base.join("failure.json"),
        &serde_json::json!({"pid":std::process::id(),"phase":phase,"stage":stage,"fault":fault}),
    );
    panic!("cross-device qualification failed at {stage}");
}
#[cfg(test)]
#[test]
fn r7_io_failure_survives_the_boolean_jni_boundary_without_payloads() {
    let base = tempfile::tempdir().unwrap();
    let result = std::panic::catch_unwind(|| {
        checked_io::<()>(
            base.path(),
            1,
            "connect",
            Err(native_io_lab::Fault::Io(
                std::io::ErrorKind::ConnectionRefused,
            )),
        )
    });
    assert!(result.is_err());
    let report: serde_json::Value = read(base.path().join("failure.json"));
    assert_eq!(report["phase"], 1);
    assert_eq!(report["stage"], "connect");
    assert_eq!(report["fault"], "Io(ConnectionRefused)");
    assert_eq!(report["pid"], std::process::id());
    assert_eq!(report.as_object().unwrap().len(), 4);
}
fn count(f: &Fixture, table: &str) -> i64 {
    f.owner()
        .store()
        .connection
        .lock()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn publication_ready(
    lose_receipts: bool,
    worked: bool,
    acknowledged: bool,
    pending: usize,
    status: SyncStatus,
    needs_attention: bool,
) -> bool {
    let receipts = if lose_receipts {
        !acknowledged && pending == 2
    } else {
        acknowledged && pending == 0
    };
    let expected = if lose_receipts {
        // This is an intentionally incomplete delivery phase, never convergence.
        SyncStatus::Syncing
    } else {
        SyncStatus::CleanlyApplied
    };
    !worked && receipts && !needs_attention && status == expected
}
#[cfg(test)]
#[test]
fn r7_lost_receipt_publication_is_pending_and_resume_requires_durable_clean() {
    assert!(publication_ready(
        true,
        false,
        false,
        2,
        SyncStatus::Syncing,
        false
    ));
    assert!(!publication_ready(
        true,
        false,
        false,
        2,
        SyncStatus::CleanlyApplied,
        false
    ));
    assert!(!publication_ready(
        true,
        true,
        false,
        2,
        SyncStatus::Syncing,
        false
    ));
    assert!(!publication_ready(
        false,
        false,
        false,
        2,
        SyncStatus::Syncing,
        false
    ));
    assert!(!publication_ready(
        false,
        false,
        true,
        0,
        SyncStatus::Syncing,
        false
    ));
    assert!(publication_ready(
        false,
        false,
        true,
        0,
        SyncStatus::CleanlyApplied,
        false
    ));
    assert!(!publication_ready(
        false,
        false,
        true,
        0,
        SyncStatus::CleanlyApplied,
        true
    ));
}
fn prepare() {
    let base = root();
    std::fs::create_dir_all(&base).unwrap();
    // Android's dedicated cache location is reused across explicit runs. Never
    // accept an earlier run's result or completion barrier as current evidence.
    for name in [
        "lan.json",
        "public.json",
        "peer.json",
        "listen.json",
        "result-1.json",
        "result-2.json",
        "finish-1",
        "finish-2",
        "failure.json",
    ] {
        match std::fs::remove_file(base.join(name)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => panic!("fixture publication cleanup: {e}"),
        }
    }
    let mut f = Fixture::at(base.join("db"), false).unwrap();
    let owner = f.owner();
    {
        let mut c = owner.store().connection.lock().unwrap();
        let mut steps = migrations::STEPS.to_vec();
        steps.push((10, include_str!("../m05_v10.sql")));
        migrations::migrate_with(&mut c, &steps).unwrap();
    }
    sync_store::install_candidate(owner.store(), NETWORK, f.public.peer_id(), &[]).unwrap();
    super::g3::install(owner.store()).unwrap();
    let k = JournalKernel::activate(owner.store()).unwrap();
    #[cfg(windows)]
    {
        let p = k
            .write(|w| w.create_project("Windows → Android R3"))
            .unwrap();
        k.write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "🚀".repeat(20_000),
                project_id: Some(p.id),
            })
        })
        .unwrap();
    }
    drop(k);
    let origin: String = owner
        .store()
        .connection
        .lock()
        .unwrap()
        .query_row("SELECT origin_id FROM sync_local", [], |r| r.get(0))
        .unwrap();
    write(
        base.join("public.json"),
        &Public {
            key: f.public.sec1().to_vec(),
            origin: Uuid::parse_str(&origin).unwrap(),
            pid: std::process::id(),
        },
    );
    f.preserve_for_restart();
}
fn evidence(f: &Fixture) -> serde_json::Value {
    let owner = f.owner();
    let events = sync_store::test_events(owner.store());
    assert_eq!(events.len(), 3);
    for table in [
        "knowledge_objects",
        "revision_proposals",
        "distillation_runs",
    ] {
        assert_eq!(count(f, table), 0);
    }
    assert_eq!(count(f, "import_events"), count(f, "import_g3_commits"));
    let c = owner.store().connection.lock().unwrap();
    let mut values = Vec::new();
    for event in events {
        let v = ValidatedEvent::parse(event.clone()).unwrap();
        let rows = v
            .core()
            .operations
            .iter()
            .map(|op| {
                assert!(matches!(op, codec::Operation::RecordCreate(_)));
                {
                    let row = sql_effects::reread(&c, op.entity(), op.key())
                        .unwrap()
                        .unwrap();
                    serde_json::Value::Object(
                        row.into_iter().map(|(k, v)| (k, v.to_json())).collect(),
                    )
                }
            })
            .collect::<Vec<_>>();
        values.push(serde_json::json!({"event":event.identity.event,"origin":event.identity.origin,"incarnation":event.identity.incarnation,"seq":event.identity.seq,"hash":event.identity.hash,"bytes":event.bytes,"rows":rows}));
    }
    values.sort_by_key(|v| v["event"].as_str().unwrap().to_owned());
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        c.query_row("SELECT count(*) FROM sync_write_context", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM import_events WHERE outcome!='applied'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );

    // Inspect each endpoint's own import proofs/cursors. Local originals and
    // remote imports differ, so these are not falsely compared across devices.
    let proofs=c.prepare("SELECT e.event,hex(e.hash),e.origin,e.incarnation,e.seq,g.version FROM import_events e JOIN import_g3_commits g ON g.event=e.event ORDER BY e.event").unwrap()
        .query_map([],|r|Ok(serde_json::json!({"event":r.get::<_,String>(0)?,"hash":r.get::<_,String>(1)?,"origin":r.get::<_,String>(2)?,"incarnation":r.get::<_,String>(3)?,"seq":r.get::<_,i64>(4)?,"version":r.get::<_,i64>(5)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let cursors=c.prepare("SELECT origin,incarnation,stored,integrated,applied,(SELECT max(seq) FROM import_events e WHERE e.origin=p.origin AND e.incarnation=p.incarnation) FROM import_progress p ORDER BY origin,incarnation").unwrap()
        .query_map([],|r|{
            let stored:i64=r.get(2)?;let integrated:i64=r.get(3)?;let applied:i64=r.get(4)?;let maximum:i64=r.get(5)?;
            assert_eq!((stored,integrated,applied),(maximum,maximum,maximum));
            Ok(serde_json::json!({"origin":r.get::<_,String>(0)?,"incarnation":r.get::<_,String>(1)?,"stored":stored,"integrated":integrated,"applied":applied}))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(proofs.len(), if cfg!(windows) { 1 } else { 2 });
    assert_eq!(cursors.len(), 1);
    serde_json::json!({"pid":std::process::id(),"key":f.public.sec1(),"events":values,"proofs":proofs,"cursors":cursors})
}
async fn exchange(phase: u32) {
    let base = root();
    let mut f = Fixture::at(base.join("db"), true).unwrap();
    f.preserve_for_restart();
    let local: Public = read(base.join("public.json"));
    let peer: Public = read(base.join("peer.json"));
    assert_eq!(local.key, f.public.sec1());
    let pin = PublicIdentity::from_sec1(peer.key).unwrap();
    let owner = f.owner();
    {
        let c = owner.store().connection.lock().unwrap();
        c.execute(
            "INSERT OR IGNORE INTO import_members VALUES(?1,1,1)",
            [pin.peer_id().to_string()],
        )
        .unwrap();
    }
    let origins = BTreeSet::from([local.origin, peer.origin]);
    sync_store::grant_test_origins(owner.store(), pin.peer_id(), &origins);
    let hello = PeerHello {
        network: NETWORK,
        session: Uuid::from_u128(7300 + phase as u128),
        local: f.public.peer_id(),
        peer: pin.peer_id(),
        epoch: 1,
    };
    let trust = TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins,
    };
    let verified = trust.verify(&hello).unwrap();
    let store = CandidateSyncStore::synthetic(owner.store());
    let cancel = Cancellation::default();
    let stop = Arc::new(Interrupt::default());
    let lan: Option<Lan> = base
        .join("lan.json")
        .exists()
        .then(|| read(base.join("lan.json")));
    if let Some(lan) = &lan {
        assert!(
            lan.windows.is_private()
                && lan.android.is_private()
                && lan.windows != lan.android
                && lan.source_port != 0
        );
        owner.transport_candidate().start_monitor().unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while owner
            .transport_candidate()
            .native_qualification_fence()
            .is_err()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "native callbacks unavailable"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
    let expected = Expected {
        network: NETWORK,
        peer: pin.peer_id(),
    };
    let (pool, permit, timer) = if lan.is_some() {
        owner
            .transport_candidate()
            .admit_native_qualification(expected, &stop)
    } else {
        owner
            .transport_candidate()
            .admit_loopback_lab(expected, &stop)
    }
    .unwrap();
    #[cfg(windows)]
    let (raw, key, role) = {
        let listener = if let Some(lan) = &lan {
            checked_io(
                &base,
                phase,
                "listen",
                native_io_lab::listen_native_qualification(
                    (lan.android, lan.source_port).into(),
                    lan.windows.into(),
                    &permit,
                    &timer,
                ),
            )
        } else {
            tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
        };
        write(
            base.join("listen.json"),
            &serde_json::json!({"port":listener.local_addr().unwrap().port(),"phase":phase,"pid":std::process::id()}),
        );
        (
            if let Some(lan) = &lan {
                checked_io(
                    &base,
                    phase,
                    "accept",
                    native_io_lab::accept_native_qualification(
                        listener,
                        (lan.android, lan.source_port).into(),
                        permit,
                        timer,
                    )
                    .await,
                )
            } else {
                native_io_lab::accept_loopback(listener, permit, timer)
                    .await
                    .unwrap()
            },
            f.key(CertificateRole::Server).unwrap(),
            CertificateRole::Server,
        )
    };
    #[cfg(target_os = "android")]
    let (raw, key, role) = (
        if let Some(lan) = &lan {
            checked_io(
                &base,
                phase,
                "connect",
                native_io_lab::connect_native_qualification(
                    (lan.windows, lan.server_port).into(),
                    lan.android.into(),
                    lan.source_port,
                    permit,
                    timer,
                )
                .await,
            )
        } else {
            native_io_lab::connect_loopback("127.0.0.1:37431".parse().unwrap(), permit, timer)
                .await
                .unwrap()
        },
        f.key(CertificateRole::Client).unwrap(),
        CertificateRole::Client,
    );
    let (wire, mut transport) = checked_sync(
        &base,
        phase,
        "authenticate",
        Endpoint::authenticate(raw, key, &pin, role, hello, || {
            store.authorize(&verified, &Clock, &cancel)
        })
        .await,
    );
    // Reuse the existing receipt-loss fixture AFTER encrypted transport, not a
    // substitute transport. Phase 2 must recover both persisted offers.
    transport.lose_receipts = cfg!(windows) && phase == 1;
    let mut engine = SyncEngine::start(&store, transport, &trust, &Clock, &cancel).unwrap();
    #[cfg(target_os = "android")]
    let mut created = false;
    let mut messages = 0;
    loop {
        let worked = checked_sync(&base, phase, "engine", engine.tick());
        if worked {
            messages += 1;
        }
        #[cfg(target_os = "android")]
        if phase == 1 && !created && count(&f, "captures") == 1 {
            let project: String = owner
                .store()
                .connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT id FROM projects WHERE name='Windows → Android R3'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            JournalKernel::activate(owner.store())
                .unwrap()
                .write(|w| {
                    w.create_capture(CreateCaptureInput {
                        source: "text".into(),
                        content: "Android → Windows А́ 原文\n😀".into(),
                        project_id: Some(project),
                    })
                })
                .unwrap();
            created = true;
            engine.refresh().unwrap();
        }
        let acknowledged:bool=owner.store().connection.lock().unwrap().query_row("SELECT (SELECT count(*) FROM import_sent WHERE origin=?1 AND outcome='applied')=(SELECT count(*) FROM sync_bundles)",[local.origin.to_string()],|r|r.get(0)).unwrap();
        let pending = store.outstanding(&verified, &Clock, &cancel).unwrap();
        if messages >= 2
            && count(&f, "captures") == 2
            && publication_ready(
                cfg!(windows) && phase == 1,
                worked,
                acknowledged,
                pending.len(),
                engine.status,
                engine.needs_attention,
            )
        {
            checked_sync(&base, phase, "flush", wire.flush().await);
            break;
        }
        checked_sync(&base, phase, "transfer", wire.step_after_work(worked).await);
    }
    let mut result = evidence(&f);
    result["status"] = serde_json::json!(format!("{:?}", engine.status));
    result["needs_attention"] = serde_json::json!(engine.needs_attention);
    result["outstanding"] =
        serde_json::json!(store.outstanding(&verified, &Clock, &cancel).unwrap());
    result["endpoints"] = serde_json::json!(wire.endpoints().unwrap());
    write(base.join(format!("result-{phase}.json")), &result);
    // Out-of-band runner barrier only: no new wire message or Sync protocol.
    let finish = base.join(format!("finish-{phase}"));
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut disconnected = false;
        while !finish.exists() {
            // Continue servicing replay receipts. EOF after publication can
            // precede this process's finish file; the controller still requires
            // both durable results and successful exits within this deadline.
            if disconnected {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            match engine.tick() {
                Ok(_) => (),
                Err(Error::Disconnected) => {
                    disconnected = true;
                    continue;
                }
                Err(e) => panic!("barrier engine: {e:?}"),
            }
            match tokio::time::timeout(std::time::Duration::from_millis(50), wire.step()).await {
                Ok(Err(Error::Disconnected)) => disconnected = true,
                Ok(progress) => progress.unwrap(),
                Err(_) => (),
            }
        }
    })
    .await
    .unwrap();
    drop(engine);
    drop(wire);
    assert_eq!(pool.active_for_test(), 0);
    owner.transport_candidate().shutdown().unwrap();
    f.preserve_for_restart();
}
fn cleanup() {
    let base = root();
    drop(Fixture::at(base.join("db"), true).unwrap());
}
pub(crate) fn run(case: i32) -> security::Result<()> {
    std::panic::catch_unwind(|| match case {
        43 => prepare(),
        44 => native_io_lab::execute(exchange(1)),
        45 => native_io_lab::execute(exchange(2)),
        46 => cleanup(),
        _ => panic!("cross-device case"),
    })
    .map_err(|_| security::SecurityError::State)
}
#[cfg(windows)]
#[test]
#[ignore = "explicit independent-process Windows/Android runner only"]
fn r3_windows_external_endpoint() {
    let case = std::env::var("ARTHUR_R3_CASE").unwrap().parse().unwrap();
    run(case).unwrap();
}
