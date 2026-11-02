//! Owned only by the explicit monitor worker (MTA). Callbacks never access rows.
use super::{Signal, ADDRESS, INTERFACE, PROFILE, ROUTE};
use crate::native_security::route_observer::Unavailable as U;
use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use windows::core::{implement, Interface, GUID};
use windows::Win32::{Networking::NetworkListManager::*, System::Com::*};
use windows_sys::Win32::{
    Foundation::HANDLE, NetworkManagement::IpHelper::*, Networking::WinSock::AF_UNSPEC,
};
static QUARANTINED: AtomicBool = AtomicBool::new(false);
#[implement(INetworkEvents)]
struct ProfileSink(Arc<Signal>);
impl INetworkEvents_Impl for ProfileSink_Impl {
    fn NetworkAdded(&self, _: &GUID) -> windows::core::Result<()> {
        self.0.notify(PROFILE);
        Ok(())
    }
    fn NetworkDeleted(&self, _: &GUID) -> windows::core::Result<()> {
        self.0.notify(PROFILE);
        Ok(())
    }
    fn NetworkConnectivityChanged(
        &self,
        _: &GUID,
        _: NLM_CONNECTIVITY,
    ) -> windows::core::Result<()> {
        self.0.notify(PROFILE);
        Ok(())
    }
    fn NetworkPropertyChanged(
        &self,
        _: &GUID,
        _: NLM_NETWORK_PROPERTY_CHANGE,
    ) -> windows::core::Result<()> {
        self.0.notify(PROFILE);
        Ok(())
    }
}
unsafe fn signal(context: *const c_void, kind: u32) {
    // Context survives registration and all successful cancellation calls.
    if !context.is_null() {
        let s = &*context.cast::<Arc<Signal>>();
        s.notify(kind);
    }
}
unsafe extern "system" fn route(
    context: *const c_void,
    _: *const MIB_IPFORWARD_ROW2,
    _: MIB_NOTIFICATION_TYPE,
) {
    signal(context, ROUTE);
}
unsafe extern "system" fn interface(
    context: *const c_void,
    _: *const MIB_IPINTERFACE_ROW,
    _: MIB_NOTIFICATION_TYPE,
) {
    signal(context, INTERFACE);
}
unsafe extern "system" fn address(
    context: *const c_void,
    _: *const MIB_UNICASTIPADDRESS_ROW,
    _: MIB_NOTIFICATION_TYPE,
) {
    signal(context, ADDRESS);
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
pub(super) struct Watch {
    handles: Vec<HANDLE>,
    // Native callbacks retain a pointer to this Arc slot while Watch itself can move.
    #[expect(
        clippy::redundant_allocation,
        reason = "Box pins the Arc slot passed to Windows callbacks until cancellation or quarantine"
    )]
    context: Option<Box<Arc<Signal>>>,
    profile: Option<(IConnectionPoint, u32, INetworkEvents)>,
    signal: Arc<Signal>,
    _apartment: Apartment,
}
impl Watch {
    pub(super) fn new(s: &Arc<Signal>) -> Result<Self, U> {
        if QUARANTINED.load(Ordering::Acquire) {
            return Err(U::Unavailable);
        }
        // This worker owns its own MTA; no UI apartment assumption/marshalling.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| U::Os(e.code().0 as u32))?;
        }
        let mut watch = Self {
            handles: Vec::with_capacity(3),
            context: Some(Box::new(s.clone())),
            profile: None,
            signal: s.clone(),
            _apartment: Apartment,
        };
        let context = watch.context.as_deref().unwrap() as *const Arc<Signal> as *const c_void;
        unsafe {
            for kind in [ROUTE, INTERFACE, ADDRESS] {
                let mut handle = ptr::null_mut();
                let code = match kind {
                    ROUTE => NotifyRouteChange2(AF_UNSPEC, Some(route), context, true, &mut handle),
                    INTERFACE => NotifyIpInterfaceChange(
                        AF_UNSPEC,
                        Some(interface),
                        context,
                        true,
                        &mut handle,
                    ),
                    _ => NotifyUnicastIpAddressChange(
                        AF_UNSPEC,
                        Some(address),
                        context,
                        true,
                        &mut handle,
                    ),
                };
                if code != 0 {
                    return Err(U::Os(code));
                }
                if handle.is_null() {
                    return Err(U::Unavailable);
                }
                watch.handles.push(handle);
            }
            let manager: INetworkListManager =
                CoCreateInstance(&NetworkListManager, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| U::Os(e.code().0 as u32))?;
            let container: IConnectionPointContainer =
                manager.cast().map_err(|e| U::Os(e.code().0 as u32))?;
            let cp = container
                .FindConnectionPoint(&INetworkEvents::IID)
                .map_err(|e| U::Os(e.code().0 as u32))?;
            let sink: INetworkEvents = ProfileSink(s.clone()).into();
            let cookie = cp.Advise(&sink).map_err(|e| U::Os(e.code().0 as u32))?;
            watch.profile = Some((cp, cookie, sink));
        }
        Ok(watch)
    }
    pub(super) fn close(&mut self) -> Result<(), U> {
        self.signal.close();
        let mut failed = None;
        if let Some((cp, cookie, _sink)) = self.profile.take() {
            if let Err(e) = unsafe { cp.Unadvise(cookie) } {
                failed = Some(U::Os(e.code().0 as u32));
            }
        }
        for handle in self.handles.drain(..) {
            let code = unsafe { CancelMibChangeNotify2(handle) };
            if code != 0 {
                failed = Some(U::Os(code));
            }
        }
        if let Some(e) = failed {
            // Never free a context that a failed cancellation may still reference.
            // Quarantine prevents repeated registrations growing this failure leak.
            QUARANTINED.store(true, Ordering::Release);
            if let Some(context) = self.context.take() {
                Box::leak(context);
            }
            self.signal.failed(1);
            return Err(e);
        }
        self.context.take();
        Ok(())
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
