//! Monotonic opaque tokens, never JNI raw pointers to a runtime or callback.
use super::{Signal, AVAILABLE, CAPABILITIES, LINK_PROPERTIES, LOST};
use crate::sync::security::{
    android::{bridge, Bridge},
    route_observer::Unavailable as U,
};
use jni::{
    objects::{GlobalRef, JClass},
    sys::{jint, jlong},
    JNIEnv,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};
struct Registry {
    next: u64,
    quarantined: bool,
    entries: BTreeMap<u64, Weak<Signal>>,
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            next: 0,
            quarantined: false,
            entries: BTreeMap::new(),
        })
    })
}
fn deliver(token: u64, kind: u32) {
    if ![AVAILABLE, LOST, CAPABILITIES, LINK_PROPERTIES].contains(&kind) {
        return;
    }
    let weak = registry()
        .lock()
        .ok()
        .and_then(|r| r.entries.get(&token).cloned());
    if let Some(s) = weak.and_then(|w| w.upgrade()) {
        s.notify(kind);
    }
}
#[no_mangle]
pub extern "system" fn Java_dev_kaloyan_arthur_security_NativeIdentityBridge_networkChanged(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    token: jlong,
    kind: jint,
) {
    let _ = std::panic::catch_unwind(|| deliver(token as u64, kind as u32));
}
pub(super) struct Watch {
    token: u64,
    signal: Arc<Signal>,
    bridge: Arc<Bridge>,
    object: Option<GlobalRef>,
}
impl Watch {
    pub(super) fn new(signal: &Arc<Signal>) -> Result<Self, U> {
        let bridge = bridge().map_err(|_| U::Unavailable)?;
        let token = {
            let mut r = registry().lock().map_err(|_| U::Unavailable)?;
            if r.quarantined || r.entries.len() >= 16 {
                return Err(U::Unavailable);
            }
            r.next = r.next.checked_add(1).ok_or(U::Unavailable)?;
            let token = r.next;
            r.entries.insert(token, Arc::downgrade(signal));
            token
        };
        let object = match bridge.start_network_watch(token) {
            Ok(o) => o,
            Err(e) => {
                signal.close();
                if let Ok(mut r) = registry().lock() {
                    r.entries.remove(&token);
                    // JNI allocation/exception failure may have happened after
                    // Java registered. Do not repeatedly create inert leftovers
                    // if best-effort Java cleanup could not execute.
                    if e != U::MissingPermission {
                        r.quarantined = true;
                    }
                }
                return Err(e);
            }
        };
        Ok(Self {
            token,
            signal: signal.clone(),
            bridge,
            object: Some(object),
        })
    }
    pub(super) fn close(&mut self) -> Result<(), U> {
        self.signal.close();
        // Revoke before calling Java; no registry/owner lock crosses JNI.
        let removed = registry()
            .lock()
            .map(|mut r| r.entries.remove(&self.token))
            .map_err(|_| U::Unavailable);
        let closed = if let Some(object) = self.object.take() {
            self.bridge.stop_network_watch(&object)
        } else {
            Ok(())
        };
        if closed.is_err() {
            if let Ok(mut r) = registry().lock() {
                r.quarantined = true;
            }
        }
        removed?;
        closed
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
#[cfg(feature = "android-identity-tests")]
pub(super) fn qualify_late_token() -> crate::sync::security::Result<()> {
    use crate::sync::security::SecurityError as E;
    let (signal, _) = Signal::channel();
    let mut w = Watch::new(&signal).map_err(|_| E::PlatformUnverified)?;
    let token = w.token;
    w.close().map_err(|_| E::State)?;
    let before = signal.kinds();
    deliver(token, AVAILABLE);
    if signal.kinds() != before || signal.snapshot().is_some() {
        return Err(E::State);
    }
    let weak = Arc::downgrade(&signal);
    drop(w);
    drop(signal);
    if weak.upgrade().is_some() {
        return Err(E::State);
    }
    Ok(())
}
