#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SecurityError {
    N1AuditPending,
    N2PolicyPending,
    N7PolicyPending,
    PlatformUnverified,
    MissingKey,
    KeyUnavailable,
    AlreadyExists,
    Invalid,
    Signature,
    Trust,
    Replay,
    Fork,
    Limit,
    State,
    Expired,
    Locked,
    Storage,
    ActivationPending,
    Cancelled,
}
pub(crate) type Result<T> = std::result::Result<T, SecurityError>;
pub(crate) fn canonical<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    let b = serde_jcs::to_vec(value).map_err(|_| SecurityError::Invalid)?;
    if b.len() > 16384 {
        return Err(SecurityError::Limit);
    }
    Ok(b)
}
