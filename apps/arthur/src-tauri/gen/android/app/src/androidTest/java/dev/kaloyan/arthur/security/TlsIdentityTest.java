package dev.kaloyan.arthur.security;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.Properties;
import java.util.UUID;
import static org.junit.Assert.*;

/** Real platform signatures; all persisted output is PUBLIC ONLY and test scoped. */
@RunWith(AndroidJUnit4.class)
public final class TlsIdentityTest {
    private byte[] hex(String text) {
        byte[] bytes=new byte[text.length()/2];
        for(int i=0;i<bytes.length;i++) bytes[i]=(byte)Integer.parseInt(text.substring(2*i,2*i+2),16);
        return bytes;
    }
    private String encode(byte[] bytes) {
        StringBuilder text=new StringBuilder();
        for(byte value:bytes) text.append(String.format(java.util.Locale.ROOT,"%02x",value & 255));
        return text.toString();
    }
    private Properties cng() throws Exception {
        Properties fixture=new Properties();
        try(java.io.InputStream stream=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("tls-cng-public.properties")) { fixture.load(stream); }
        assertEquals("WINDOWS_CNG_TLS13",fixture.getProperty("producer"));
        return fixture;
    }
    @Test public void windows_tls_certificate_verify_on_android() throws Exception {
        Properties f=cng(); byte[] key=hex(f.getProperty("public"));
        byte[] message=hex(f.getProperty("message")), signature=hex(f.getProperty("signature"));
        assertTrue(TlsSignatureFormat.verify(key,0,message,signature));
        assertFalse(TlsSignatureFormat.verify(key,1,message,signature));
        message[129]^=1;
        assertFalse(TlsSignatureFormat.verify(key,0,message,signature));
    }
    @Test public void prepare_android_public_tls_fixture() throws Exception {
        Context app=InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationContext();
        assertEquals("dev.kaloyan.arthur.identitytest",app.getPackageName());
        DeviceSigningIdentity identity=DeviceSigningIdentity.createIdentity(app,UUID.randomUUID().toString());
        try {
            byte[] message=hex(cng().getProperty("message"));
            byte[] signature=identity.signTls13(0,message), key=identity.publicIdentity();
            assertTrue(TlsSignatureFormat.verify(key,0,message,signature));
            Properties output=new Properties();
            output.setProperty("producer","ANDROID_KEYSTORE_TLS13");
            output.setProperty("api",Integer.toString(android.os.Build.VERSION.SDK_INT));
            output.setProperty("abi",android.os.Build.SUPPORTED_ABIS[0]);
            output.setProperty("public",encode(key)); output.setProperty("message",encode(message)); output.setProperty("signature",encode(signature));
            try(java.io.OutputStream stream=new java.io.FileOutputStream(new java.io.File(app.getNoBackupFilesDir(),"e3a-android-tls-public.properties"))) { output.store(stream,"PUBLIC ONLY Android Keystore TLS fixture"); }
        } finally { identity.invalidateIdentity(); }
    }
}
