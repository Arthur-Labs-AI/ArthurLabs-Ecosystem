package dev.kaloyan.arthur.security;
import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
@RunWith(AndroidJUnit4.class)
public final class NativeIdentityBridgeTest {
    @Test public void r4_actual_owned_socket_selected_network_binding() { assertTrue(runScenario(47)); }
    @Test public void r6_incremental_knowledge_history_bootstrap_reopen() { assertTrue(runScenario(48)); }
    private void explicitLanRunner() {
        org.junit.Assume.assumeTrue("true".equals(androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("arthurR4Lan")));
    }
    @Test public void preflight() throws Exception {
        explicitLanRunner();
        android.content.Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("dev.kaloyan.arthur.identitytest",app.getPackageName());
        assertTrue("Dedicated debug application required",
            (app.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0);
        assertEquals("PermissionRequired: allow network state for the dedicated qualification app",
            android.content.pm.PackageManager.PERMISSION_GRANTED,
            app.checkSelfPermission(android.Manifest.permission.ACCESS_NETWORK_STATE));
        if (android.os.Build.VERSION.SDK_INT>=37) {
            assertEquals("PermissionRequired: allow Nearby devices / local network in Android Settings for M05 Sync Lab, then retry",
                android.content.pm.PackageManager.PERMISSION_GRANTED,
                app.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK"));
        }
        String windows=InstrumentationRegistry.getArguments().getString("arthurWindowsAddress");
        assertNotNull("Explicit Windows LAN address required",windows);
        String[] parts=windows.split("\\.",-1);
        assertEquals(4,parts.length);
        byte[] numeric=new byte[4];
        for(int i=0;i<4;i++) {
            int value=Integer.parseInt(parts[i]);
            assertTrue(value>=0 && value<=255 && Integer.toString(value).equals(parts[i]));
            numeric[i]=(byte)value;
        }
        JSONObject facts=new JSONObject(NativeIdentityBridge.observeRoute(app,numeric,0));
        assertEquals("Unavailable: native route observation refused", "observed",facts.getString("status"));
        assertEquals("Wrong Android source interface",InstrumentationRegistry.getArguments().getString("arthurAndroidAddress"),facts.getString("local"));
        assertTrue("Wi-Fi or Ethernet required", "wifi".equals(facts.getString("medium")) || "ethernet".equals(facts.getString("medium")));
        assertEquals("WAN/gateway route forbidden","",facts.getString("gateway"));
        assertTrue(facts.getBoolean("up"));
        assertTrue(facts.getLong("network")>0);
        assertTrue(facts.getInt("interface")>0);
        // Snapshot only; the existing native socket path still binds and rechecks
        // this route immediately before dialing and authenticates pinned TLS.
    }
    @Test public void prepare() { explicitLanRunner(); assertTrue(runScenario(43)); }
    @Test public void exchange() { explicitLanRunner(); assertTrue(runScenario(44)); }
    @Test public void resume() { explicitLanRunner(); assertTrue(runScenario(45)); }
    @Test public void cleanup() { explicitLanRunner(); assertTrue(runScenario(46)); }
    @Test public void registry() { explicitLanRunner(); assertTrue(runScenario(49)); }
    private static native boolean runScenario(int scenario);
    @Test public void n7c_actual_read_only_snapshot_no_source_or_lan_approval() throws Exception {
        android.content.Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("dev.kaloyan.arthur.identitytest",app.getPackageName());
        JSONObject facts=new JSONObject(NativeIdentityBridge.observeRoute(app,new byte[]{(byte)192,(byte)168,1,3},0));
        android.util.Log.i("ArthurR4Binding",facts.toString());
        assertEquals("observed",facts.getString("status"));
        assertTrue(facts.getLong("network")>0);assertTrue(facts.getInt("interface")>0);
        assertEquals(android.os.Build.VERSION.SDK_INT>=37 &&
            app.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK")==android.content.pm.PackageManager.PERMISSION_GRANTED,
            facts.getBoolean("broad"));
    }
    @Test public void n7c_actual_callback_registration_delivery_cleanup_and_closed_candidate() {
        assertTrue(runScenario(34));
    }
}
