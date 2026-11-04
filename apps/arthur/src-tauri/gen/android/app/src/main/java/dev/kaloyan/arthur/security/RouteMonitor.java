package dev.kaloyan.arthur.security;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.LinkProperties;
import java.util.concurrent.atomic.AtomicBoolean;

/** Application-owned, invalidation-only callback. Never reads route facts here. */
public final class RouteMonitor {
    private static final AtomicBoolean quarantined = new AtomicBoolean(false);
    private final AtomicBoolean live = new AtomicBoolean(false);
    private final ConnectivityManager manager;
    private final ConnectivityManager.NetworkCallback callback;
    // 1 missing permission, 2 revoked/denied, 3 unavailable. No fallback.
    public final int status;
    RouteMonitor(Context context, long token) {
        Context app = context.getApplicationContext();
        manager = app.getSystemService(ConnectivityManager.class);
        callback = new ConnectivityManager.NetworkCallback() {
            private void emit(int kind) {
                if (live.get()) NativeIdentityBridge.invalidateNetwork(token, kind);
            }
            @Override public void onAvailable(Network n) { emit(16); }
            @Override public void onLost(Network n) { emit(32); }
            @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { emit(64); }
            @Override public void onLinkPropertiesChanged(Network n, LinkProperties p) { emit(128); }
            @Override public void onBlockedStatusChanged(Network n, boolean blocked) { emit(64); }
        };
        int result;
        if (app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED) {
            result = 1;
        } else if (manager == null || quarantined.get()) {
            result = 3;
        } else {
            live.set(true);
            try { manager.registerDefaultNetworkCallback(callback); result = 0; }
            catch (SecurityException denied) { failedRegistration(); result = 2; }
            catch (RuntimeException unavailable) {
                failedRegistration();
                result = 3;
            }
        }
        status = result;
    }
    private void failedRegistration() {
        live.set(false); quarantined.set(true);
        try { manager.unregisterNetworkCallback(callback); } catch (RuntimeException ignored) { }
    }
    public int close() {
        if (!live.getAndSet(false)) return 0;
        try { manager.unregisterNetworkCallback(callback); return 0; }
        catch (SecurityException denied) { quarantined.set(true); return 2; }
        catch (RuntimeException unavailable) { quarantined.set(true); return 3; }
    }
}
