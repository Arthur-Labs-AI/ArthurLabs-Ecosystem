//! Separate versioned bootstrap candidate. Journal cores and accepted snapshot
//! v2 bytes are untouched. Envelopes bind explicit partial-history profiles.
use super::codec;
use super::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub(crate) const BOOTSTRAP_PROFILE: &str = "m05-bootstrap-immutable-v1";
pub(crate) const BOOTSTRAP_D4_PROFILE: &str = "m05-bootstrap-history-d4-v1";
pub(crate) const BOOTSTRAP_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const BOOTSTRAP_EVENTS: usize = 64;
pub(crate) const BOOTSTRAP_ROWS: usize = 2048;
// Original 4 MiB image budget is untouched. Signature evidence is separately
// staged and bounded: 64 originals * 16 KiB, plus 64 KiB manifest/prefix overhead.
pub(crate) const SIGNED_EVIDENCE_BYTES: usize = BOOTSTRAP_EVENTS * MAX_SIGNED_METADATA + 64 * 1024;
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(Serialize, Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct SignedSnapshotOffer {
    pub image: SnapshotOffer,
    pub evidence: SnapshotOffer,
}
impl SignedSnapshotOffer {
    pub fn validate(&self) -> Result<()> {
        self.image.validate()?;
        self.evidence.validate()?;
        if self.image.id != self.evidence.id || self.evidence.bytes > SIGNED_EVIDENCE_BYTES {
            return Err(Error::Limit);
        }
        Ok(())
    }
}
pub(crate) struct SignedSnapshotExport {
    pub image: SnapshotExport,
    pub evidence: SnapshotExport,
}
impl SignedSnapshotExport {
    pub fn offer(&self) -> SignedSnapshotOffer {
        SignedSnapshotOffer {
            image: self.image.offer.clone(),
            evidence: self.evidence.offer.clone(),
        }
    }
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(Serialize, Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct SignedSnapshotReceipt {
    pub offer: SignedSnapshotOffer,
    pub outcome: Outcome,
}
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(Serialize, Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct SnapshotOffer {
    pub id: Uuid,
    pub hash: [u8; 32],
    pub bytes: usize,
    pub chunks: usize,
}
impl SnapshotOffer {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_nil()
            || self.bytes == 0
            || self.bytes > BOOTSTRAP_BYTES
            || self.chunks != self.bytes.div_ceil(CHUNK)
        {
            return Err(Error::SnapshotTooLarge);
        }
        Ok(())
    }
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(Serialize, Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct SnapshotChunk {
    pub offer: SnapshotOffer,
    pub index: usize,
    pub hash: [u8; 32],
    pub bytes: Vec<u8>,
}
#[derive(Clone)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    derive(Serialize, Deserialize)
)]
#[cfg_attr(
    any(test, all(target_os = "android", feature = "android-identity-tests")),
    serde(deny_unknown_fields)
)]
pub(crate) struct SnapshotReceipt {
    pub offer: SnapshotOffer,
    pub outcome: Outcome,
}
#[derive(Clone)]
pub(crate) struct SnapshotExport {
    pub offer: SnapshotOffer,
    pub bytes: Vec<u8>,
}
impl SnapshotExport {
    pub fn chunk(&self, index: usize) -> Option<SnapshotChunk> {
        let start = index.checked_mul(CHUNK)?;
        let bytes = self
            .bytes
            .get(start..self.bytes.len().min(start.checked_add(CHUNK)?))?;
        if bytes.is_empty() {
            return None;
        }
        Some(SnapshotChunk {
            offer: self.offer.clone(),
            index,
            hash: codec::journal_event_hash(bytes),
            bytes: bytes.to_vec(),
        })
    }
    pub fn chunks(&self) -> Vec<SnapshotChunk> {
        self.bytes
            .chunks(CHUNK)
            .enumerate()
            .map(|(index, b)| SnapshotChunk {
                offer: self.offer.clone(),
                index,
                hash: codec::journal_event_hash(b),
                bytes: b.to_vec(),
            })
            .collect()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotCore {
    pub bytes: String,
    pub outcome: String,
    pub materialized: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotRow {
    pub entity: String,
    pub key: Vec<String>,
    pub image: serde_json::Value,
    pub provenance: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HighWater {
    pub origin: String,
    pub incarnation: String,
    pub seq: String,
    pub hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotImage {
    pub profile: String,
    pub version: u32,
    pub id: String,
    pub network: String,
    pub row_count: usize,
    pub core_count: usize,
    pub rows: Vec<SnapshotRow>,
    pub cores: Vec<SnapshotCore>,
    pub high_water: Vec<HighWater>,
    // Canonical local origin metadata and original immutable conflict alternatives.
    pub origin_metadata: Vec<serde_json::Value>,
    pub conflicts: Vec<serde_json::Value>,
}
pub(crate) fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char)
    }
    s
}
pub(crate) fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() > codec::MAX_CANONICAL_BYTES * 2 || !s.len().is_multiple_of(2) {
        return Err(Error::SnapshotTooLarge);
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        _ => Err(Error::Integrity),
    };
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| Ok(digit(p[0])? * 16 + digit(p[1])?))
        .collect()
}
pub(crate) fn envelope(bytes: Vec<u8>) -> Result<Envelope> {
    ValidatedEvent::from_bytes(bytes)
        .map(ValidatedEvent::into_envelope)
        // Preserve this established wrapper's malformed/oversize error contract.
        .map_err(|e| {
            if e == Error::Limit {
                Error::Integrity
            } else {
                e
            }
        })
}

pub(crate) fn canonical(image: &SnapshotImage) -> Result<Vec<u8>> {
    let b = serde_jcs::to_vec(image).map_err(|_| Error::Integrity)?;
    if b.len() > BOOTSTRAP_BYTES {
        return Err(Error::SnapshotTooLarge);
    }
    Ok(b)
}
pub(crate) fn decode(bytes: &[u8]) -> Result<SnapshotImage> {
    if bytes.len() > BOOTSTRAP_BYTES {
        return Err(Error::SnapshotTooLarge);
    }
    let (mut depth, mut string, mut escape) = (0u32, false, false);
    for b in bytes {
        if string {
            if escape {
                escape = false
            } else if *b == b'\\' {
                escape = true
            } else if *b == b'"' {
                string = false
            }
        } else {
            match *b {
                b'"' => string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 16 {
                        return Err(Error::Limit);
                    }
                }
                b'}' | b']' => depth = depth.checked_sub(1).ok_or(Error::Integrity)?,
                _ => {}
            }
        }
    }
    let image: SnapshotImage = serde_json::from_slice(bytes).map_err(|_| Error::Integrity)?;
    if image.row_count != image.rows.len()
        || image.core_count != image.cores.len()
        || image.version != 1
        || ![BOOTSTRAP_PROFILE, BOOTSTRAP_D4_PROFILE].contains(&image.profile.as_str())
        || image.cores.len() > BOOTSTRAP_EVENTS
        || image.rows.len() > BOOTSTRAP_ROWS
        || image.high_water.len() > BOOTSTRAP_EVENTS
        || image.origin_metadata.len()
            > if image.profile == BOOTSTRAP_D4_PROFILE {
                BOOTSTRAP_ROWS * 4 + BOOTSTRAP_EVENTS * 3
            } else {
                BOOTSTRAP_ROWS + BOOTSTRAP_EVENTS * 2
            }
        || image.conflicts.len() > 64
        || canonical(&image)? != bytes
    {
        return Err(Error::Integrity);
    }
    Ok(image)
}
