//! Where provider credentials are kept at rest.
//!
//! `SecretStore` is the only seam that can read a raw key, and it is only reachable from native code: the commands in
//! `commands/ai.rs` can store, test for and delete a credential but there is no operation that returns one. The raw value never
//! enters SQLite, the settings files, logs or diagnostics.
//!
//! - Android: `AndroidKeystoreStore` (see `android_keystore.rs`). AES-256-GCM with a non-extractable Android Keystore key.
//! - Desktop: `FileSecretStore`, a private (0600) file in the app data directory. The desktop shell is a development target
//!   today; a platform keychain is a later step and fits behind this same trait.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::credentials::ApiKey;
use super::registry::ProviderId;

/// Why a credential could not be stored or removed. Never carries the credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError(pub String);

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub trait SecretStore: Send + Sync {
    fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<(), SecretError>;
    fn has(&self, provider: ProviderId) -> bool;
    fn delete(&self, provider: ProviderId) -> Result<(), SecretError>;
    /// Native use only: the request that is about to be sent. Read on every request, never cached.
    fn get(&self, provider: ProviderId) -> Option<ApiKey>;
}

pub struct FileSecretStore {
    dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// `openai_api_key` is also the file name earlier versions used, so an existing desktop install keeps working.
    fn path(&self, provider: ProviderId) -> PathBuf {
        self.dir.join(format!("{}_api_key", provider.as_str()))
    }
}

impl SecretStore for FileSecretStore {
    fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<(), SecretError> {
        let fail = |_: io::Error| SecretError("the credential could not be saved".into());
        fs::create_dir_all(&self.dir).map_err(fail)?;
        let path = self.path(provider);
        let temporary = path.with_extension("tmp");
        write_private(&temporary, key.expose()).map_err(fail)?;
        fs::rename(&temporary, &path).map_err(fail)
    }

    fn has(&self, provider: ProviderId) -> bool {
        self.get(provider).is_some()
    }

    fn delete(&self, provider: ProviderId) -> Result<(), SecretError> {
        match fs::remove_file(self.path(provider)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(SecretError("the credential could not be removed".into())),
        }
    }

    fn get(&self, provider: ProviderId) -> Option<ApiKey> {
        fs::read_to_string(self.path(provider)).ok().and_then(|raw| ApiKey::parse(&raw))
    }
}

#[cfg(unix)]
fn write_private(path: &Path, value: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    file.write_all(value.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, value: &str) -> io::Result<()> {
    fs::write(path, value)
}

/// Where the app is running, as far as credential storage is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoragePlatform {
    Android,
    /// Desktop, development and tests.
    Other,
}

impl StoragePlatform {
    pub const fn current() -> Self {
        if cfg!(target_os = "android") {
            StoragePlatform::Android
        } else {
            StoragePlatform::Other
        }
    }
}

/// A store that refuses everything. It is what Android gets when the Keystore bridge is not available: credential operations fail
/// safely and nothing is ever written anywhere.
pub struct UnavailableSecretStore;

impl SecretStore for UnavailableSecretStore {
    fn set(&self, _: ProviderId, _: &ApiKey) -> Result<(), SecretError> {
        Err(SecretError("secure credential storage is not available on this device".into()))
    }
    fn has(&self, _: ProviderId) -> bool {
        false
    }
    fn delete(&self, _: ProviderId) -> Result<(), SecretError> {
        Err(SecretError("secure credential storage is not available on this device".into()))
    }
    fn get(&self, _: ProviderId) -> Option<ApiKey> {
        None
    }
}

/// The ONLY place a store is chosen. On Android the Keystore store is used, or the refusing store when it is unavailable: there is
/// no path from Android to `FileSecretStore`, so a credential is never written to a plaintext file as a fallback. Everywhere else
/// the owner-only file store is used.
pub fn select_store(platform: StoragePlatform, keystore: Option<std::sync::Arc<dyn SecretStore>>, file_dir: PathBuf) -> std::sync::Arc<dyn SecretStore> {
    match platform {
        StoragePlatform::Android => keystore.unwrap_or_else(|| std::sync::Arc::new(UnavailableSecretStore)),
        StoragePlatform::Other => std::sync::Arc::new(FileSecretStore::new(file_dir)),
    }
}

/// One-time move of the credential file earlier builds (and adb provisioning) left in the app's data directory into `store`.
///
/// The file is overwritten and removed only once the store holds the key (or already held one), so a failed import loses nothing.
/// Returns true when a legacy credential was imported.
pub fn migrate_legacy_file(legacy: &Path, provider: ProviderId, store: &dyn SecretStore) -> bool {
    let Ok(raw) = fs::read_to_string(legacy) else { return false };
    let key = ApiKey::parse(&raw);
    let imported = match &key {
        Some(key) if !store.has(provider) => store.set(provider, key).is_ok() && store.has(provider),
        _ => false,
    };
    // An unusable legacy file is simply cleaned up; a usable one is only removed once it is safely in the store.
    if imported || key.is_none() || store.has(provider) {
        let _ = fs::write(legacy, vec![b'0'; raw.len()]);
        let _ = fs::remove_file(legacy);
    }
    imported
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory store for tests that need a store without touching disk.
    #[derive(Default)]
    pub struct MemorySecretStore(pub Mutex<HashMap<&'static str, String>>);

    impl SecretStore for MemorySecretStore {
        fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<(), SecretError> {
            self.0.lock().unwrap().insert(provider.as_str(), key.expose().to_string());
            Ok(())
        }
        fn has(&self, provider: ProviderId) -> bool {
            self.0.lock().unwrap().contains_key(provider.as_str())
        }
        fn delete(&self, provider: ProviderId) -> Result<(), SecretError> {
            self.0.lock().unwrap().remove(provider.as_str());
            Ok(())
        }
        fn get(&self, provider: ProviderId) -> Option<ApiKey> {
            self.0.lock().unwrap().get(provider.as_str()).and_then(|raw| ApiKey::parse(raw))
        }
    }

    fn key(raw: &str) -> ApiKey {
        ApiKey::parse(raw).unwrap()
    }

    #[test]
    fn the_file_store_round_trips_replaces_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path().join("credentials"));
        assert!(!store.has(ProviderId::OpenAi));
        store.set(ProviderId::OpenAi, &key("sk-one")).unwrap();
        assert_eq!(store.get(ProviderId::OpenAi).unwrap().expose(), "sk-one");
        store.set(ProviderId::OpenAi, &key("sk-two")).unwrap();
        assert_eq!(store.get(ProviderId::OpenAi).unwrap().expose(), "sk-two");
        store.delete(ProviderId::OpenAi).unwrap();
        assert!(!store.has(ProviderId::OpenAi));
        store.delete(ProviderId::OpenAi).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_store_writes_owner_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path().to_path_buf());
        store.set(ProviderId::OpenAi, &key("sk-private")).unwrap();
        let mode = fs::metadata(dir.path().join("openai_api_key")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn migration_moves_a_legacy_file_into_the_store_and_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("openai_api_key");
        fs::write(&legacy, "sk-legacy\n").unwrap();
        let store = MemorySecretStore::default();
        assert!(migrate_legacy_file(&legacy, ProviderId::OpenAi, &store));
        assert_eq!(store.get(ProviderId::OpenAi).unwrap().expose(), "sk-legacy");
        assert!(!legacy.exists());
        assert!(!migrate_legacy_file(&legacy, ProviderId::OpenAi, &store), "nothing left to migrate");
    }

    #[test]
    fn migration_never_overwrites_a_credential_the_user_already_saved() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("openai_api_key");
        fs::write(&legacy, "sk-old").unwrap();
        let store = MemorySecretStore::default();
        store.set(ProviderId::OpenAi, &key("sk-new")).unwrap();
        assert!(!migrate_legacy_file(&legacy, ProviderId::OpenAi, &store));
        assert_eq!(store.get(ProviderId::OpenAi).unwrap().expose(), "sk-new");
        assert!(!legacy.exists());
    }

    #[test]
    fn android_never_falls_back_to_a_file_and_other_platforms_use_the_file_store() {
        let dir = tempfile::tempdir().unwrap();
        let k = ApiKey::parse("sk-no-fallback").unwrap();

        // Android without a working Keystore bridge: every operation fails or is empty, and nothing touches the disk.
        let android = select_store(StoragePlatform::Android, None, dir.path().to_path_buf());
        assert!(android.set(ProviderId::OpenAi, &k).is_err());
        assert!(android.delete(ProviderId::OpenAi).is_err());
        assert!(!android.has(ProviderId::OpenAi) && android.get(ProviderId::OpenAi).is_none());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "no plaintext file was written");

        // Android with the Keystore: that store is the one used, and the directory is still never written.
        let keystore: std::sync::Arc<dyn SecretStore> = std::sync::Arc::new(MemorySecretStore::default());
        let android = select_store(StoragePlatform::Android, Some(keystore), dir.path().to_path_buf());
        android.set(ProviderId::OpenAi, &k).unwrap();
        assert!(android.has(ProviderId::OpenAi));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);

        let other = select_store(StoragePlatform::Other, None, dir.path().to_path_buf());
        other.set(ProviderId::OpenAi, &k).unwrap();
        assert!(dir.path().join("openai_api_key").exists());
    }

    #[test]
    fn a_failed_import_keeps_the_legacy_file() {
        struct Failing;
        impl SecretStore for Failing {
            fn set(&self, _: ProviderId, _: &ApiKey) -> Result<(), SecretError> {
                Err(SecretError("no".into()))
            }
            fn has(&self, _: ProviderId) -> bool {
                false
            }
            fn delete(&self, _: ProviderId) -> Result<(), SecretError> {
                Ok(())
            }
            fn get(&self, _: ProviderId) -> Option<ApiKey> {
                None
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("openai_api_key");
        fs::write(&legacy, "sk-keep").unwrap();
        assert!(!migrate_legacy_file(&legacy, ProviderId::OpenAi, &Failing));
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "sk-keep");
    }
}
