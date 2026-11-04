//! The HTTP seam: one POST of a prepared body, one raw answer. Everything that decides (retry, validation, budgets) is above it, so
//! tests replace exactly this with a scripted double and need neither a key nor the internet.

use std::time::Duration;

use crate::async_util::BoxFuture;
use crate::providers::credentials::ApiKey;

/// Hard ceiling on what is read back. A JEV answer for 16 questions is a few KB; anything bigger is not an answer.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawResponse {
    pub status: u16,
    pub body: String,
    /// `Retry-After` in seconds, when the provider sent one.
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Network,
    TooLarge,
}

pub trait JevTransport: Send + Sync {
    fn post<'a>(
        &'a self,
        key: &'a ApiKey,
        body: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<RawResponse, TransportError>>;
}

/// The real transport: rustls, no redirects (the key can never follow one to another host), bounded read. The endpoint is a constant.
pub struct ReqwestTransport {
    endpoint: String,
    client: reqwest::Client,
}

/// Upper bound baked into the client; each request sets its own (shorter) timeout.
const CLIENT_CEILING: Duration = Duration::from_secs(60);

impl ReqwestTransport {
    pub fn production() -> Result<Self, reqwest::Error> {
        Ok(Self {
            endpoint: super::JEV_ENDPOINT.to_string(),
            client: crate::providers::http::client(CLIENT_CEILING)?,
        })
    }

    /// Tests only: a localhost endpoint.
    #[cfg(test)]
    pub fn with_endpoint(endpoint: String) -> Self {
        Self {
            endpoint,
            client: crate::providers::http::client(CLIENT_CEILING).expect("client"),
        }
    }
}

impl JevTransport for ReqwestTransport {
    fn post<'a>(
        &'a self,
        key: &'a ApiKey,
        body: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<RawResponse, TransportError>> {
        Box::pin(async move {
            let mut response = self
                .client
                .post(&self.endpoint)
                .timeout(timeout)
                .bearer_auth(key.expose())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        TransportError::Timeout
                    } else {
                        TransportError::Network
                    }
                })?;
            let status = response.status().as_u16();
            let retry_after_secs = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            if response
                .content_length()
                .is_some_and(|length| length as usize > MAX_RESPONSE_BYTES)
            {
                return Err(TransportError::TooLarge);
            }
            let mut bytes: Vec<u8> = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| {
                if e.is_timeout() {
                    TransportError::Timeout
                } else {
                    TransportError::Network
                }
            })? {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(TransportError::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(RawResponse {
                status,
                body: String::from_utf8_lossy(&bytes).into_owned(),
                retry_after_secs,
            })
        })
    }
}
