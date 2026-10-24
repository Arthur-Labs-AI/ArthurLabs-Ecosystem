package dev.kaloyan.arthur.security;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.Properties;

/** Explicit javac/java runner: HOST-ONLY JCA evidence, never AndroidKeyStore evidence. */
public final class IdentityFormatHostTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("identity_contract_failed"); }
    private interface Checked { void run() throws GeneralSecurityException; }
    private static void rejects(Checked work) {
        try { work.run(); throw new AssertionError("identity_rejection_missing"); }
        catch (GeneralSecurityException expected) { checks++; }
    }
    static byte[] hex(String text) {
        byte[] bytes = new byte[text.length()/2];
        for (int i=0;i<bytes.length;i++) bytes[i]=(byte)Integer.parseInt(text.substring(i*2,i*2+2),16);
        return bytes;
    }
    private static String hex(byte[] bytes) {
        StringBuilder result=new StringBuilder();
        for(byte value:bytes) result.append(String.format("%02x", value & 255));
        return result.toString();
    }
    private static KeyPair key(String curve) throws GeneralSecurityException {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec(curve));
        return generator.generateKeyPair();
    }
    private static void generatePublicFixture(String path) throws Exception {
        KeyPair key=key("secp256r1");
        byte[] message="Arthur E2 public interoperability fixture".getBytes(StandardCharsets.US_ASCII);
        StringBuilder fixture=new StringBuilder("# Public keys/signatures only. No private key export. HOST-ONLY, NOT ANDROID.\nproducer=HOST_JCA_SunEC\n");
        fixture.append("public=").append(hex(IdentityFormat.publicIdentity(key.getPublic()))).append('\n');
        fixture.append("message=").append(hex(message)).append('\n');
        for(IdentityFormat.Domain domain:IdentityFormat.Domain.values()) {
            Signature signer=Signature.getInstance("SHA256withECDSA");
            signer.initSign(key.getPrivate());
            signer.update(IdentityFormat.preimage(domain,message));
            fixture.append(domain.name()).append('=').append(hex(IdentityFormat.derToP1363(signer.sign()))).append('\n');
        }
        Files.write(Paths.get(path),fixture.toString().getBytes(StandardCharsets.US_ASCII));
    }
    private static void fixture(String path) throws Exception {
        Properties fixture=new Properties();
        try(InputStream input=Files.newInputStream(Paths.get(path))) { fixture.load(input); }
        byte[] publicKey=hex(fixture.getProperty("public"));
        byte[] message=hex(fixture.getProperty("message"));
        byte[] other=IdentityFormat.publicIdentity(key("secp256r1").getPublic());
        for(IdentityFormat.Domain domain:IdentityFormat.Domain.values()) {
            byte[] signature=hex(fixture.getProperty(domain.name()));
            check(IdentityFormat.verify(publicKey,domain,message,signature));
            check(Arrays.equals(signature,IdentityFormat.derToP1363(IdentityFormat.p1363ToDer(signature))));
            byte[] changed=message.clone(); changed[0]^=1;
            check(!IdentityFormat.verify(publicKey,domain,changed,signature));
            check(!IdentityFormat.verify(other,domain,message,signature));
            IdentityFormat.Domain wrong=IdentityFormat.Domain.values()[(domain.ordinal()+1)%4];
            check(!IdentityFormat.verify(publicKey,wrong,message,signature));
            signature[0]^=1;
            check(!IdentityFormat.verify(publicKey,domain,message,signature));
        }
    }
    public static void main(String[] args) throws Exception {
        if(args.length==2 && args[0].equals("generate")) { generatePublicFixture(args[1]); return; }
        for(String path:args) fixture(path);
        byte[] der=hex("3006020101020101");
        check(Arrays.equals(der,IdentityFormat.p1363ToDer(IdentityFormat.derToP1363(der))));
        for(String malformed:new String[]{"", "3006020100020101", "3006020180020101", "300702020001020101",
                "3007020101020101", "300602010102010100", "308106020101020101", "3006020101020100"}) {
            rejects(()->IdentityFormat.derToP1363(hex(malformed)));
        }
        rejects(()->IdentityFormat.p1363ToDer(new byte[63]));
        rejects(()->IdentityFormat.p1363ToDer(new byte[64]));
        byte[] outOfRange=new byte[64];
        System.arraycopy(hex("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),0,outOfRange,0,32);
        outOfRange[63]=1;
        rejects(()->IdentityFormat.p1363ToDer(outOfRange));
        rejects(()->IdentityFormat.publicIdentity(key("secp384r1").getPublic()));
        KeyPair key=key("secp256r1");
        byte[] publicKey=IdentityFormat.publicIdentity(key.getPublic());
        byte[] message="Public synthetic message".getBytes(StandardCharsets.US_ASCII);
        Signature signer=Signature.getInstance("SHA256withECDSA");
        signer.initSign(key.getPrivate());
        signer.update(MessageDigest.getInstance("SHA-256").digest(IdentityFormat.preimage(IdentityFormat.Domain.Registry,message)));
        byte[] doubled=IdentityFormat.derToP1363(signer.sign());
        check(!IdentityFormat.verify(publicKey,IdentityFormat.Domain.Registry,message,doubled));
        byte[] invalid=new byte[65]; invalid[0]=4;
        check(!IdentityFormat.verify(invalid,IdentityFormat.Domain.Registry,message,doubled));
        // RFC 6979 A.2.5 public point + signature only; raw SHA256("sample").
        byte[] point=hex("0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299");
        byte[] signature=hex("efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8");
        java.security.spec.ECPoint xy=new java.security.spec.ECPoint(new java.math.BigInteger(1,Arrays.copyOfRange(point,1,33)),new java.math.BigInteger(1,Arrays.copyOfRange(point,33,65)));
        Signature verifier=Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(new java.security.spec.ECPublicKeySpec(xy,IdentityFormat.parameters())));
        verifier.update("sample".getBytes(StandardCharsets.US_ASCII));
        check(verifier.verify(IdentityFormat.p1363ToDer(signature)));
        System.out.println("HOST-ONLY JCA: "+checks+" checks PASS; NOT ANDROID DEVICE evidence");
    }
}
