//! Process-lifetime ownership of an app-private data root, separate from SQLite transaction locks.
//!
//! The file is deliberately never unlinked: removing a locked file would let another process lock
//! a new inode at the same path. A leftover file is harmless; the OS releases the lock on close,
//! process termination and Android's `_exit`. Requires Rust 1.89's standard file-lock API.

use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

pub(crate) const OWNER_FILE: &str = ".arthur-runtime.lock";

#[derive(Debug)]
pub(crate) enum OwnershipError {
    InUse,
    InvalidPath,
    Io(io::Error),
}

impl fmt::Display for OwnershipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InUse => write!(f, "Arthur data is already open by another owner; close that instance and retry"),
            Self::InvalidPath => write!(f, "Arthur needs regular database and ownership files in its private data directory"),
            Self::Io(_) => write!(f, "Arthur could not lock its data directory; check permissions and filesystem lock support"),
        }
    }
}

impl std::error::Error for OwnershipError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

/// Non-cloneable capability consumed by the disk store and held until its connection is closed.
pub(crate) struct DataRootOwnership {
    root: PathBuf,
    _lock: File,
}

impl DataRootOwnership {
    /// `root` must already be an existing canonical app-private directory.
    /// Never waits for a competing owner and never treats a PID/file's mere presence as a lock.
    pub(crate) fn try_acquire(root: &Path) -> Result<Self, OwnershipError> {
        let lock_path = root.join(OWNER_FILE);
        require_regular_or_absent(&lock_path)?;
        require_regular_or_absent(&root.join("arthur.db"))?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(&lock_path).map_err(OwnershipError::Io)?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                root: root.to_path_buf(),
                _lock: lock,
            }),
            Err(TryLockError::WouldBlock) => Err(OwnershipError::InUse),
            Err(TryLockError::Error(error)) => Err(OwnershipError::Io(error)),
        }
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.root
    }
}

fn require_regular_or_absent(path: &Path) -> Result<(), OwnershipError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(OwnershipError::InvalidPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(OwnershipError::Io(error)),
    }
}

/// Schema fixture access stays in storage, just like migrations and the existing SQL test helpers.
#[cfg(test)]
pub(crate) mod fixtures {
    use crate::storage::capture_store::CaptureStore;

    pub(crate) fn schema_version(store: &CaptureStore) -> i64 {
        store.query_i64_for_test("PRAGMA user_version")
    }

    pub(crate) fn mark_future_schema(store: &CaptureStore) {
        store.execute_sql_for_test("PRAGMA user_version = 99;");
    }
}
