use super::{bootstrap::*, protocol::*, trust::VerifiedSession, validation::ValidatedEvent};
use uuid::Uuid;

pub(crate) trait SyncStore {
    fn settle(
        &self,
        session: &VerifiedSession,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<(usize, bool)>;
    fn retained_receipt(
        &self,
        session: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Receipt>;
    fn snapshot_capture(
        &self,
        session: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<SnapshotExport>;
    fn snapshot_offer(
        &self,
        session: &VerifiedSession,
        offer: &SnapshotOffer,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn snapshot_chunk(
        &self,
        session: &VerifiedSession,
        chunk: &SnapshotChunk,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn snapshot_publish(
        &self,
        session: &VerifiedSession,
        offer: &SnapshotOffer,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<SnapshotReceipt>;
    fn snapshot_receipt(
        &self,
        session: &VerifiedSession,
        receipt: &SnapshotReceipt,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn authorize(
        &self,
        session: &VerifiedSession,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn summary(
        &self,
        session: &VerifiedSession,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Summary>;
    fn page(
        &self,
        session: &VerifiedSession,
        after: Option<PageKey>,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Summary>;
    fn lookup(
        &self,
        session: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Option<Identity>>;
    fn export(
        &self,
        session: &VerifiedSession,
        id: &Identity,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Envelope>;
    fn retain(
        &self,
        session: &VerifiedSession,
        event: ValidatedEvent,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Receipt>;
    fn offered(
        &self,
        session: &VerifiedSession,
        id: &Identity,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn receipt(
        &self,
        session: &VerifiedSession,
        receipt: &Receipt,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<()>;
    fn outstanding(
        &self,
        session: &VerifiedSession,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Vec<Uuid>>;
    fn missing(
        &self,
        session: &VerifiedSession,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Vec<Uuid>>;
}
