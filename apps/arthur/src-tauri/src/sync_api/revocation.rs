use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Expected {
    pub network: Uuid,
    pub peer: Uuid,
}

/// Owner-injected notification after the durable registry transaction commits.
/// An error reports degraded notification, never rollback of that commit.
pub(crate) trait RevocationNotifier: Send + Sync {
    fn revoked(&self, expected: Expected) -> super::security_error::Result<()>;
}
