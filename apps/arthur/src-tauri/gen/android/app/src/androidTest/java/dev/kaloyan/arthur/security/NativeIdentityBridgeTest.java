package dev.kaloyan.arthur.security;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

/** Actual Rust -> Keystore instrumentation. Requires debug android-identity-tests
 * and identity-tests.tauri.json. Native harness refuses the production app id. */
@RunWith(AndroidJUnit4.class)
public final class NativeIdentityBridgeTest {
    private static native boolean runScenario(int scenario);
    @Test public void eb01_06_09_14_15_18_native_worker_and_crypto() { assertTrue(runScenario(1)); }
    @Test public void eb03_08_10_owned_reopen_substitution_invalidation() { assertTrue(runScenario(2)); }
    @Test public void eb11_os_created_activation_interrupted() { assertTrue(runScenario(3)); }
    @Test public void eb11_marker_without_key_does_not_regenerate() { assertTrue(runScenario(4)); }
    @Test public void eb12_invalidated_marker_before_delete() { assertTrue(runScenario(5)); }
    @Test public void eb13_sign_invalidate_order() { assertTrue(runScenario(6)); }
    @Test public void eb16_closed_bridge_cannot_reuse_references() { assertTrue(runScenario(7)); }
    @Test public void eb17_windows_fixture_through_rust_android_verifier() { assertTrue(runScenario(8)); }
    @Test public void eb20_actual_identity_cannot_open_production_trust() { assertTrue(runScenario(9)); }
    @Test public void eb09_owned_key_loss_never_regenerates() { assertTrue(runScenario(10)); }
    @Test public void eb08_15_malformed_sql_anchor_refuses() { assertTrue(runScenario(11)); }
    @Test public void eb20_android_registry_binding_and_revocation() { assertTrue(runScenario(12)); }
    @Test public void eb11_12_marker_survives_actual_owner_disk_reopen() { assertTrue(runScenario(13)); }
    @Test public void e3a_native_tls_signatures() { assertTrue(runScenario(14)); }
    @Test public void e3a_tls_scheme_and_input_rejection() { assertTrue(runScenario(15)); }
    @Test public void e3a_tls_durable_lifecycle() { assertTrue(runScenario(16)); }
    @Test public void e3a_mutual_tls13_and_closed_production() { assertTrue(runScenario(17)); }
    @Test public void e3a_tls_composition_binding() { assertTrue(runScenario(18)); }
    @Test public void eb19_no_java_to_native_signing_entrypoint() {
        int nativeMethods=0;
        for(java.lang.reflect.Method method: NativeIdentityBridge.class.getDeclaredMethods()) {
            if(java.lang.reflect.Modifier.isNative(method.getModifiers())) {
                nativeMethods++;
                assertEquals("install",method.getName());
                assertTrue(java.lang.reflect.Modifier.isPrivate(method.getModifiers()));
            }
        }
        assertEquals(1,nativeMethods);
        assertEquals(0,NativeIdentityBridge.class.getDeclaredAnnotations().length);
    }
}
