package dev.kaloyan.arthur.security;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;

/** Encoding only. EC arithmetic and signature verification belong to the JCA provider. */
public final class IdentityFormat {
    private IdentityFormat() {}
    public enum Domain {
        Registry("arthur-registry-p256-v1"),
        EnrollmentReceipt("arthur-enrollment-receipt-v1"),
        OriginalEvent("arthur-original-envelope-v1"),
        SessionReceipt("arthur-session-receipt-v1");
        private final byte[] prefix;
        Domain(String prefix) { this.prefix = prefix.getBytes(StandardCharsets.US_ASCII); }
    }
    static GeneralSecurityException invalid() {
        return new GeneralSecurityException("identity_invalid");
    }
    // CNG signs SHA256(preimage). SHA256withECDSA receives this PREIMAGE,
    // never its digest: domain || NUL || u64-big-endian(length) || message.
    public static byte[] preimage(Domain domain, byte[] message) throws GeneralSecurityException {
        if (domain == null || message == null || message.length > 1024 * 1024) throw invalid();
        return ByteBuffer.allocate(domain.prefix.length + 9 + message.length)
            .put(domain.prefix).put((byte) 0).putLong(message.length).put(message).array();
    }
    static ECParameterSpec parameters() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }
    private static void scalar(byte[] bytes, int offset) throws GeneralSecurityException {
        BigInteger scalar = new BigInteger(1, Arrays.copyOfRange(bytes, offset, offset + 32));
        if (scalar.signum() == 0 || scalar.compareTo(parameters().getOrder()) >= 0) throw invalid();
    }
    public static byte[] derToP1363(byte[] der) throws GeneralSecurityException {
        if (der == null || der.length < 8 || der.length > 72 || der[0] != 0x30
                || (der[1] & 255) != der.length - 2) throw invalid();
        byte[] result = new byte[64];
        int position = 2;
        for (int part = 0; part < 2; part++) {
            if (position + 2 > der.length || der[position++] != 2) throw invalid();
            int length = der[position++] & 255;
            if (length < 1 || length > 33 || position + length > der.length
                    || (der[position] & 128) != 0) throw invalid();
            if (der[position] == 0) {
                if (length == 1 || (der[position + 1] & 128) == 0) throw invalid();
                position++;
                length--;
            }
            if (length > 32) throw invalid();
            System.arraycopy(der, position, result, part * 32 + 32 - length, length);
            position += length;
            scalar(result, part * 32);
        }
        if (position != der.length) throw invalid();
        return result;
    }
    public static byte[] p1363ToDer(byte[] signature) throws GeneralSecurityException {
        if (signature == null || signature.length != 64) throw invalid();
        scalar(signature, 0);
        scalar(signature, 32);
        byte[][] integers = new byte[2][];
        for (int part = 0; part < 2; part++) {
            int start = part * 32;
            int end = start + 32;
            while (start < end - 1 && signature[start] == 0) start++;
            int padding = (signature[start] & 128) == 0 ? 0 : 1;
            integers[part] = new byte[end - start + padding];
            System.arraycopy(signature, start, integers[part], padding, end - start);
        }
        ByteBuffer der = ByteBuffer.allocate(6 + integers[0].length + integers[1].length);
        der.put((byte) 0x30).put((byte) (der.capacity() - 2));
        for (byte[] integer : integers) der.put((byte) 2).put((byte) integer.length).put(integer);
        return der.array();
    }
    public static byte[] publicIdentity(PublicKey key) throws GeneralSecurityException {
        if (!(key instanceof ECPublicKey)) throw invalid();
        ECPublicKey ec = (ECPublicKey) key;
        ECParameterSpec actual = ec.getParams();
        ECParameterSpec expected = parameters();
        if (!actual.getCurve().equals(expected.getCurve()) || !actual.getGenerator().equals(expected.getGenerator())
                || !actual.getOrder().equals(expected.getOrder()) || actual.getCofactor() != 1) throw invalid();
        byte[] result = new byte[65];
        result[0] = 4;
        coordinate(ec.getW().getAffineX(), result, 1);
        coordinate(ec.getW().getAffineY(), result, 33);
        return result;
    }
    private static void coordinate(BigInteger value, byte[] output, int offset) throws GeneralSecurityException {
        BigInteger prime = ((ECFieldFp) parameters().getCurve().getField()).getP();
        if (value.signum() < 0 || value.compareTo(prime) >= 0) throw invalid();
        byte[] bytes = value.toByteArray();
        int skip = bytes.length == 33 && bytes[0] == 0 ? 1 : 0;
        if (bytes.length - skip > 32) throw invalid();
        System.arraycopy(bytes, skip, output, offset + 32 - (bytes.length - skip), bytes.length - skip);
    }
    static PublicKey publicKey(byte[] sec1) throws GeneralSecurityException {
        if (sec1 == null || sec1.length != 65 || sec1[0] != 4) throw invalid();
        ECPoint point = new ECPoint(new BigInteger(1, Arrays.copyOfRange(sec1, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(sec1, 33, 65)));
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, parameters()));
        if (!Arrays.equals(sec1, publicIdentity(key))) throw invalid();
        return key;
    }
    public static void validatePublic(byte[] sec1) throws GeneralSecurityException {
        // Ask the platform to validate the point through ECDH, including providers
        // that defer on-curve checks until an operation. No custom EC arithmetic.
        PublicKey peer = publicKey(sec1);
        java.security.KeyPairGenerator generator = java.security.KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        javax.crypto.KeyAgreement agreement = javax.crypto.KeyAgreement.getInstance("ECDH");
        agreement.init(generator.generateKeyPair().getPrivate());
        agreement.doPhase(peer, true);
        byte[] transientSecret = agreement.generateSecret();
        Arrays.fill(transientSecret, (byte) 0);
    }
    public static boolean verify(byte[] sec1, Domain domain, byte[] message, byte[] p1363) {
        try {
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(publicKey(sec1));
            verifier.update(preimage(domain, message));
            // The platform performs point/on-curve validation during verification.
            return verifier.verify(p1363ToDer(p1363));
        } catch (GeneralSecurityException | IllegalArgumentException exception) {
            return false;
        }
    }
}
