use std::fmt;
use std::path::PathBuf;

const MAX_KEY_CHARS: usize = 4096;

/// A provider API key. `Debug` never prints the value.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    /// Accepts a single token of printable, non-whitespace characters.
    pub fn parse(raw: &str) -> Option<Self> {
        let key = raw.trim();
        let valid = !key.is_empty()
            && key.chars().count() <= MAX_KEY_CHARS
            && key.chars().all(|c| c.is_ascii_graphic());
        valid.then(|| ApiKey(key.to_string()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

/// Where the API key comes from. Read on every request, never cached or logged.
pub trait CredentialSource: Send + Sync {
    fn api_key(&self) -> Option<ApiKey>;
}

/// Reads the key from a file in the app-private data directory.
/// On Android that directory is only readable by the app itself.
pub struct FileCredentialSource {
    path: PathBuf,
}

impl FileCredentialSource {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl CredentialSource for FileCredentialSource {
    fn api_key(&self) -> Option<ApiKey> {
        std::fs::read_to_string(&self.path).ok().and_then(|raw| ApiKey::parse(&raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_a_single_printable_token_and_trims_the_file_newline() {
        assert_eq!(ApiKey::parse("sk-test_123\n").unwrap().expose(), "sk-test_123");
    }

    #[test]
    fn parse_rejects_empty_multiline_whitespace_and_oversized_values() {
        for bad in ["", "  \n", "sk a", "sk-a\nsk-b", "sk-\u{7}x", "ключ"] {
            assert!(ApiKey::parse(bad).is_none(), "{bad:?}");
        }
        assert!(ApiKey::parse(&"k".repeat(MAX_KEY_CHARS + 1)).is_none());
    }

    #[test]
    fn debug_output_never_contains_the_key() {
        let key = ApiKey::parse("sk-super-secret").unwrap();
        assert!(!format!("{key:?}").contains("super-secret"));
    }

    #[test]
    fn file_source_reads_the_key_and_reports_none_when_missing_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai_api_key");
        let source = FileCredentialSource::new(path.clone());
        assert!(source.api_key().is_none());

        std::fs::write(&path, "sk-file-key\n").unwrap();
        assert_eq!(source.api_key().unwrap().expose(), "sk-file-key");

        std::fs::write(&path, "two words").unwrap();
        assert!(source.api_key().is_none());
    }
}
