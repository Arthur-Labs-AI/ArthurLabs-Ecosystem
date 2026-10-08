//! Provider consent for TypeSafe (JEV): its own record, default OFF, independent of every other setting.
//!
//! JEV is a separate third-party processor that would receive a claim, its exact words, and up to four candidate ideas. A credential
//! alone is therefore never permission. Consent is tied to the `DISCLOSURE_VERSION` the person saw: if the disclosure changes, an old
//! grant stops counting. A missing, damaged or foreign file means NOT consented. Revoking is immediate and durable-first: the file is
//! written before the in-memory switch flips.
//!
//! It is deliberately separate from the OpenAI credential, Semantic Recall's consent, Automatic Connections and AI & Voice.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::DISCLOSURE_VERSION;

const FILE_VERSION: u64 = 1;
const PROVIDER: &str = "typesafe";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentState {
    pub version: u64,
    pub provider: String,
    pub granted: bool,
    /// The disclosure text version the person agreed to.
    pub disclosure_version: String,
    pub changed_at: String,
}

pub struct JevConsent {
    path: Option<PathBuf>,
    granted: AtomicBool,
}

fn now() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

impl JevConsent {
    pub fn new(path: PathBuf) -> Self {
        let granted = Self::read(&path).is_some_and(|state| state.granted);
        Self { path: Some(path), granted: AtomicBool::new(granted) }
    }

    #[cfg(test)]
    pub fn in_memory(granted: bool) -> Self {
        Self { path: None, granted: AtomicBool::new(granted) }
    }

    /// The stored state if it is well formed, for THIS provider, and for the CURRENT disclosure; otherwise `None` (= not consented).
    fn read(path: &PathBuf) -> Option<ConsentState> {
        let state: ConsentState = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        (state.version == FILE_VERSION && state.provider == PROVIDER && state.disclosure_version == DISCLOSURE_VERSION).then_some(state)
    }

    pub fn granted(&self) -> bool {
        self.granted.load(Ordering::SeqCst)
    }

    pub fn state(&self) -> Option<ConsentState> {
        self.path.as_ref().and_then(Self::read)
    }

    /// The person agreed to the CURRENT disclosure. Persisted first; if it cannot be saved nothing changes.
    pub fn grant(&self) -> std::io::Result<()> {
        self.write(true)
    }

    /// Withdraws consent at once. New requests stop; nothing is deleted at the provider by this call.
    pub fn revoke(&self) -> std::io::Result<()> {
        self.write(false)
    }

    fn write(&self, granted: bool) -> std::io::Result<()> {
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let state = ConsentState { version: FILE_VERSION, provider: PROVIDER.into(), granted, disclosure_version: DISCLOSURE_VERSION.into(), changed_at: now() };
            let temporary = path.with_extension("tmp");
            std::fs::write(&temporary, serde_json::to_vec(&state).map_err(std::io::Error::other)?)?;
            std::fs::rename(&temporary, path)?;
        }
        self.granted.store(granted, Ordering::SeqCst);
        Ok(())
    }
}
