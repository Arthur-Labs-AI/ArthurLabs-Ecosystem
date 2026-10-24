package dev.kaloyan.arthur.security;

import android.app.Application;
import android.content.Context;
import java.security.GeneralSecurityException;

/** Native-only boundary. No plugin, Activity or retained key object. */
public final class NativeIdentityBridge {
    private NativeIdentityBridge() {}
    static boolean initialize(Application app) { return install(app); }
    private static native boolean install(Application app);
    private static native void networkChanged(long token, int kind);
    static void invalidateNetwork(long token, int kind) { networkChanged(token, kind); }
    private static RouteMonitor beginNetworkWatch(Context app, long token) { return new RouteMonitor(app, token); }

    public static String observeRoute(Context app, byte[] numeric, int scope) {
        return RouteObservation.read(app, numeric, scope);
    }
    public static byte[] create(Context app, String slot) throws GeneralSecurityException {
        return DeviceSigningIdentity.createIdentity(app, slot).publicIdentity();
    }
    public static byte[] read(Context app, String slot) throws GeneralSecurityException {
        return DeviceSigningIdentity.readIdentity(app, slot);
    }
    public static byte[] sign(Context app, String slot, byte[] expected, int domain, byte[] message)
            throws GeneralSecurityException {
        return DeviceSigningIdentity.reopen(app, slot, expected)
            .signDomainSeparated(domain(domain), message);
    }
    public static int available(Context app, String slot, byte[] expected) {
        try {
            return DeviceSigningIdentity.reopen(app, slot, expected).keyAvailability()
                == DeviceSigningIdentity.Availability.AVAILABLE ? 0 : 2;
        } catch (GeneralSecurityException | RuntimeException unavailable) { return 2; }
    }
    public static void delete(Context app, String slot) throws GeneralSecurityException {
        DeviceSigningIdentity.deleteIdentity(app, slot);
    }
    public static byte[] signTls13(Context app, String slot, byte[] expected, int role, byte[] preimage)
            throws GeneralSecurityException {
        TlsSignatureFormat.validate(role,preimage);
        return DeviceSigningIdentity.reopen(app,slot,expected).signTls13(role,preimage);
    }
    public static boolean validate(byte[] key) {
        try { IdentityFormat.validatePublic(key); return true; }
        catch (GeneralSecurityException | RuntimeException invalid) { return false; }
    }
    public static boolean verify(byte[] key, int domain, byte[] message, byte[] signature)
            throws GeneralSecurityException {
        return IdentityFormat.verify(key, domain(domain), message, signature);
    }
    private static IdentityFormat.Domain domain(int value) throws GeneralSecurityException {
        switch(value) {
            case 0: return IdentityFormat.Domain.Registry;
            case 1: return IdentityFormat.Domain.EnrollmentReceipt;
            case 2: return IdentityFormat.Domain.OriginalEvent;
            case 3: return IdentityFormat.Domain.SessionReceipt;
            default: throw IdentityFormat.invalid();
        }
    }
}
