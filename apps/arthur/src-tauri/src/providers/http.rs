use std::time::Duration;

use reqwest::redirect::Policy;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// HTTP client for provider calls. The API key must never follow a redirect to another host.
pub fn client(request_timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(request_timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(Policy::none())
        .build()
}
