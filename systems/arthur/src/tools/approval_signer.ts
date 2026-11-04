/**
 * ApprovalSigner / ApprovalVerifier + persistent key provider (SC-02 sections 27-30).
 *
 * Ed25519 replaces the initial HMAC stub as the frozen approval capability
 * contract: the verifier holds only public keys, so a future remote executor
 * can verify but never mint approval evidence. Node.js provides native Ed25519
 * key generation/sign/verify - no external crypto dependency.
 *
 * Wire format: the signed payload is the canonical JSON of the capability
 * envelope WITHOUT the signature field; `kid` selects the trusted public key.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import { canonicalizeJson } from "./canonical_json";
import type { ApprovalIntentV2 } from "./approval_intent";
import type { ToolRisk } from "./contracts";

export interface ApprovalCapabilityV2Unsigned {
  v: 2;
  alg: "Ed25519";
  kid: string;
  approval_id: string;
  tool_call_id: string;
  session_id: string;
  turn_id: string;
  mode: string;
  tool_name: string;
  tool_version: string;
  tool_definition_hash: string;
  risk_level: ToolRisk;
  arguments_hash: string;
  presentation_hash: string;
  authorization_digest: string;
  issued_at: string;
  expires_at: string;
}

export interface ApprovalCapabilityV2 extends ApprovalCapabilityV2Unsigned {
  signature: string;
}

export interface VerifiedApproval extends ApprovalCapabilityV2Unsigned {}

export function capabilityPayload(capability: ApprovalCapabilityV2Unsigned): string {
  const { ...fields } = capability;
  return canonicalizeJson(fields as unknown as Record<string, unknown>);
}

export function kidForPublicKeyDer(publicKeyDer: Buffer): string {
  // NOTE: raw SPKI DER shares a fixed ASN.1 prefix across all Ed25519 keys, so
  // truncating the DER itself would collide. Hash first, then truncate.
  return createHash("sha256").update(publicKeyDer).digest("base64url").slice(0, 16);
}

export interface ApprovalKeypair {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateApprovalKeypair(): ApprovalKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return { kid: kidForPublicKeyDer(der), privateKeyPem: privateKey as string, publicKeyPem: publicKey as string };
}

export class ApprovalSigner {
  private kid: string;
  private privateKeyPem: string;

  constructor(keypair: ApprovalKeypair) {
    this.kid = keypair.kid;
    this.privateKeyPem = keypair.privateKeyPem;
  }

  get keyId(): string {
    return this.kid;
  }

  rotate(keypair: ApprovalKeypair): void {
    this.kid = keypair.kid;
    this.privateKeyPem = keypair.privateKeyPem;
  }

  sign(intent: ApprovalIntentV2, authorizationDigest: string): ApprovalCapabilityV2 {
    const unsigned: ApprovalCapabilityV2Unsigned = {
      v: 2,
      alg: "Ed25519",
      kid: this.kid,
      approval_id: intent.approval_id,
      tool_call_id: intent.tool_call_id,
      session_id: intent.session_id,
      turn_id: intent.turn_id,
      mode: intent.mode,
      tool_name: intent.tool_name,
      tool_version: intent.tool_version,
      tool_definition_hash: intent.tool_definition_hash,
      risk_level: intent.risk_level,
      arguments_hash: intent.arguments_hash,
      presentation_hash: intent.presentation_hash,
      authorization_digest: authorizationDigest,
      issued_at: intent.created_at,
      expires_at: intent.expires_at,
    };
    const payload = capabilityPayload(unsigned);
    const key = createPrivateKey(this.privateKeyPem);
    const signature = sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
    return { ...unsigned, signature };
  }
}

export class ApprovalVerifier {
  private readonly ring = new Map<string, string>();

  constructor(trusted: ApprovalKeypair[]) {
    for (const key of trusted) this.ring.set(key.kid, key.publicKeyPem);
  }

  addTrusted(keypair: Pick<ApprovalKeypair, "kid" | "publicKeyPem">): void {
    this.ring.set(keypair.kid, keypair.publicKeyPem);
  }

  removeTrusted(kid: string): void {
    this.ring.delete(kid);
  }

  trustedKids(): string[] {
    return [...this.ring.keys()];
  }

  verify(capability: ApprovalCapabilityV2): VerifiedApproval {
    if (capability.v !== 2) throw new Error("unsupported approval capability version");
    if (capability.alg !== "Ed25519") throw new Error("unsupported approval capability algorithm");
    const publicKeyPem = this.ring.get(capability.kid);
    if (!publicKeyPem) throw new Error("untrusted approval signing key");
    const { signature, ...unsigned } = capability;
    if (typeof signature !== "string" || signature.length === 0) throw new Error("approval capability is missing a signature");
    const payload = capabilityPayload(unsigned as ApprovalCapabilityV2Unsigned);
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("approval capability signature is malformed");
    }
    if (signatureBytes.length === 0) throw new Error("approval capability signature is malformed");
    const ok = verify(null, Buffer.from(payload, "utf8"), createPublicKey(publicKeyPem), signatureBytes);
    if (!ok) throw new Error("approval capability signature is invalid");
    return { ...(unsigned as ApprovalCapabilityV2Unsigned) };
  }
}
