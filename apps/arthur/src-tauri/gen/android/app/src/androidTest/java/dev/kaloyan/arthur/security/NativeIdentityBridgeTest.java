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
    @Test public void r2_keystore_socket_sync_g3_replay_restart() { assertTrue(runScenario(37)); }
    @Test public void r2_binding_membership_before_publication() { assertTrue(runScenario(38)); }
    @Test public void r2_shared_owner_cancel_budget_cleanup() { assertTrue(runScenario(39)); }
    @Test public void r2_actual_tls_io_faults_bounds_cleanup() { assertTrue(runScenario(40)); }
    @Test public void r2_sqlite_full_no_ack_reopen_retry() { assertTrue(runScenario(41)); }
    @Test public void r6_incremental_knowledge_history_bootstrap_reopen() { assertTrue(runScenario(48)); }
    static native boolean runScenario(int scenario);
    @Test public void r3_committed_registry_revocation_cancels_owner() { assertTrue(runScenario(42)); }
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
    @Test public void e3a2_official_rfc9807_vectors() { assertTrue(runScenario(19)); }
    @Test public void e3a2_actual_opaque_argon2_negatives() { assertTrue(runScenario(20)); }
    @Test public void e3a2_five_wrong_codes_durable() { assertTrue(runScenario(21)); }
    @Test public void e3a2_concurrent_reservation_and_restart() { assertTrue(runScenario(22)); }
    @Test public void e3a2_exact_approval_and_atomic_grant() { assertTrue(runScenario(23)); }
    @Test public void e3a2_expiry_and_native_key_loss() { assertTrue(runScenario(24)); }
    @Test public void e3a2_roles_context_and_initial_peer_keys() { assertTrue(runScenario(25)); }
    @Test public void e3a2_tls_transcript_hash_sizes() { assertTrue(runScenario(26)); }
    @Test public void e3a2_reverse_tls_roles() { assertTrue(runScenario(27)); }
    @Test public void e3a3_old_confirmation_new_reservation_rejected() { assertTrue(runScenario(28)); }
    @Test public void n7a_fake_routes_bounded_io_and_no_store_effects() { assertTrue(runScenario(29)); }
    @Test public void n7b_stale_ticket_new_reservation_remains_usable() { assertTrue(runScenario(30)); }
    @Test public void n7b_fake_generations_single_owner_and_no_store_effects() { assertTrue(runScenario(31)); }
    @Test public void n7b_actual_os_missing_network_state_permission_through_jni() {
        android.content.Context app = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED,
            app.checkSelfPermission(android.Manifest.permission.ACCESS_NETWORK_STATE));
        assertEquals("{\"status\":\"missing_permission\"}",NativeIdentityBridge.observeRoute(app,new byte[]{(byte)192,(byte)168,1,3},0));
        assertTrue(runScenario(32));
    }
    @Test public void n7c_actual_callback_missing_permission_through_jni() { assertTrue(runScenario(33)); }
    @Test public void n7d_actual_loopback_io_endpoints_and_cleanup() { assertTrue(runScenario(35)); }
    @Test public void n7d_actual_monotonic_deadlines() { assertTrue(runScenario(36)); }
    @Test public void eb19_no_java_to_native_signing_entrypoint() {
        int nativeMethods=0;
        for(java.lang.reflect.Method method: NativeIdentityBridge.class.getDeclaredMethods()) {
            if(java.lang.reflect.Modifier.isNative(method.getModifiers())) {
                nativeMethods++;
                assertTrue(method.getName().equals("install") || method.getName().equals("networkChanged"));
                assertTrue(java.lang.reflect.Modifier.isPrivate(method.getModifiers()));
            }
        }
        assertEquals(2,nativeMethods);
        assertEquals(0,NativeIdentityBridge.class.getDeclaredAnnotations().length);
    }
}
