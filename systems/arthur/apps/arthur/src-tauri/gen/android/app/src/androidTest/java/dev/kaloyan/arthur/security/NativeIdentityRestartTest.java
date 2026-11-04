package dev.kaloyan.arthur.security;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertTrue;

/** Select prepare and reopen separately, with an actual process force-stop between. */
@RunWith(AndroidJUnit4.class)
public final class NativeIdentityRestartTest {
    private static native boolean runPhase(int phase);
    @Test public void prepare() { assertTrue(runPhase(1)); }
    @Test public void reopen() { assertTrue(runPhase(2)); }
}
