package dev.kaloyan.arthur.security;

import android.app.Application;

/** Process-scoped bootstrap only. Does not open a database, create a key or start Sync. */
public final class SigningApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        try {
            System.loadLibrary("arthur_lib");
            NativeIdentityBridge.initialize(this);
        } catch (LinkageError | RuntimeException unavailable) {
            // Failure leaves the Rust bridge uninstalled. No fallback or secret logging.
        }
    }
}
