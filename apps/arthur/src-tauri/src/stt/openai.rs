use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::multipart::{Form, Part};
use reqwest::redirect::Policy;

use crate::async_util::BoxFuture;

use super::credentials::CredentialSource;
use super::{SttError, Transcriber};

pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
/// Same default as the TypeScript provider (`OPENAI_STT_MODEL`).
pub const DEFAULT_MODEL: &str = "gpt-4o-transcribe";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct OpenAiTranscriber {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    credentials: Arc<dyn CredentialSource>,
}

impl OpenAiTranscriber {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, DEFAULT_MODEL)
    }

    pub fn with_endpoint(credentials: Arc<dyn CredentialSource>, endpoint: &str, model: &str) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            // The credential must never follow a redirect to another host.
            .redirect(Policy::none())
            .build()?;
        Ok(Self { client, endpoint: endpoint.to_string(), model: model.to_string(), credentials })
    }

    async fn request(&self, audio: &[u8], file_name: &str) -> Result<String, SttError> {
        let key = self.credentials.api_key().ok_or(SttError::NotConfigured)?;

        // Language is deliberately unset (auto), matching the TypeScript provider,
        // so Bulgarian/English code-switching works.
        let file = Part::bytes(audio.to_vec())
            .file_name(file_name.to_string())
            .mime_str(mime_for(file_name))
            .map_err(|_| SttError::Protocol)?;
        let form = Form::new()
            .text("model", self.model.clone())
            .text("response_format", "json")
            .part("file", file);

        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(key.expose())
            .multipart(form)
            .send()
            .await
            .map_err(|_| SttError::Network)?;

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(SttError::Auth(status.as_u16()));
        }
        if !status.is_success() {
            return Err(SttError::Provider(status.as_u16()));
        }

        let body: serde_json::Value = response.json().await.map_err(|error| {
            if error.is_decode() { SttError::Protocol } else { SttError::Network }
        })?;
        match body.get("text") {
            Some(serde_json::Value::String(text)) => Ok(text.clone()),
            _ => Err(SttError::Protocol),
        }
    }
}

impl Transcriber for OpenAiTranscriber {
    fn transcribe<'a>(&'a self, audio: &'a [u8], file_name: &'a str) -> BoxFuture<'a, Result<String, SttError>> {
        Box::pin(self.request(audio, file_name))
    }
}

impl fmt::Debug for OpenAiTranscriber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiTranscriber").field("endpoint", &self.endpoint).field("model", &self.model).finish_non_exhaustive()
    }
}

fn mime_for(file_name: &str) -> &'static str {
    match file_name.rsplit('.').next() {
        Some("m4a") | Some("mp4") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("webm") => "audio/webm",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::credentials::ApiKey;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    struct FixedKey(Option<&'static str>);
    impl CredentialSource for FixedKey {
        fn api_key(&self) -> Option<ApiKey> {
            self.0.and_then(ApiKey::parse)
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// Serves exactly one HTTP request, replying with `status` and `body`.
    /// Returns the base URL and a channel that yields the raw request bytes.
    fn serve_once(status: &'static str, body: &'static str) -> (String, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
                if let Some(end) = find(&request, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let have = request.len() - (end + 4);
                    if let Some(len) = head.lines().find_map(|l| l.strip_prefix("content-length:")) {
                        if have >= len.trim().parse::<usize>().unwrap() {
                            break;
                        }
                    } else if head.contains("transfer-encoding: chunked") && request.ends_with(b"0\r\n\r\n") {
                        break;
                    }
                }
            }
            tx.send(request).unwrap();
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        (url, rx)
    }

    fn transcriber(url: &str, key: Option<&'static str>) -> OpenAiTranscriber {
        OpenAiTranscriber::with_endpoint(Arc::new(FixedKey(key)), url, DEFAULT_MODEL).unwrap()
    }

    fn run(transcriber: &OpenAiTranscriber, audio: &[u8]) -> Result<String, SttError> {
        tauri::async_runtime::block_on(transcriber.transcribe(audio, "recording.m4a"))
    }

    #[test]
    fn sends_the_documented_request_and_returns_the_transcript() {
        let (url, request) = serve_once("200 OK", r#"{"text":" hello arthur"}"#);
        let text = run(&transcriber(&url, Some("sk-test-key")), b"FAKE-AUDIO-BYTES").unwrap();
        assert_eq!(text, " hello arthur");

        let raw = request.recv().unwrap();
        let wire = String::from_utf8_lossy(&raw).to_string();
        let lower = wire.to_lowercase();
        assert!(wire.starts_with("POST /v1/audio/transcriptions "));
        assert!(lower.contains("authorization: bearer sk-test-key"));
        assert!(lower.contains("content-type: multipart/form-data; boundary="));
        assert!(wire.contains("name=\"model\"\r\n\r\ngpt-4o-transcribe"));
        assert!(wire.contains("name=\"response_format\"\r\n\r\njson"));
        assert!(wire.contains("name=\"file\"; filename=\"recording.m4a\""));
        assert!(lower.contains("content-type: audio/mp4"));
        assert!(find(&raw, b"FAKE-AUDIO-BYTES").is_some());
        assert!(!wire.contains("name=\"language\""), "language stays on auto");
    }

    #[test]
    fn without_a_credential_it_fails_before_touching_the_network() {
        // Nothing listens on this port; a request would give Network, not NotConfigured.
        let result = run(&transcriber("http://127.0.0.1:9/x", None), b"audio");
        assert_eq!(result, Err(SttError::NotConfigured));
    }

    #[test]
    fn classifies_provider_failures() {
        for (status, expected) in [
            ("401 Unauthorized", SttError::Auth(401)),
            ("403 Forbidden", SttError::Auth(403)),
            ("429 Too Many Requests", SttError::Provider(429)),
            ("500 Internal Server Error", SttError::Provider(500)),
        ] {
            let (url, _request) = serve_once(status, r#"{"error":{"message":"secret detail"}}"#);
            assert_eq!(run(&transcriber(&url, Some("sk-k")), b"audio"), Err(expected), "{status}");
        }
    }

    #[test]
    fn a_success_response_that_is_not_a_transcript_is_a_protocol_error() {
        for body in ["not json", "[]", "{}", r#"{"text":42}"#, r#"{"text":null}"#] {
            let (url, _request) = serve_once("200 OK", body);
            assert_eq!(run(&transcriber(&url, Some("sk-k")), b"audio"), Err(SttError::Protocol), "{body}");
        }
    }

    #[test]
    fn an_unreachable_provider_is_a_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
        drop(listener);
        assert_eq!(run(&transcriber(&url, Some("sk-k")), b"audio"), Err(SttError::Network));
    }

    #[test]
    fn debug_output_exposes_neither_key_nor_credential_source() {
        let t = transcriber("http://x/y", Some("sk-super-secret"));
        assert!(!format!("{t:?}").contains("super-secret"));
    }
}
