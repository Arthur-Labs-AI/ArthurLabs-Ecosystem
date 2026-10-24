package dev.kaloyan.arthur.security;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.UUID;

/** Independent AndroidKeyStore component; no Activity, WebView, Tauri commands or SQLite.
 * Native owner MUST commit its creating slot before create, publish the returned public
 * key atomically, and commit invalidated BEFORE delete. This component cannot authorize Sync.
 */
public final class DeviceSigningIdentity {
    public enum Availability { AVAILABLE, MISSING, UNAVAILABLE }
    // Only Keystore operations share this monitor; no app/runtime registry or callbacks.
    private static final Object KEY_OPERATIONS = new Object();
    private final String alias;
    private final byte[] expected;
    private DeviceSigningIdentity(String alias, byte[] expected) {
        this.alias = alias;
        this.expected = expected.clone();
    }
    private static String alias(Context context, String slot) throws GeneralSecurityException {
        if (context == null || slot == null || context.getApplicationContext() == null) throw unavailable();
        Context app = context.getApplicationContext();
        try {
            UUID id = UUID.fromString(slot);
            if (id.version() != 4 || !id.toString().equals(slot)) throw unavailable();
            return app.getPackageName() + ".sync.identity.v1." + slot;
        } catch (IllegalArgumentException exception) { throw unavailable(); }
    }
    private static KeyStore store() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            return store;
        } catch (Exception exception) { throw unavailable(); }
    }
    private static GeneralSecurityException unavailable() {
        return new GeneralSecurityException("identity_unavailable");
    }
    public static DeviceSigningIdentity createIdentity(Context app, String creatingSlot) throws GeneralSecurityException {
        String alias = alias(app, creatingSlot);
        synchronized (KEY_OPERATIONS) {
            try {
                if (store().containsAlias(alias)) throw unavailable();
                KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256).build());
                byte[] publicKey = IdentityFormat.publicIdentity(generator.generateKeyPair().getPublic());
                return new DeviceSigningIdentity(alias, publicKey);
            } catch (GeneralSecurityException | RuntimeException exception) {
                // Do not recreate, adopt or silently delete a partially created key.
                throw unavailable();
            }
        }
    }
    public static DeviceSigningIdentity reopen(Context app, String slot, byte[] durablePublicKey) throws GeneralSecurityException {
        if (durablePublicKey == null || durablePublicKey.length != 65) throw unavailable();
        DeviceSigningIdentity identity = new DeviceSigningIdentity(alias(app, slot), durablePublicKey);
        identity.publicIdentity();
        return identity;
    }
    public static byte[] readIdentity(Context app, String slot) throws GeneralSecurityException {
        String name = alias(app, slot);
        synchronized (KEY_OPERATIONS) {
            try {
                KeyStore store = store();
                if (!store.containsAlias(name) || store.getCertificate(name) == null) throw unavailable();
                byte[] key = IdentityFormat.publicIdentity(store.getCertificate(name).getPublicKey());
                new DeviceSigningIdentity(name, key).privateKey(store);
                return key;
            } catch (GeneralSecurityException | RuntimeException exception) { throw unavailable(); }
        }
    }
    public static void deleteIdentity(Context app, String slot) throws GeneralSecurityException {
        String name = alias(app, slot);
        synchronized (KEY_OPERATIONS) {
            try { store().deleteEntry(name); }
            catch (GeneralSecurityException | RuntimeException exception) { throw unavailable(); }
        }
    }
    private PrivateKey privateKey(KeyStore store) throws GeneralSecurityException {
        try {
            if (!store.containsAlias(alias) || store.getCertificate(alias) == null) throw unavailable();
            byte[] actual = IdentityFormat.publicIdentity(store.getCertificate(alias).getPublicKey());
            if (!Arrays.equals(actual, expected)) throw unavailable();
            java.security.Key key = store.getKey(alias, null);
            if (!(key instanceof PrivateKey) || !"EC".equals(key.getAlgorithm()) || key.getFormat() != null) throw unavailable();
            return (PrivateKey) key;
        } catch (GeneralSecurityException | RuntimeException exception) { throw unavailable(); }
    }
    public byte[] publicIdentity() throws GeneralSecurityException {
        synchronized (KEY_OPERATIONS) {
            privateKey(store());
            return expected.clone();
        }
    }
    public byte[] signDomainSeparated(IdentityFormat.Domain domain, byte[] message) throws GeneralSecurityException {
        byte[] preimage = IdentityFormat.preimage(domain, message);
        synchronized (KEY_OPERATIONS) {
            try {
                Signature signer = Signature.getInstance("SHA256withECDSA");
                signer.initSign(privateKey(store()));
                signer.update(preimage); // deliberately NOT a prehashed digest
                byte[] signature = IdentityFormat.derToP1363(signer.sign());
                if (!IdentityFormat.verify(expected, domain, message, signature)) throw unavailable();
                return signature;
            } catch (GeneralSecurityException | RuntimeException exception) { throw unavailable(); }
        }
    }
    public Availability keyAvailability() {
        synchronized (KEY_OPERATIONS) {
            try {
                KeyStore store = store();
                if (!store.containsAlias(alias)) return Availability.MISSING;
                privateKey(store);
                return Availability.AVAILABLE;
            } catch (GeneralSecurityException | RuntimeException exception) { return Availability.UNAVAILABLE; }
        }
    }
    public void invalidateIdentity() throws GeneralSecurityException {
        synchronized (KEY_OPERATIONS) {
            try { store().deleteEntry(alias); }
            catch (GeneralSecurityException | RuntimeException exception) { throw unavailable(); }
        }
    }
}
