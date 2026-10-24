//! Dormant, conservative route classification. Never an authorization capability.
use super::{Result, SecurityError as E};
use std::net::{IpAddr, SocketAddr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    Manual,
    Discovery,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Address {
    Numeric(SocketAddr),
    Dns(String, u16),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hint {
    pub address: Address,
    pub origin: Origin,
}
impl Hint {
    pub fn parse(input: &str, origin: Origin) -> Result<Self> {
        if input.len() > 128 {
            return Err(E::Limit);
        }
        if input.is_empty()
            || !input.is_ascii()
            || input.bytes().any(|b| b.is_ascii_whitespace())
            || input
                .bytes()
                .any(|b| matches!(b, b'/' | b'\\' | b'@' | b'?' | b'#'))
        {
            return Err(E::Invalid);
        }
        let address = if let Ok(endpoint) = input.parse::<SocketAddr>() {
            validate_endpoint(endpoint)?;
            Address::Numeric(endpoint)
        } else {
            let (host, port) = input.rsplit_once(':').ok_or(E::Invalid)?;
            if host.is_empty()
                || host.len() > 253
                || host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                || !host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
            {
                return Err(E::Invalid);
            }
            let port = parse_port(port)?;
            Address::Dns(host.to_ascii_lowercase(), port)
        };
        // Reject alternate numeric port spellings even when std accepts them.
        let port = input.rsplit_once(':').ok_or(E::Invalid)?.1;
        parse_port(port)?;
        Ok(Self { address, origin })
    }
}
fn parse_port(port: &str) -> Result<u16> {
    if port.is_empty()
        || port.len() > 5
        || port.starts_with('0')
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(E::Invalid);
    }
    let n = port.parse().map_err(|_| E::Invalid)?;
    if n == 0 {
        return Err(E::Invalid);
    }
    Ok(n)
}
fn validate_endpoint(a: SocketAddr) -> Result<()> {
    if a.port() == 0 || a.ip().is_unspecified() || a.ip().is_loopback() || a.ip().is_multicast() {
        return Err(E::Invalid);
    }
    match a {
        SocketAddr::V4(v) if v.ip().is_broadcast() => Err(E::Invalid),
        SocketAddr::V6(v)
            if v.ip().to_ipv4_mapped().is_some()
                || v.flowinfo() != 0
                || (v.ip().is_unicast_link_local() != (v.scope_id() != 0)) =>
        {
            Err(E::Invalid)
        }
        _ => Ok(()),
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Medium {
    Wifi,
    Ethernet,
    Cellular,
    Vpn,
    Loopback,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Link {
    Up,
    Down,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NextHop {
    Direct,
    Gateway(IpAddr),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    WindowsPrivateProfileObserved,
    AndroidBroadPermissionObserved,
    AndroidPickerEndpointObserved(SocketAddr),
    PermissionDenied,
    PermissionRevoked,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub generation: u64,
    pub captured: u64,
    pub interface: u32,
    pub medium: Medium,
    pub link: Link,
    pub local: IpAddr,
    pub local_prefix: u8,
    pub route_interface: u32,
    pub destination: IpAddr,
    pub route_prefix: u8,
    pub next_hop: NextHop,
    pub endpoint: SocketAddr,
    pub platform: Platform,
}
fn same_prefix(a: IpAddr, b: IpAddr, prefix: u8) -> bool {
    match (a, b) {
        (IpAddr::V4(a), IpAddr::V4(b)) if prefix > 0 && prefix <= 32 => {
            (u32::from(a) ^ u32::from(b)) >> (32 - prefix) == 0
        }
        (IpAddr::V6(a), IpAddr::V6(b)) if prefix > 0 && prefix <= 128 => {
            (u128::from(a) ^ u128::from(b)) >> (128 - prefix) == 0
        }
        _ => false,
    }
}
fn eligible_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private(),
        IpAddr::V6(v) => v.is_unique_local() || v.is_unicast_link_local(),
    }
}
#[derive(Clone)]
pub(crate) struct Candidate {
    hint: Hint,
    observed: Observation,
}
impl Candidate {
    pub fn evaluate(hint: &Hint, observed: &Observation, now: u64) -> Result<Self> {
        let endpoint = match hint.address {
            Address::Numeric(a) => a,
            Address::Dns(..) => return Err(E::N7PolicyPending),
        };
        validate_endpoint(endpoint)?;
        if now < observed.captured
            || now - observed.captured > 3
            || observed.generation == 0
            || observed.interface == 0
            || observed.route_interface != observed.interface
            || observed.link != Link::Up
            || !matches!(observed.medium, Medium::Wifi | Medium::Ethernet)
            || observed.next_hop != NextHop::Direct
            || endpoint != observed.endpoint
            || !eligible_ip(endpoint.ip())
            || !eligible_ip(observed.local)
            || endpoint.ip() == observed.local
            || !same_prefix(observed.local, endpoint.ip(), observed.local_prefix)
            || !same_prefix(observed.destination, endpoint.ip(), observed.route_prefix)
        {
            return Err(E::Trust);
        }
        if let SocketAddr::V6(a) = endpoint {
            if a.ip().is_unicast_link_local() && a.scope_id() != observed.interface {
                return Err(E::Trust);
            }
        }
        if let IpAddr::V4(ip) = endpoint.ip() {
            // /31 and /32 local subnets and subnet endpoints need an explicit N7 decision.
            if observed.local_prefix > 30 {
                return Err(E::N7PolicyPending);
            }
            let mask = u32::MAX >> observed.local_prefix;
            let IpAddr::V4(local) = observed.local else {
                return Err(E::Invalid);
            };
            for value in [ip, local] {
                let host = u32::from(value) & mask;
                if host == 0 || host == mask {
                    return Err(E::Invalid);
                }
            }
        }
        match &observed.platform {
            Platform::WindowsPrivateProfileObserved | Platform::AndroidBroadPermissionObserved => {
                ()
            }
            Platform::AndroidPickerEndpointObserved(a) if *a == endpoint => (),
            _ => return Err(E::N7PolicyPending),
        }
        Ok(Self {
            hint: hint.clone(),
            observed: observed.clone(),
        })
    }
    pub fn revalidate(&self, current: &Observation, now: u64) -> Result<()> {
        Self::evaluate(&self.hint, current, now)?;
        let mut expected = self.observed.clone();
        expected.captured = current.captured;
        if current != &expected {
            return Err(E::Trust);
        }
        Ok(())
    }
    pub fn connected(
        &self,
        current: &Observation,
        local: IpAddr,
        remote: SocketAddr,
        now: u64,
    ) -> Result<()> {
        self.revalidate(current, now)?;
        if local != current.local || remote != current.endpoint {
            return Err(E::Trust);
        }
        Ok(())
    }
    pub fn activate(&self) -> Result<()> {
        Err(E::N7PolicyPending)
    }
}
// No live OS observations/permission authority are implemented by this phase.
pub(crate) fn windows_observation() -> Result<Observation> {
    Err(E::N7PolicyPending)
}
pub(crate) fn android_observation() -> Result<Observation> {
    Err(E::N7PolicyPending)
}
