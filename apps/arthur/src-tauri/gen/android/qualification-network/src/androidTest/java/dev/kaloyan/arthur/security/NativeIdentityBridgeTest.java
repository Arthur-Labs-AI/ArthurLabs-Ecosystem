package dev.kaloyan.arthur.security;
import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
@RunWith(AndroidJUnit4.class)
public final class NativeIdentityBridgeTest {
    private static native boolean runScenario(int scenario);
    @Test public void n7c_actual_read_only_snapshot_no_source_or_lan_approval() throws Exception {
        android.content.Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("dev.kaloyan.arthur.identitytest",app.getPackageName());
        JSONObject facts=new JSONObject(NativeIdentityBridge.observeRoute(app,new byte[]{(byte)192,(byte)168,1,3},0));
        assertEquals("observed",facts.getString("status"));
        assertTrue(facts.getLong("network")>0);assertTrue(facts.getInt("interface")>0);
        assertFalse(facts.getBoolean("broad"));
    }
    @Test public void n7c_actual_callback_registration_delivery_cleanup_and_closed_candidate() {
        assertTrue(runScenario(34));
    }
}
