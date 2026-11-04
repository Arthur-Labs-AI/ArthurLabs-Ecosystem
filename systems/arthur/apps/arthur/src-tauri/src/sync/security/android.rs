//! E2B architecture answers:
//! 1. Truth: AndroidKeyStore private key; owner's e_identity slot/state/public anchor.
//! 2. Ownership: one CaptureStore serializes lifecycle/signing; Application owns JVM lifetime.
//! 3. Direction: owner -> Android provider -> JNI -> independent Java component.
//! 4. Contract: UUIDv4 slot, closed domain, <=1MiB message, SEC1-65/P1363-64; no private bytes.
//! 5. Failure: absent bootstrap, JNI exception, bad lengths/key/state refuse, without fallback.
//! 6. Lifecycle: process-lifetime VM + global Application/class refs; per-call attach/local frame.
//! 7. Seams: debug-only instrumentation uses disposable owners and independently closable bridge.
//! 8. Compatibility: CNG unchanged; no SQL/migrations/wire changes; Android adapter additive.
//! 9. Observation: typed SecurityError only; never describe a Java exception or log inputs.
//! 10. Security: bootstrap grants no membership/channel proof; production trust stays closed.
use super::{identity::*, Result, SecurityError as E};
use jni::{
    objects::{GlobalRef, JByteArray, JClass, JObject, JValue},
    sys::jboolean,
    JNIEnv, JavaVM,
};
use std::sync::{Arc, OnceLock, RwLock};
use uuid::Uuid;

static BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();
pub(crate) struct Bridge {
    vm: JavaVM,
    application: GlobalRef,
    class: GlobalRef,
    // Only bridge teardown ordering, never the runtime registry or a Java monitor.
    live: RwLock<bool>,
}
fn jni<T>(value: jni::errors::Result<T>) -> Result<T> {
    value.map_err(|_| E::KeyUnavailable)
}
impl From<jni::errors::Error> for E {
    fn from(_: jni::errors::Error) -> Self {
        E::KeyUnavailable
    }
}
impl Bridge {
    pub(super) fn start_network_watch(
        &self,
        token: u64,
    ) -> std::result::Result<GlobalRef, super::route_observer::Unavailable> {
        use super::route_observer::Unavailable as U;
        let (object, status) = self
            .call(|env, class| {
                let object = env
                    .call_static_method(
                        class,
                        "beginNetworkWatch",
                        "(Landroid/content/Context;J)Ldev/kaloyan/arthur/security/RouteMonitor;",
                        &[
                            JValue::Object(self.application.as_obj()),
                            JValue::Long(token as i64),
                        ],
                    )?
                    .l()?;
                let opened = (|| {
                    let status = env.get_field(&object, "status", "I")?.i()?;
                    Ok((env.new_global_ref(&object)?, status))
                })();
                if opened.is_err() {
                    // Registration may have succeeded before JNI allocation failed.
                    // Clear the pending JNI exception before best-effort cleanup.
                    let _ = env.exception_clear();
                    let _ = env.call_method(&object, "close", "()I", &[]);
                }
                opened
            })
            .map_err(|_| U::Unavailable)?;
        match status {
            0 => Ok(object),
            1 => Err(U::MissingPermission),
            2 => Err(U::DeniedOrRevoked),
            _ => Err(U::Unavailable),
        }
    }
    pub(super) fn stop_network_watch(
        &self,
        object: &GlobalRef,
    ) -> std::result::Result<(), super::route_observer::Unavailable> {
        use super::route_observer::Unavailable as U;
        let status = self
            .call(|env, _| Ok(env.call_method(object.as_obj(), "close", "()I", &[])?.i()?))
            .map_err(|_| U::Unavailable)?;
        match status {
            0 => Ok(()),
            2 => Err(U::DeniedOrRevoked),
            _ => Err(U::Unavailable),
        }
    }
    fn from_java(env: &mut JNIEnv<'_>, class: &JClass<'_>, app: &JObject<'_>) -> Result<Arc<Self>> {
        let application = jni(env.call_method(
            app,
            "getApplicationContext",
            "()Landroid/content/Context;",
            &[],
        ))?;
        let application = jni(application.l())?;
        if application.is_null()
            || !jni(env.is_instance_of(&application, "android/app/Application"))?
        {
            return Err(E::KeyUnavailable);
        }
        Ok(Arc::new(Self {
            vm: jni(env.get_java_vm())?,
            application: jni(env.new_global_ref(application))?,
            class: jni(env.new_global_ref(class))?,
            live: RwLock::new(true),
        }))
    }
    pub(super) fn call<T>(
        &self,
        work: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> Result<T>,
    ) -> Result<T> {
        let live = self.live.read().map_err(|_| E::KeyUnavailable)?;
        if !*live {
            return Err(E::KeyUnavailable);
        }
        // AttachGuard detaches only a thread attached by this invocation. JNIEnv
        // is local to this call, never stored or shared. JavaVM is never destroyed.
        let mut env = jni(self.vm.attach_current_thread())?;
        if jni(env.exception_check())? {
            let _ = env.exception_clear();
            return Err(E::KeyUnavailable);
        }
        let result = env.with_local_frame(32, |env| {
            // A global class reference supplied by Java avoids FindClass's native
            // worker ClassLoader trap. Conversion borrows, it does not own a local.
            let class: &JClass<'_> = self.class.as_obj().into();
            work(env, class)
        });
        if env.exception_check().unwrap_or(true) {
            let _ = env.exception_clear();
            return Err(E::KeyUnavailable);
        }
        result
    }
    fn bytes(env: &JNIEnv<'_>, value: JObject<'_>, length: usize) -> Result<Vec<u8>> {
        if value.is_null() {
            return Err(E::KeyUnavailable);
        }
        let array = JByteArray::from(value);
        if jni(env.get_array_length(&array))? as usize != length {
            return Err(E::Invalid);
        }
        jni(env.convert_byte_array(array))
    }
    pub(crate) fn observe_route(
        &self,
        endpoint: std::net::SocketAddr,
    ) -> super::route_observer::ReadResult {
        use super::route_observer::Unavailable as U;
        let json = self
            .call(|env, class| {
                let (bytes, scope) = match endpoint {
                    std::net::SocketAddr::V4(v) => (v.ip().octets().to_vec(), 0),
                    std::net::SocketAddr::V6(v) => (v.ip().octets().to_vec(), v.scope_id()),
                };
                let bytes = env.byte_array_from_slice(&bytes)?;
                let value = env
                    .call_static_method(
                        class,
                        "observeRoute",
                        "(Landroid/content/Context;[BI)Ljava/lang/String;",
                        &[
                            JValue::Object(self.application.as_obj()),
                            JValue::Object(bytes.as_ref()),
                            JValue::Int(scope as i32),
                        ],
                    )?
                    .l()?;
                if value.is_null() {
                    return Err(E::PlatformUnverified);
                }
                let string = jni::objects::JString::from(value);
                let value: String = env.get_string(&string)?.into();
                if value.len() > 8192 {
                    return Err(E::Limit);
                }
                Ok(value)
            })
            .map_err(|_| U::Unsupported)?;
        super::route_observer::parse_android(&json, endpoint)
    }
    fn key(&self, slot: Uuid, create: bool) -> Result<Vec<u8>> {
        valid_slot(slot)?;
        self.call(|env, class| {
            let slot = jni(env.new_string(slot.to_string()))?;
            let result = jni(env.call_static_method(
                class,
                if create { "create" } else { "read" },
                "(Landroid/content/Context;Ljava/lang/String;)[B",
                &[
                    JValue::Object(self.application.as_obj()),
                    JValue::Object(slot.as_ref()),
                ],
            ))?;
            Self::bytes(env, jni(result.l())?, 65)
        })
    }
    fn sign(
        &self,
        slot: Uuid,
        expected: &PublicIdentity,
        domain: Domain,
        message: &[u8],
    ) -> Result<Vec<u8>> {
        valid_slot(slot)?;
        bounded(message)?;
        self.call(|env, class| {
            let slot = jni(env.new_string(slot.to_string()))?;
            let key = jni(env.byte_array_from_slice(expected.sec1()))?;
            let bytes = jni(env.byte_array_from_slice(message))?;
            let result = jni(env.call_static_method(
                class,
                "sign",
                "(Landroid/content/Context;Ljava/lang/String;[BI[B)[B",
                &[
                    JValue::Object(self.application.as_obj()),
                    JValue::Object(slot.as_ref()),
                    JValue::Object(key.as_ref()),
                    JValue::Int(domain_id(domain)),
                    JValue::Object(bytes.as_ref()),
                ],
            ))?;
            Self::bytes(env, jni(result.l())?, 64)
        })
    }
    fn delete(&self, slot: Uuid) -> Result<()> {
        valid_slot(slot)?;
        self.call(|env, class| {
            let slot = jni(env.new_string(slot.to_string()))?;
            jni(env.call_static_method(
                class,
                "delete",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[
                    JValue::Object(self.application.as_obj()),
                    JValue::Object(slot.as_ref()),
                ],
            ))?;
            Ok(())
        })
    }
    fn sign_tls(
        &self,
        slot: Uuid,
        expected: &PublicIdentity,
        role: super::tls::CertificateRole,
        message: &[u8],
    ) -> Result<Vec<u8>> {
        valid_slot(slot)?;
        super::tls::validate_message(role, message)?;
        self.call(|env, class| {
            let slot = jni(env.new_string(slot.to_string()))?;
            let key = jni(env.byte_array_from_slice(expected.sec1()))?;
            let bytes = jni(env.byte_array_from_slice(message))?;
            let value = jni(env.call_static_method(
                class,
                "signTls13",
                "(Landroid/content/Context;Ljava/lang/String;[BI[B)[B",
                &[
                    JValue::Object(self.application.as_obj()),
                    JValue::Object(slot.as_ref()),
                    JValue::Object(key.as_ref()),
                    JValue::Int(role.id()),
                    JValue::Object(bytes.as_ref()),
                ],
            ))?;
            let value = jni(value.l())?;
            if value.is_null() {
                return Err(E::Signature);
            }
            let array = JByteArray::from(value);
            let size = jni(env.get_array_length(&array))?;
            if !(8..=72).contains(&size) {
                return Err(E::Signature);
            }
            jni(env.convert_byte_array(array))
        })
    }
    pub(crate) fn validate(&self, bytes: &[u8]) -> Result<()> {
        if bytes.len() != 65 || bytes[0] != 4 {
            return Err(E::Invalid);
        }
        self.call(|env, class| {
            let key = jni(env.byte_array_from_slice(bytes))?;
            let value = jni(env.call_static_method(
                class,
                "validate",
                "([B)Z",
                &[JValue::Object(key.as_ref())],
            ))?;
            if jni(value.z())? {
                Ok(())
            } else {
                Err(E::Invalid)
            }
        })
    }
    pub(super) fn verify(
        &self,
        key: &[u8],
        domain: Domain,
        message: &[u8],
        signature: &[u8],
    ) -> Result<()> {
        if key.len() != 65 || key[0] != 4 || signature.len() != 64 {
            return Err(E::Signature);
        }
        bounded(message)?;
        self.call(|env, class| {
            let key = jni(env.byte_array_from_slice(key))?;
            let bytes = jni(env.byte_array_from_slice(message))?;
            let signature = jni(env.byte_array_from_slice(signature))?;
            let value = jni(env.call_static_method(
                class,
                "verify",
                "([BI[B[B)Z",
                &[
                    JValue::Object(key.as_ref()),
                    JValue::Int(domain_id(domain)),
                    JValue::Object(bytes.as_ref()),
                    JValue::Object(signature.as_ref()),
                ],
            ))?;
            if jni(value.z())? {
                Ok(())
            } else {
                Err(E::Signature)
            }
        })
    }
    #[cfg(feature = "android-identity-tests")]
    pub(crate) fn close(&self) {
        *self.live.write().unwrap() = false;
    }
    #[cfg(feature = "android-identity-tests")]
    pub(crate) fn isolated(&self) -> Result<Arc<Self>> {
        self.call(|env, class| Self::from_java(env, class, self.application.as_obj()))
    }
    #[cfg(feature = "android-identity-tests")]
    pub(crate) fn test_directory(&self) -> Result<std::path::PathBuf> {
        self.call(|env, _| {
            let package = jni(env.call_method(
                self.application.as_obj(),
                "getPackageName",
                "()Ljava/lang/String;",
                &[],
            ))?;
            let package = jni::objects::JString::from(jni(package.l())?);
            let package: String = jni(env.get_string(&package))?.into();
            if package != "dev.kaloyan.arthur.identitytest" {
                return Err(E::State);
            }
            let cache = jni(env.call_method(
                self.application.as_obj(),
                "getCacheDir",
                "()Ljava/io/File;",
                &[],
            ))?;
            let path = jni(env.call_method(
                jni(cache.l())?,
                "getCanonicalPath",
                "()Ljava/lang/String;",
                &[],
            ))?;
            let path = jni::objects::JString::from(jni(path.l())?);
            let path: String = jni(env.get_string(&path))?.into();
            Ok(std::path::PathBuf::from(path).join(format!("e2b-{}", Uuid::new_v4())))
        })
    }
}
fn valid_slot(slot: Uuid) -> Result<()> {
    if slot.get_version_num() == 4 && slot.get_variant() == uuid::Variant::RFC4122 {
        Ok(())
    } else {
        Err(E::Invalid)
    }
}
fn bounded(message: &[u8]) -> Result<()> {
    if message.len() <= 1024 * 1024 {
        Ok(())
    } else {
        Err(E::Limit)
    }
}
fn domain_id(domain: Domain) -> i32 {
    match domain {
        Domain::Registry => 0,
        Domain::EnrollmentReceipt => 1,
        Domain::OriginalEvent => 2,
        Domain::SessionReceipt => 3,
    }
}
pub(crate) fn bridge() -> Result<Arc<Bridge>> {
    BRIDGE.get().cloned().ok_or(E::PlatformUnverified)
}

// Bootstrap only: no signing command is exported to Java or frontend IPC.
// The class argument is the actual app-loaded NativeIdentityBridge class.
#[no_mangle]
pub extern "system" fn Java_dev_kaloyan_arthur_security_NativeIdentityBridge_install(
    mut env: JNIEnv<'_>,
    class: JClass<'_>,
    app: JObject<'_>,
) -> jboolean {
    let installed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let candidate = Bridge::from_java(&mut env, &class, &app)?;
        if let Some(existing) = BRIDGE.get() {
            if jni(env.is_same_object(
                existing.application.as_obj(),
                candidate.application.as_obj(),
            ))? && jni(env.is_same_object(existing.class.as_obj(), candidate.class.as_obj()))?
            {
                return Ok(());
            }
            return Err(E::State);
        }
        BRIDGE.set(candidate).map_err(|_| E::State)
    }));
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
        return 0;
    }
    u8::from(matches!(installed, Ok(Ok(()))))
}

pub(crate) struct AndroidIdentity {
    slot: Uuid,
    bridge: Arc<Bridge>,
}
impl AndroidIdentity {
    pub fn slot(slot: Uuid) -> Result<Self> {
        valid_slot(slot)?;
        Ok(Self {
            slot,
            bridge: bridge()?,
        })
    }
    pub(crate) fn metadata_slot(&self) -> Uuid {
        self.slot
    }
}
impl DeviceIdentityStore for AndroidIdentity {
    fn create_identity(&self) -> Result<PublicIdentity> {
        PublicIdentity::from_sec1(self.bridge.key(self.slot, true)?)
    }
    fn public_identity(&self) -> Result<PublicIdentity> {
        PublicIdentity::from_sec1(self.bridge.key(self.slot, false)?)
    }
    fn sign_domain_separated(&self, domain: Domain, bytes: &[u8]) -> Result<Vec<u8>> {
        bounded(bytes)?;
        let key = self.public_identity()?;
        let signature = self.bridge.sign(self.slot, &key, domain, bytes)?;
        self.bridge.verify(key.sec1(), domain, bytes, &signature)?;
        Ok(signature)
    }
    fn key_availability(&self) -> KeyAvailability {
        if self.public_identity().is_ok() {
            KeyAvailability::Available
        } else {
            KeyAvailability::Unavailable
        }
    }
    fn invalidate_identity(&self) -> Result<()> {
        self.bridge.delete(self.slot)
    }
}
impl super::tls::NativeTls13 for AndroidIdentity {
    fn sign_tls13(&self, role: super::tls::CertificateRole, message: &[u8]) -> Result<Vec<u8>> {
        super::tls::validate_message(role, message)?;
        let expected = self.public_identity()?;
        let signature = self.bridge.sign_tls(self.slot, &expected, role, message)?;
        super::tls::verify(&expected, role, message, &signature)?;
        Ok(signature)
    }
}
