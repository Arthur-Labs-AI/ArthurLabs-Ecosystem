package dev.kaloyan.arthur.security;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Signature;
import java.util.Arrays;

/** RFC8446 CertificateVerify only; independent of Arthur application domains. */
public final class TlsSignatureFormat {
    private TlsSignatureFormat() {}
    public static void validate(int role, byte[] preimage) throws GeneralSecurityException {
        if (role != 0 && role != 1) throw IdentityFormat.invalid();
        byte[] context=(role==0 ? "TLS 1.3, server CertificateVerify" : "TLS 1.3, client CertificateVerify")
            .getBytes(StandardCharsets.US_ASCII);
        if(preimage==null || (preimage.length!=130 && preimage.length!=146)) throw IdentityFormat.invalid();
        for(int i=0;i<64;i++) if(preimage[i]!=32) throw IdentityFormat.invalid();
        for(int i=0;i<context.length;i++) if(preimage[64+i]!=context[i]) throw IdentityFormat.invalid();
        if(preimage[64+context.length]!=0) throw IdentityFormat.invalid();
    }
    public static boolean verify(byte[] publicKey,int role,byte[] preimage,byte[] signature) {
        try {
            validate(role,preimage);
            byte[] canonical=IdentityFormat.p1363ToDer(IdentityFormat.derToP1363(signature));
            if(!Arrays.equals(canonical,signature)) return false;
            Signature verifier=Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(IdentityFormat.publicKey(publicKey));
            verifier.update(preimage);
            return verifier.verify(signature);
        } catch(GeneralSecurityException | RuntimeException invalid) { return false; }
    }
}
