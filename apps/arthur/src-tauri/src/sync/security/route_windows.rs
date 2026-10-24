//! IP Helper snapshots. OS layout comes from locked windows-sys bindings.
//! IfType is a classification hint, NOT proof of physical LAN or Private profile.
use super::{ReadResult, Unavailable as U};
use crate::sync::security::route_candidate::*;
use std::{
    mem::{size_of, size_of_val},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    ptr,
};
use windows_sys::Win32::{NetworkManagement::IpHelper::*, Networking::WinSock::*};
fn native(endpoint: SocketAddr) -> SOCKADDR_INET {
    let mut a = SOCKADDR_INET::default();
    match endpoint {
        SocketAddr::V4(v) => {
            a.Ipv4.sin_family = AF_INET;
            a.Ipv4.sin_addr.S_un.S_addr = u32::from_ne_bytes(v.ip().octets());
        }
        SocketAddr::V6(v) => {
            a.Ipv6.sin6_family = AF_INET6;
            a.Ipv6.sin6_addr.u.Byte = v.ip().octets();
            a.Ipv6.Anonymous.sin6_scope_id = v.scope_id();
        }
    }
    a
}
unsafe fn ip(a: &SOCKADDR_INET) -> std::result::Result<IpAddr, U> {
    match a.si_family {
        AF_INET => Ok(Ipv4Addr::from(a.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes()).into()),
        AF_INET6 => Ok(Ipv6Addr::from(a.Ipv6.sin6_addr.u.Byte).into()),
        _ => Err(U::Incomplete),
    }
}
unsafe fn best(dst: &SOCKADDR_INET) -> std::result::Result<(MIB_IPFORWARD_ROW2, SOCKADDR_INET), U> {
    let mut route = MIB_IPFORWARD_ROW2::default();
    let mut src = SOCKADDR_INET::default();
    let code = GetBestRoute2(ptr::null(), 0, ptr::null(), dst, 0, &mut route, &mut src);
    if code != 0 {
        return Err(U::Os(code));
    }
    Ok((route, src))
}
// Validate every linked-list pointer against the OS buffer before dereference.
fn inside<T>(p: *const T, buffer: &[u64]) -> bool {
    let start = buffer.as_ptr() as usize;
    let end = start + size_of_val(buffer);
    let a = p as usize;
    a >= start
        && a.checked_add(size_of::<T>()).is_some_and(|b| b <= end)
        && a % std::mem::align_of::<T>() == 0
}
// Only an exact, unique NLM connection for this adapter establishes category.
// COM apartment is borrowed if already initialized differently; only our own
// successful initialization is balanced. No COM object escapes this call/thread.
unsafe fn profile(luid: &windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH) -> Option<i32> {
    use windows::Win32::{Networking::NetworkListManager::*, System::Com::*};
    let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
    if hr.is_err() && hr.0 != 0x80010106u32 as i32 {
        return None;
    } // RPC_E_CHANGED_MODE
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    let _apartment = Apartment(hr.is_ok());
    let mut id = windows_sys::core::GUID::default();
    if ConvertInterfaceLuidToGuid(luid, &mut id) != 0 {
        return None;
    }
    let id = windows::core::GUID::from_values(id.data1, id.data2, id.data3, id.data4);
    let manager: INetworkListManager =
        CoCreateInstance(&NetworkListManager, None, CLSCTX_INPROC_SERVER).ok()?;
    let connections = manager.GetNetworkConnections().ok()?;
    let mut category = None;
    for _ in 0..4096 {
        let mut row = [None];
        let mut fetched = 0;
        connections.Next(&mut row, Some(&mut fetched)).ok()?;
        if fetched == 0 {
            return category;
        }
        let connection = row[0].take()?;
        if connection.GetAdapterId().ok()? == id {
            if category.is_some() {
                return None;
            } // multi-connection ambiguity
            if !connection.IsConnected().ok()?.as_bool() {
                return None;
            }
            category = Some(connection.GetNetwork().ok()?.GetCategory().ok()?.0);
        }
    }
    None
}
unsafe fn interface(route: &MIB_IPFORWARD_ROW2) -> std::result::Result<MIB_IF_ROW2, U> {
    let mut row = MIB_IF_ROW2::default();
    row.InterfaceLuid = route.InterfaceLuid;
    let code = GetIfEntry2(&mut row);
    if code != 0 {
        return Err(U::Os(code));
    }
    if row.InterfaceIndex != route.InterfaceIndex {
        return Err(U::Changed);
    }
    Ok(row)
}
fn medium(row: &MIB_IF_ROW2) -> Medium {
    if matches!(row.Type, 23 | 131) {
        return Medium::Vpn;
    }
    if matches!(row.Type, 243 | 244) {
        return Medium::Cellular;
    }
    if row.Type == 24 {
        return Medium::Loopback;
    }
    if row.InterfaceAndOperStatusFlags._bitfield & 0x13 != 1 {
        return Medium::Unknown;
    }
    match (row.Type, row.PhysicalMediumType) {
        (71, 1 | 9) => Medium::Wifi,
        (6, 14) => Medium::Ethernet,
        _ => Medium::Unknown,
    }
}
pub(super) fn acquire(endpoint: SocketAddr) -> ReadResult {
    let dst = native(endpoint);
    // Safety: bindings supply C layout; outputs zero initialized; OS-owned
    // pointers are read only while their bounded, aligned backing buffer lives.
    unsafe {
        let (route, src) = best(&dst)?;
        let source = ip(&src)?;
        let iface = interface(&route)?;
        let category = profile(&route.InterfaceLuid);
        let mut bytes = 15 * 1024u32;
        let mut found = None;
        for _ in 0..3 {
            if bytes as usize > 1024 * 1024 {
                return Err(U::Incomplete);
            }
            let mut buffer = vec![0u64; (bytes as usize).div_ceil(8)];
            let code = GetAdaptersAddresses(
                dst.si_family as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            );
            if code == 111 {
                continue;
            } // ERROR_BUFFER_OVERFLOW; bounded retry
            if code != 0 {
                return Err(U::Os(code));
            }
            let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
            let mut count = 0;
            while !adapter.is_null() {
                count += 1;
                if count > 4096 || !inside(adapter, &buffer) {
                    return Err(U::Incomplete);
                }
                let a = &*adapter;
                if a.Anonymous1.Anonymous.Length < size_of::<IP_ADAPTER_ADDRESSES_LH>() as u32 {
                    return Err(U::Incomplete);
                }
                let index = if endpoint.is_ipv4() {
                    a.Anonymous1.Anonymous.IfIndex
                } else {
                    a.Ipv6IfIndex
                };
                if index == route.InterfaceIndex && a.Luid.Value == route.InterfaceLuid.Value {
                    let mut unicast = a.FirstUnicastAddress;
                    let mut n = 0;
                    while !unicast.is_null() {
                        n += 1;
                        if n > 4096 || !inside(unicast, &buffer) {
                            return Err(U::Incomplete);
                        }
                        let u = &*unicast;
                        if u.Anonymous.Anonymous.Length
                            < size_of::<IP_ADAPTER_UNICAST_ADDRESS_LH>() as u32
                        {
                            return Err(U::Incomplete);
                        }
                        let address = u.Address.lpSockaddr.cast::<SOCKADDR_INET>();
                        // IPv4 sockaddr is 16 bytes; copy only the reported family size.
                        let len = if endpoint.is_ipv4() {
                            size_of::<SOCKADDR_IN>()
                        } else {
                            size_of::<SOCKADDR_IN6>()
                        };
                        let start = buffer.as_ptr() as usize;
                        let pos = address as usize;
                        if u.Address.iSockaddrLength < len as i32
                            || pos < start
                            || pos
                                .checked_add(len)
                                .is_none_or(|v| v > start + size_of_val(buffer.as_slice()))
                        {
                            return Err(U::Incomplete);
                        }
                        let mut addr = SOCKADDR_INET::default();
                        ptr::copy_nonoverlapping(
                            address.cast::<u8>(),
                            (&mut addr as *mut SOCKADDR_INET).cast::<u8>(),
                            len,
                        );
                        if ip(&addr)? == source {
                            if found.is_some() || u.DadState != IpDadStatePreferred {
                                return Err(U::Incomplete);
                            }
                            let medium = match a.IfType {
                                71 => Medium::Wifi,
                                6 => Medium::Ethernet,
                                23 | 131 => Medium::Vpn,
                                243 | 244 => Medium::Cellular,
                                24 => Medium::Loopback,
                                _ => Medium::Unknown,
                            };
                            found = Some((
                                index,
                                medium,
                                if a.OperStatus == 1 {
                                    Link::Up
                                } else {
                                    Link::Down
                                },
                                u.OnLinkPrefixLength,
                            ));
                        }
                        unicast = u.Next;
                    }
                }
                adapter = a.Next;
            }
            break;
        }
        let (index, adapter_medium, link, prefix) = found.ok_or(U::Incomplete)?;
        let physical_medium = medium(&iface);
        if adapter_medium != physical_medium && physical_medium != Medium::Unknown {
            return Err(U::Incomplete);
        }
        let again_iface = interface(&route)?;
        if iface.Type != again_iface.Type
            || iface.PhysicalMediumType != again_iface.PhysicalMediumType
            || iface.OperStatus != again_iface.OperStatus
            || iface.InterfaceAndOperStatusFlags._bitfield
                != again_iface.InterfaceAndOperStatusFlags._bitfield
            || (iface.OperStatus == 1) != (link == Link::Up)
            || category != profile(&route.InterfaceLuid)
        {
            return Err(U::Changed);
        }
        let (again, again_src) = best(&dst)?;
        if route.InterfaceIndex != again.InterfaceIndex
            || route.InterfaceLuid.Value != again.InterfaceLuid.Value
            || source != ip(&again_src)?
            || ip(&route.NextHop)? != ip(&again.NextHop)?
            || ip(&route.DestinationPrefix.Prefix)? != ip(&again.DestinationPrefix.Prefix)?
            || route.DestinationPrefix.PrefixLength != again.DestinationPrefix.PrefixLength
        {
            return Err(U::Changed);
        }
        if source.is_ipv4() != endpoint.is_ipv4() || route.Loopback {
            return Err(U::Incomplete);
        }
        let hop = ip(&route.NextHop)?;
        Ok(Observation {
            generation: 0,
            captured: 0,
            interface: index,
            network: route.InterfaceLuid.Value,
            medium: physical_medium,
            link,
            local: source,
            source_selected: true,
            local_prefix: prefix,
            route_interface: route.InterfaceIndex,
            destination: ip(&route.DestinationPrefix.Prefix)?,
            route_prefix: route.DestinationPrefix.PrefixLength,
            next_hop: if hop.is_unspecified() {
                NextHop::Direct
            } else {
                NextHop::Gateway(hop)
            },
            endpoint,
            platform: match category {
                Some(1) => Platform::WindowsPrivateProfileObserved,
                Some(v @ (0 | 2)) => Platform::WindowsOtherProfileObserved(v),
                _ => Platform::Unknown,
            },
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn n7b_actual_windows_ip_helper_observation() {
        let endpoint = "192.168.1.3:7431".parse().unwrap();
        match acquire(endpoint) {
            Ok(o) => {
                assert!(o.interface > 0 && o.network > 0);
                assert_eq!(o.local.is_ipv4(), endpoint.is_ipv4());
                assert!(matches!(
                    o.platform,
                    Platform::Unknown
                        | Platform::WindowsPrivateProfileObserved
                        | Platform::WindowsOtherProfileObserved(0 | 2)
                ));
                assert_eq!(o.generation, 0); // only runtime stamps eligibility generations
                println!("OS IP Helper snapshot acquired; profile {:?}; medium {:?}; link {:?}; prefix {}; route prefix {}; next-hop {:?}",o.platform,o.medium,o.link,o.local_prefix,o.route_prefix,match o.next_hop {NextHop::Direct=>"direct",_=>"gateway"});
            }
            Err(U::Os(code)) => panic!("actual Windows acquisition failed: {code}"),
            Err(e) => panic!("actual Windows snapshot incomplete: {e:?}"),
        }
    }
}
