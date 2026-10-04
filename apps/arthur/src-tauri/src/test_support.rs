//! Test-only helpers shared by the provider tests.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

pub fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Serves exactly one HTTP request on localhost, replying with `status` and `body`.
/// Returns the endpoint URL (ending in `path`) and a channel yielding the raw request bytes.
pub fn serve_once(path: &str, status: &'static str, body: String) -> (String, mpsc::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}{path}", listener.local_addr().unwrap());
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

/// An endpoint URL that nothing is listening on.
pub fn dead_endpoint(path: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}{path}", listener.local_addr().unwrap());
    drop(listener);
    url
}
