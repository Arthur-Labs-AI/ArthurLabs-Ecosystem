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
fn count(f: &Fixture, table: &str) -> i64 {
    f.owner()
        .store()
        .connection
        .lock()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn prepare() {
    let base = root();
    std::fs::create_dir_all(&base).unwrap();
    // Android's dedicated cache location is reused across explicit runs. Never
    // accept an earlier run's result or completion barrier as current evidence.
    for name in [
        "public.json",
        "peer.json",
        "listen.json",
        "result-1.json",
        "result-2.json",
        "finish-1",
        "finish-2",
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
        values.push(serde_json::json!({"event":event.identity.event,"hash":event.identity.hash,"bytes":event.bytes,"rows":rows}));
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
    serde_json::json!({"pid":std::process::id(),"key":f.public.sec1(),"events":values})
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
    let (pool, permit, timer) = owner
        .transport_candidate()
        .admit_loopback_lab(
            Expected {
                network: NETWORK,
                peer: pin.peer_id(),
            },
            &stop,
        )
        .unwrap();
    #[cfg(windows)]
    let (raw, key, role) = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        write(
            base.join("listen.json"),
            &serde_json::json!({"port":listener.local_addr().unwrap().port(),"phase":phase,"pid":std::process::id()}),
        );
        (
            native_io_lab::accept_loopback(listener, permit, timer)
                .await
                .unwrap(),
            f.key(CertificateRole::Server).unwrap(),
            CertificateRole::Server,
        )
    };
    #[cfg(target_os = "android")]
    let (raw, key, role) = (
        native_io_lab::connect_loopback("127.0.0.1:37431".parse().unwrap(), permit, timer)
            .await
            .unwrap(),
        f.key(CertificateRole::Client).unwrap(),
        CertificateRole::Client,
    );
    let (wire, mut transport) = Endpoint::authenticate(raw, key, &pin, role, hello, || {
        store.authorize(&verified, &Clock, &cancel)
    })
    .await
    .unwrap();
    // Reuse the existing receipt-loss fixture AFTER encrypted transport, not a
    // substitute transport. Phase 2 must recover both persisted offers.
    transport.lose_receipts = cfg!(windows) && phase == 1;
    let mut engine = SyncEngine::start(&store, transport, &trust, &Clock, &cancel).unwrap();
    #[cfg(target_os = "android")]
    let mut created = false;
    let mut messages = 0;
    loop {
        if engine.tick().unwrap() {
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
        let receipts = if cfg!(windows) && phase == 1 {
            !acknowledged && pending.len() == 2
        } else {
            acknowledged && pending.is_empty()
        };
        if messages >= 2
            && receipts
            && count(&f, "captures") == 2
            && !engine.needs_attention
            && engine.status == SyncStatus::CleanlyApplied
        {
            wire.flush().await.unwrap();
            break;
        }
        wire.step().await.unwrap();
    }
    let mut result = evidence(&f);
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
