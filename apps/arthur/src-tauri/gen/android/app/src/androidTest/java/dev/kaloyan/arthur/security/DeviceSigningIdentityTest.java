package dev.kaloyan.arthur.security;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Properties;
import java.util.UUID;

/** REAL ANDROID DEVICE/EMULATOR tests. Source is not runtime or bridge evidence. */
@RunWith(AndroidJUnit4.class)
public final class DeviceSigningIdentityTest {
    private Context app() { return InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationContext(); }
    private interface Checked { void run() throws GeneralSecurityException; }
    private void refuses(Checked work) {
        try { work.run(); fail("identity_rejection_missing"); }
        catch(GeneralSecurityException expected) { assertEquals("identity_unavailable",expected.getMessage()); }
    }
    @Test public void e2_01_02_03_keystore_reopen_export_refusal_and_loss() throws Exception {
        String slot=UUID.randomUUID().toString();
        DeviceSigningIdentity identity=DeviceSigningIdentity.createIdentity(app(),slot);
        try {
            byte[] publicKey=identity.publicIdentity();
            DeviceSigningIdentity reopened=DeviceSigningIdentity.reopen(app(),slot,publicKey);
            assertArrayEquals(publicKey,reopened.publicIdentity());
            KeyStore store=KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            assertNull(store.getKey(app().getPackageName()+".sync.identity.v1."+slot,null).getEncoded());
            refuses(()->DeviceSigningIdentity.createIdentity(app(),slot));
            byte[] message=new byte[]{1,2,3};
            byte[] signature=reopened.signDomainSeparated(IdentityFormat.Domain.Registry,message);
            assertTrue(IdentityFormat.verify(publicKey,IdentityFormat.Domain.Registry,message,signature));
            assertFalse(IdentityFormat.verify(publicKey,IdentityFormat.Domain.OriginalEvent,message,signature));
            byte[] wrong=publicKey.clone(); wrong[1]^=1;
            refuses(()->DeviceSigningIdentity.reopen(app(),slot,wrong));
            reopened.invalidateIdentity();
            assertEquals(DeviceSigningIdentity.Availability.MISSING,identity.keyAvailability());
            refuses(()->identity.signDomainSeparated(IdentityFormat.Domain.Registry,message));
            refuses(()->DeviceSigningIdentity.reopen(app(),slot,publicKey));
        } finally { identity.invalidateIdentity(); }
    }
    private byte[] hex(String text) {
        byte[] result=new byte[text.length()/2];
        for(int i=0;i<result.length;i++) result[i]=(byte)Integer.parseInt(text.substring(i*2,i*2+2),16);
        return result;
    }
    @Test public void e2_04_05_windows_cng_public_fixture_verifies_on_android() throws Exception {
        Properties fixture=new Properties();
        try(java.io.InputStream input=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("identity-cng-public.properties")) { fixture.load(input); }
        byte[] key=hex(fixture.getProperty("public"));
        byte[] message=hex(fixture.getProperty("message"));
        assertEquals(65,key.length); assertEquals(4,key[0]);
        for(IdentityFormat.Domain domain:IdentityFormat.Domain.values()) {
            byte[] signature=hex(fixture.getProperty(domain.name()));
            assertTrue(IdentityFormat.verify(key,domain,message,signature));
        }
    }
    @Test public void e2_06_prepare_public_only_device_fixture_for_windows() throws Exception {
        String slot=UUID.randomUUID().toString();
        DeviceSigningIdentity identity=DeviceSigningIdentity.createIdentity(app(),slot);
        try {
            Properties fixture=new Properties();
            fixture.setProperty("producer","ANDROID_KEYSTORE_DEVICE");
            fixture.setProperty("api",Integer.toString(android.os.Build.VERSION.SDK_INT));
            fixture.setProperty("abi",android.os.Build.SUPPORTED_ABIS[0]);
            fixture.setProperty("public",encodeHex(identity.publicIdentity()));
            byte[] message="Arthur E2 public interoperability fixture".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            fixture.setProperty("message",encodeHex(message));
            for(IdentityFormat.Domain domain:IdentityFormat.Domain.values()) {
                fixture.setProperty(domain.name(),encodeHex(identity.signDomainSeparated(domain,message)));
            }
            // PUBLIC ONLY. No private key, code, knowledge body or log output.
            java.io.File output=new java.io.File(app().getNoBackupFilesDir(),"e2-android-public.properties");
            try(java.io.OutputStream stream=new java.io.FileOutputStream(output)) { fixture.store(stream,"Public-only AndroidKeyStore verification fixture"); }
        } finally { identity.invalidateIdentity(); }
    }
    private String encodeHex(byte[] bytes) {
        StringBuilder output=new StringBuilder();
        for(byte value:bytes) output.append(String.format(java.util.Locale.ROOT,"%02x",value & 255));
        return output.toString();
    }
}
