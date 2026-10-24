//! Read-only OS observations. No permission requests, sockets or authorization.
use super::route_candidate::*;
use std::net::SocketAddr;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unavailable {
    MissingPermission,
    DeniedOrRevoked,
    NoNetwork,
    Changed,
    Incomplete,
    Unsupported,
    Os(u32),
}
pub(crate) type ReadResult = std::result::Result<Observation, Unavailable>;
#[cfg(windows)]
#[path = "route_windows.rs"]
mod windows;
#[cfg(windows)]
pub(crate) fn acquire(endpoint: SocketAddr) -> ReadResult {
    windows::acquire(endpoint)
}
#[cfg(target_os = "android")]
pub(crate) fn acquire(endpoint: SocketAddr) -> ReadResult {
    super::android::bridge()
        .map_err(|_| Unavailable::Unsupported)?
        .observe_route(endpoint)
}
#[cfg(not(any(windows, target_os = "android")))]
pub(crate) fn acquire(_: SocketAddr) -> ReadResult {
    Err(Unavailable::Unsupported)
}

#[cfg(any(test, target_os = "android"))]
pub(crate) fn parse_android(json: &str, endpoint: SocketAddr) -> ReadResult {
    use Unavailable as U;
    if json.len() > 8192 {
        return Err(U::Incomplete);
    }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| U::Incomplete)?;
    match v["status"].as_str() {
        Some("missing_permission") => return Err(U::MissingPermission),
        Some("denied_or_revoked") => return Err(U::DeniedOrRevoked),
        Some("no_network") => return Err(U::NoNetwork),
        Some("changed") => return Err(U::Changed),
        Some("unsupported") => return Err(U::Unsupported),
        Some("observed") => (),
        _ => return Err(U::Incomplete),
    }
    let n = |key: &str| v[key].as_u64().ok_or(U::Incomplete);
    let ip = |key: &str| {
        v[key]
            .as_str()
            .ok_or(U::Incomplete)?
            .parse()
            .map_err(|_| U::Incomplete)
    };
    let interface = u32::try_from(n("interface")?).map_err(|_| U::Incomplete)?;
    let network = n("network")?;
    if interface == 0 || network == 0 {
        return Err(U::Incomplete);
    }
    let gateway = v["gateway"].as_str().ok_or(U::Incomplete)?;
    Ok(Observation {
        generation: 0,
        captured: 0,
        interface,
        network,
        medium: match v["medium"].as_str() {
            Some("wifi") => Medium::Wifi,
            Some("ethernet") => Medium::Ethernet,
            Some("vpn") => Medium::Vpn,
            Some("cellular") => Medium::Cellular,
            _ => Medium::Unknown,
        },
        link: match v["up"].as_bool() {
            Some(true) => Link::Up,
            Some(false) => Link::Down,
            _ => return Err(U::Incomplete),
        },
        local: ip("local")?,
        source_selected: false,
        local_prefix: u8::try_from(n("local_prefix")?).map_err(|_| U::Incomplete)?,
        route_interface: interface,
        destination: ip("destination")?,
        route_prefix: u8::try_from(n("route_prefix")?).map_err(|_| U::Incomplete)?,
        next_hop: if gateway.is_empty() {
            NextHop::Direct
        } else {
            NextHop::Gateway(gateway.parse().map_err(|_| U::Incomplete)?)
        },
        endpoint,
        platform: match v["broad"].as_bool() {
            Some(true) => Platform::AndroidBroadPermissionObserved,
            Some(false) => Platform::Unknown,
            _ => return Err(U::Incomplete),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn n7b_android_permission_statuses_are_not_observations() {
        let endpoint = "192.168.1.3:7431".parse().unwrap();
        for (status, expected) in [
            ("missing_permission", Unavailable::MissingPermission),
            ("denied_or_revoked", Unavailable::DeniedOrRevoked),
            ("changed", Unavailable::Changed),
            ("no_network", Unavailable::NoNetwork),
            ("incomplete", Unavailable::Incomplete),
        ] {
            assert_eq!(
                parse_android(&format!("{{\"status\":\"{status}\"}}"), endpoint).unwrap_err(),
                expected
            );
        }
        assert!(parse_android("{\"status\":\"observed\"}", endpoint).is_err());
        let raw = r#"{"status":"observed","network":7,"interface":3,"medium":"wifi","up":true,"local":"192.168.1.2","local_prefix":24,"destination":"192.168.1.0","route_prefix":24,"gateway":"","broad":true}"#;
        let mut o = parse_android(raw, endpoint).unwrap();
        o.generation = 1;
        let h = Hint::parse("192.168.1.3:7431", Origin::Manual).unwrap();
        assert!(!o.source_selected);
        assert!(Candidate::evaluate(&h, &o, 0).is_err());
    }
}
