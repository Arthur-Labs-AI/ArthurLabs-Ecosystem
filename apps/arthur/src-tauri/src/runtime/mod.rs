//! Storage-only native runtime, acquired without an Activity, WebView, Tauri or provider services.
//!
//! One process-wide registry reserves each canonical data root before opening it. Registry locks
//! cover map operations only; filesystem I/O and migration run outside that lock. A racing caller
//! gets `Initializing` (retry later), while an established owner is reused by `Arc` identity.
//! Weak entries do not keep stores alive. Failed initialization removes its reservation through
//! RAII, and the store owns the OS lock for the entire connection lifetime.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::ownership::{DataRootOwnership, OwnershipError};

/// Managed by Tauri, but also acquirable by a future Application-context worker in the SAME process.
pub(crate) type RuntimeHandle = Arc<NativeRuntime>;

pub(crate) struct NativeRuntime {
    data_root: PathBuf,
    store: CaptureStore,
}

#[derive(Debug)]
pub(crate) enum RuntimeError {
    RelativeDataRoot,
    PrepareDataRoot(io::Error),
    Initializing,
    RegistryPoisoned,
    Ownership(OwnershipError),
    Storage(StoreError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelativeDataRoot => {
                write!(f, "Arthur needs an absolute application data directory")
            }
            Self::PrepareDataRoot(_) => write!(
                f,
                "Arthur could not prepare its data directory; check its location and permissions"
            ),
            Self::Initializing => write!(
                f,
                "Arthur storage is being initialized for this directory; retry acquisition shortly"
            ),
            Self::RegistryPoisoned => write!(
                f,
                "Arthur's storage registry is unavailable after a panic; restart the application"
            ),
            Self::Ownership(error) => fmt::Display::fmt(error, f),
            Self::Storage(error) => fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for RuntimeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::PrepareDataRoot(error) => Some(error),
            Self::Ownership(error) => Some(error),
            Self::Storage(error) => Some(error),
            _ => None,
        }
    }
}

enum Entry {
    Initializing,
    Ready(Weak<NativeRuntime>),
}

// This is an ownership registry, not a second data store or a service locator. No callbacks,
// provider work, SQLite operation or filesystem I/O may run while its mutex is held.
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();

fn owners() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl NativeRuntime {
    pub(crate) fn acquire(data_root: &Path) -> Result<RuntimeHandle, RuntimeError> {
        if !data_root.is_absolute() {
            return Err(RuntimeError::RelativeDataRoot);
        }
        fs::create_dir_all(data_root).map_err(RuntimeError::PrepareDataRoot)?;
        let root = fs::canonicalize(data_root).map_err(RuntimeError::PrepareDataRoot)?;

        {
            let mut registry = owners()
                .lock()
                .map_err(|_| RuntimeError::RegistryPoisoned)?;
            match registry.get(&root) {
                Some(Entry::Initializing) => return Err(RuntimeError::Initializing),
                Some(Entry::Ready(weak)) => {
                    if let Some(runtime) = weak.upgrade() {
                        return Ok(runtime);
                    }
                }
                None => {}
            }
            registry.retain(|_, entry| match entry {
                Entry::Ready(weak) => weak.strong_count() > 0,
                Entry::Initializing => true,
            });
            registry.insert(root.clone(), Entry::Initializing);
        }

        let mut reservation = Reservation {
            root: root.clone(),
            published: false,
        };
        let ownership = DataRootOwnership::try_acquire(&root).map_err(RuntimeError::Ownership)?;
        let store = CaptureStore::open_owned(ownership).map_err(RuntimeError::Storage)?;
        let runtime = Arc::new(Self {
            data_root: root.clone(),
            store,
        });
        {
            let mut registry = owners()
                .lock()
                .map_err(|_| RuntimeError::RegistryPoisoned)?;
            registry.insert(root, Entry::Ready(Arc::downgrade(&runtime)));
            reservation.published = true;
        }
        Ok(runtime)
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub(crate) fn store(&self) -> &CaptureStore {
        &self.store
    }
}

// Existing commands/services retain the exact CaptureStore behavior; the managed Arc also retains
// ownership. A borrowed store cannot outlive the runtime. CaptureStore itself is not Clone.
impl Deref for NativeRuntime {
    type Target = CaptureStore;

    fn deref(&self) -> &Self::Target {
        self.store()
    }
}

struct Reservation {
    root: PathBuf,
    published: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.published {
            if let Ok(mut registry) = owners().lock() {
                if matches!(registry.get(&self.root), Some(Entry::Initializing)) {
                    registry.remove(&self.root);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
