use crate::sync_api::codec;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

pub(crate) const MAX_EVENTS: usize = 256; // receiver retained-event budget
pub(crate) const SUMMARY_PAGE: usize = 64;
pub(crate) const REPROCESS_BATCH: usize = 16;
pub(crate) type PageKey = (Uuid, Uuid, i64);
pub(crate) const CHUNK: usize = 256 * 1024;
pub(crate) const MAX_FRAME: usize = 1024 * 1024;
pub(crate) const MAX_BATCH: usize = 2;
pub(crate) const MAX_ASSEMBLIES: usize = 2;
pub(crate) const FEATURES: u32 = 31; // ledger, chunking, conflict receipts, paginated inventory, bootstrap v1
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    Trust,
    Integrity,
    Protocol,
    Limit,
    Cancelled,
    Storage,
    /// COMMIT failed; authoritative state must be reconciled after reopening.
    CommitUncertain,
    /// SQLite COMMIT succeeded, but physical-budget cleanup did not.
    CommittedCleanupFailed,
    ActivationPending,
    Disconnected,
    StorageLimited,
    SnapshotTooLarge,
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) enum Outcome {
    CleanlyApplied,
    ConflictRetained,
    DeferredDependency,
    UnsupportedImportPolicy,
    RejectedIntegrity,
}
impl Outcome {
    pub fn code(self) -> &'static str {
        match self {
            Self::CleanlyApplied => "applied",
            Self::ConflictRetained => "conflict",
            Self::DeferredDependency => "deferred",
            Self::UnsupportedImportPolicy => "unsupported",
            Self::RejectedIntegrity => "rejected",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "applied" => Ok(Self::CleanlyApplied),
            "conflict" => Ok(Self::ConflictRetained),
            "deferred" => Ok(Self::DeferredDependency),
            "unsupported" => Ok(Self::UnsupportedImportPolicy),
            "rejected" => Ok(Self::RejectedIntegrity),
            _ => Err(Error::Storage),
        }
    }
    pub fn is_ack(self) -> bool {
        matches!(self, Self::CleanlyApplied | Self::ConflictRetained)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) enum SyncStatus {
    Syncing,
    CleanlyApplied,
    ConflictRetained,
    DeferredDependency,
    UnsupportedImportPolicy,
    StorageLimited,
    RejectedIntegrity,
    RejectedTrust,
}
impl From<Outcome> for SyncStatus {
    fn from(o: Outcome) -> Self {
        match o {
            Outcome::CleanlyApplied => Self::CleanlyApplied,
            Outcome::ConflictRetained => Self::ConflictRetained,
            Outcome::DeferredDependency => Self::DeferredDependency,
            Outcome::UnsupportedImportPolicy => Self::UnsupportedImportPolicy,
            Outcome::RejectedIntegrity => Self::RejectedIntegrity,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Identity {
    pub event: Uuid,
    pub bundle: Uuid,
    pub origin: Uuid,
    pub incarnation: Uuid,
    pub seq: i64,
    pub hash: [u8; 32],
}
// Core bytes deliberately have no Debug implementation.
#[derive(Clone)]
pub(crate) struct Envelope {
    pub identity: Identity,
    pub bytes: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Progress {
    pub origin: Uuid,
    pub incarnation: Uuid,
    pub stored: i64,
    pub integrated: i64,
    pub applied: i64,
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Summary {
    pub known: Vec<Identity>,
    pub next: Option<PageKey>,
    pub progress: Vec<Progress>,
    pub needs_attention: bool,
    pub status: SyncStatus,
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Chunk {
    pub identity: Identity,
    pub index: usize,
    pub count: usize,
    pub total: usize,
    pub digest: [u8; 32],
    pub bytes: Vec<u8>,
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Receipt {
    pub identity: Identity,
    pub outcome: Outcome,
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) enum Payload {
    Hello {
        version: u32,
        required: u32,
        supported: u32,
        profile: String,
    },
    Summary(Summary),
    Page(PageKey),
    SnapshotOffer(super::bootstrap::SnapshotOffer),
    SnapshotChunk(super::bootstrap::SnapshotChunk),
    SnapshotPublish(super::bootstrap::SnapshotOffer),
    SnapshotReceipt(super::bootstrap::SnapshotReceipt),
    Chunk(Chunk),
    Receipt(Receipt),
    Request(Vec<Uuid>),
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct Message {
    pub network: Uuid,
    pub session: Uuid,
    pub from: Uuid,
    pub to: Uuid,
    pub payload: Payload,
}
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(serde::Serialize, serde::Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct PeerHello {
    pub network: Uuid,
    pub session: Uuid,
    pub local: Uuid,
    pub peer: Uuid,
    pub epoch: i64,
}
pub(crate) trait AuthenticatedTransport {
    fn hello(&self) -> PeerHello;
    fn send(&mut self, message: Message) -> Result<()>;
    fn receive(&mut self) -> Result<Option<Message>>;
}
pub(crate) trait SyncClock {
    fn now(&self) -> u64;
}
#[derive(Default)]
pub(crate) struct Cancellation(AtomicBool);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst)
    }
    pub fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
pub(crate) fn chunk_event(e: &Envelope) -> Vec<Chunk> {
    let count = e.bytes.len().div_ceil(CHUNK);
    e.bytes
        .chunks(CHUNK)
        .enumerate()
        .map(|(index, bytes)| Chunk {
            identity: e.identity.clone(),
            index,
            count,
            total: e.bytes.len(),
            digest: codec::journal_event_hash(bytes),
            bytes: bytes.to_vec(),
        })
        .collect()
}
