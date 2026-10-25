package dev.kaloyan.arthur.security;
import org.junit.Test;
import org.junit.Before;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;
import androidx.test.platform.app.InstrumentationRegistry;
/** Explicit runner only; public test configuration never carries private keys. */
public final class CrossDeviceSyncTest {
    @Before public void explicitRunner() { assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("arthurR3"))); }
    @Test public void prepare() { assertTrue(NativeIdentityBridgeTest.runScenario(43)); }
    @Test public void exchange() { assertTrue(NativeIdentityBridgeTest.runScenario(44)); }
    @Test public void resume() { assertTrue(NativeIdentityBridgeTest.runScenario(45)); }
    @Test public void cleanup() { assertTrue(NativeIdentityBridgeTest.runScenario(46)); }
}
