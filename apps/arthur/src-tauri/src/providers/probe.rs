//! A bounded check that a credential works for a capability, without spending tokens or audio.
//!
//! It asks the provider to describe each model the capability uses (`GET /models/{id}`). That authenticates the key and shows
//! whether the account can see the model, and it costs nothing: no completion, no recording, no embedding is requested.

use std::time::Duration;

use serde::Serialize;

use super::credentials::ApiKey;
use super::http;

const TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeOutcome {
    /// The provider accepted the credential and can see every model.
    Connected,
    /// The provider rejected the credential.
    InvalidCredential,
    /// The provider could not be reached (offline, timeout, provider outage).
    Unreachable,
    /// The credential works but this account cannot use the model, or the provider is rate limiting it.
    Unavailable,
    /// There is no credential to test.
    NotConfigured,
}

pub async fn probe_models(api_base: &str, key: &ApiKey, models: &[&str]) -> ProbeOutcome {
    let Ok(client) = http::client(TIMEOUT) else {
        return ProbeOutcome::Unreachable;
    };
    for model in models {
        let url = format!("{}/models/{}", api_base.trim_end_matches('/'), model);
        let status = match client.get(url).bearer_auth(key.expose()).send().await {
            Ok(response) => response.status().as_u16(),
            Err(_) => return ProbeOutcome::Unreachable,
        };
        match classify(status) {
            ProbeOutcome::Connected => {}
            other => return other,
        }
    }
    ProbeOutcome::Connected
}

fn classify(status: u16) -> ProbeOutcome {
    match status {
        200..=299 => ProbeOutcome::Connected,
        401 => ProbeOutcome::InvalidCredential,
        403 | 404 | 429 => ProbeOutcome::Unavailable,
        _ => ProbeOutcome::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-shot local HTTP server answering each connection with the next status. Returns the base URL and the request lines seen.
    fn serve(statuses: Vec<u16>) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buffer[..read]).to_string());
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
            }
        });
        (base, rx)
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    fn key() -> ApiKey {
        ApiKey::parse("sk-test-probe").unwrap()
    }

    #[test]
    fn a_known_model_is_connected_and_the_request_is_a_free_metadata_get() {
        let (base, seen) = serve(vec![200]);
        assert_eq!(
            run(probe_models(&base, &key(), &["gpt-4o-transcribe"])),
            ProbeOutcome::Connected
        );
        let request = seen.recv().unwrap();
        assert!(
            request.starts_with("GET /models/gpt-4o-transcribe "),
            "{request}"
        );
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer sk-test-probe"));
    }

    #[test]
    fn every_model_is_checked_and_the_first_problem_wins() {
        let (base, _) = serve(vec![200, 404]);
        assert_eq!(
            run(probe_models(&base, &key(), &["a", "b"])),
            ProbeOutcome::Unavailable
        );
    }

    #[test]
    fn statuses_map_to_outcomes() {
        assert_eq!(classify(401), ProbeOutcome::InvalidCredential);
        assert_eq!(classify(403), ProbeOutcome::Unavailable);
        assert_eq!(classify(429), ProbeOutcome::Unavailable);
        assert_eq!(classify(503), ProbeOutcome::Unreachable);
    }

    #[test]
    fn a_closed_port_is_unreachable() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(
            run(probe_models(
                &format!("http://127.0.0.1:{port}"),
                &key(),
                &["m"]
            )),
            ProbeOutcome::Unreachable
        );
    }
}
