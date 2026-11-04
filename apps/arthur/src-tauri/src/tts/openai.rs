use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::async_util::BoxFuture;
use crate::providers::credentials::CredentialSource;
use crate::providers::http;

use super::{Speech, Synthesizer, TtsError};

pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
/// OpenAI's current production speech model. It speaks English and Bulgarian from the same request; the text is sent as written.
pub const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_VOICE: &str = "alloy";
pub const MODELS: &[&str] = &["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
pub const VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
    "marin", "cedar",
];

/// The provider accepts at most 4096 characters per request; chunks are kept far below that.
pub const MAX_INPUT_CHARS: usize = 4096;
/// Audio larger than this is refused rather than held in memory.
pub const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

pub struct OpenAiSynthesizer {
    client: reqwest::Client,
    endpoint: String,
    credentials: Arc<dyn CredentialSource>,
}

impl OpenAiSynthesizer {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT)
    }

    pub fn with_endpoint(
        credentials: Arc<dyn CredentialSource>,
        endpoint: &str,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http::client(REQUEST_TIMEOUT)?,
            endpoint: endpoint.to_string(),
            credentials,
        })
    }

    async fn request(&self, text: &str, voice: &str, model: &str) -> Result<Speech, TtsError> {
        let key = self.credentials.api_key().ok_or(TtsError::NotConfigured)?;
        if text.chars().count() > MAX_INPUT_CHARS {
            return Err(TtsError::Protocol);
        }
        let body =
            json!({ "model": model, "voice": voice, "input": text, "response_format": "mp3" });
        let mut response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(key.expose())
            .json(&body)
            .send()
            .await
            .map_err(|_| TtsError::Network)?;

        let status = response.status().as_u16();
        match status {
            401 | 403 => return Err(TtsError::Auth),
            400 | 404 | 422 => return Err(TtsError::Unsupported),
            s if !(200..300).contains(&s) => return Err(TtsError::Provider(s)),
            _ => {}
        }
        let is_audio = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("audio/") || v.starts_with("application/octet-stream"));
        if !is_audio {
            return Err(TtsError::Protocol);
        }

        // Read incrementally so an oversized body is refused instead of buffered.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| TtsError::Network)? {
            if bytes.len() + chunk.len() > MAX_AUDIO_BYTES {
                return Err(TtsError::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(TtsError::Protocol);
        }
        Ok(Speech { bytes })
    }
}

impl Synthesizer for OpenAiSynthesizer {
    fn synthesize<'a>(
        &'a self,
        text: &'a str,
        voice: &'a str,
        model: &'a str,
    ) -> BoxFuture<'a, Result<Speech, TtsError>> {
        Box::pin(self.request(text, voice, model))
    }
}

impl fmt::Debug for OpenAiSynthesizer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiSynthesizer")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::credentials::ApiKey;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct FixedKey(Option<&'static str>);
    impl CredentialSource for FixedKey {
        fn api_key(&self) -> Option<ApiKey> {
            self.0.and_then(ApiKey::parse)
        }
    }

    /// Replies once with `status`, `content_type` and `body`; yields the raw request.
    fn serve(
        status: u16,
        content_type: &'static str,
        body: Vec<u8>,
    ) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/audio/speech", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..n]);
                if n == 0 || request.windows(4).any(|w| w == b"\r\n\r\n") && request.ends_with(b"}")
                {
                    break;
                }
            }
            let _ = tx.send(request);
            let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(&body);
        });
        (url, rx)
    }

    fn run(synth: &OpenAiSynthesizer, text: &str) -> Result<Speech, TtsError> {
        tauri::async_runtime::block_on(synth.synthesize(text, "alloy", DEFAULT_MODEL))
    }

    fn synth(url: &str, key: Option<&'static str>) -> OpenAiSynthesizer {
        OpenAiSynthesizer::with_endpoint(Arc::new(FixedKey(key)), url).unwrap()
    }

    #[test]
    fn sends_the_documented_request_and_returns_the_audio() {
        let (url, seen) = serve(200, "audio/mpeg", b"ID3-FAKE-MP3".to_vec());
        let speech = run(&synth(&url, Some("sk-tts-key")), "Здравей, аз съм Arthur.").unwrap();
        assert_eq!(speech.bytes, b"ID3-FAKE-MP3");
        let raw = String::from_utf8_lossy(&seen.recv().unwrap()).to_string();
        assert!(raw.starts_with("POST /v1/audio/speech "));
        assert!(raw
            .to_lowercase()
            .contains("authorization: bearer sk-tts-key"));
        // Bulgarian goes over the wire as written (JSON may escape it, but never transliterates).
        let body: serde_json::Value =
            serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["input"], "Здравей, аз съм Arthur.");
        assert_eq!(
            (
                body["model"].as_str(),
                body["voice"].as_str(),
                body["response_format"].as_str()
            ),
            (Some("gpt-4o-mini-tts"), Some("alloy"), Some("mp3"))
        );
    }

    #[test]
    fn no_credential_fails_before_touching_the_network() {
        let dead = crate::test_support::dead_endpoint("/v1/audio/speech");
        assert_eq!(
            run(&synth(&dead, None), "hi").err(),
            Some(TtsError::NotConfigured)
        );
    }

    #[test]
    fn provider_failures_are_classified_without_exposing_bodies() {
        for (status, expected) in [
            (401, TtsError::Auth),
            (403, TtsError::Auth),
            (400, TtsError::Unsupported),
            (404, TtsError::Unsupported),
            (429, TtsError::Provider(429)),
            (500, TtsError::Provider(500)),
        ] {
            let (url, _) = serve(
                status,
                "application/json",
                br#"{"error":{"message":"secret-looking provider text sk-leak"}}"#.to_vec(),
            );
            assert_eq!(
                run(&synth(&url, Some("sk-k")), "hi").err(),
                Some(expected.clone()),
                "{status}"
            );
            assert!(!format!("{expected:?}").contains("leak"));
        }
        let dead = crate::test_support::dead_endpoint("/v1/audio/speech");
        assert_eq!(
            run(&synth(&dead, Some("sk-k")), "hi").err(),
            Some(TtsError::Network)
        );
    }

    #[test]
    fn a_2xx_that_is_not_audio_or_is_empty_or_oversized_is_a_protocol_failure() {
        let (url, _) = serve(200, "application/json", b"{}".to_vec());
        assert_eq!(
            run(&synth(&url, Some("sk-k")), "hi").err(),
            Some(TtsError::Protocol)
        );
        let (url, _) = serve(200, "audio/mpeg", Vec::new());
        assert_eq!(
            run(&synth(&url, Some("sk-k")), "hi").err(),
            Some(TtsError::Protocol)
        );
        assert_eq!(
            run(
                &synth("http://127.0.0.1:9/x", Some("sk-k")),
                &"a".repeat(MAX_INPUT_CHARS + 1)
            )
            .err(),
            Some(TtsError::Protocol),
            "over-long input is refused locally"
        );
    }
}
