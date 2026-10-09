//! Per-purpose authorization for sending text to a provider other than the identity classifier.
//!
//! Identity classification (TypeSafe consent), revision synthesis, independent verification and the automatic-revision feature itself
//! are FOUR separate permissions. None implies another: consent to TypeSafe does not authorize OpenAI or a verifier provider, and an
//! API key is never a permission. Each record is its own app-private file, default OFF, bound to the provider, the purpose and the
//! disclosure version it was given for; a missing, damaged, foreign or older record means NOT authorized, and nothing is migrated.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Synthesis,
    Verification,
}

impl Purpose {
    fn as_str(self) -> &'static str {
        match self {
            Purpose::Synthesis => "synthesis",
            Purpose::Verification => "verification",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u64,
    provider: String,
    purpose: String,
    granted: bool,
    disclosure_version: String,
}

const FILE_VERSION: u64 = 1;

pub struct ProviderAuthorization {
    path: Option<PathBuf>,
    provider: &'static str,
    purpose: Purpose,
    disclosure_version: &'static str,
    granted: AtomicBool,
}

impl ProviderAuthorization {
    pub fn new(path: PathBuf, provider: &'static str, purpose: Purpose, disclosure_version: &'static str) -> Self {
        let granted = Self::read(&path, provider, purpose, disclosure_version);
        Self { path: Some(path), provider, purpose, disclosure_version, granted: AtomicBool::new(granted) }
    }

    #[cfg(test)]
    pub fn in_memory(provider: &'static str, purpose: Purpose, granted: bool) -> Self {
        Self { path: None, provider, purpose, disclosure_version: "test", granted: AtomicBool::new(granted) }
    }

    fn read(path: &PathBuf, provider: &str, purpose: Purpose, disclosure_version: &str) -> bool {
        let Some(record) = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok()) else { return false };
        record.version == FILE_VERSION && record.provider == provider && record.purpose == purpose.as_str() && record.disclosure_version == disclosure_version && record.granted
    }

    pub fn granted(&self) -> bool {
        self.granted.load(Ordering::SeqCst)
    }

    /// The person agreed to the CURRENT disclosure for this provider and purpose. Persisted first.
    pub fn grant(&self) -> std::io::Result<()> {
        self.write(true)
    }

    pub fn revoke(&self) -> std::io::Result<()> {
        self.write(false)
    }

    fn write(&self, granted: bool) -> std::io::Result<()> {
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let record = Record { version: FILE_VERSION, provider: self.provider.into(), purpose: self.purpose.as_str().into(), granted, disclosure_version: self.disclosure_version.into() };
            let temporary = path.with_extension("tmp");
            std::fs::write(&temporary, serde_json::to_vec(&record).map_err(std::io::Error::other)?)?;
            std::fs::rename(&temporary, path)?;
        }
        self.granted.store(granted, Ordering::SeqCst);
        Ok(())
    }
}
