/**
 * Persistent approval signing identity (SC-02 section 30).
 *
 * Production must not mint a fresh random key on every process start:
 * pending approvals would silently die across restarts. The file-backed
 * provider below persists the Ed25519 keypair with owner-restricted
 * permissions on POSIX; tests inject an ephemeral keypair instead.
 *
 * The private key never leaves this provider: it is never logged, never sent
 * to the model, never handed to an executor, and never stored in the session DB.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { generateApprovalKeypair, type ApprovalKeypair } from "./approval_signer";

export interface ApprovalKeyProvider {
  current(): ApprovalKeypair;
}

export class EphemeralApprovalKeyProvider implements ApprovalKeyProvider {
  private readonly keypair: ApprovalKeypair;

  constructor(keypair?: ApprovalKeypair) {
    this.keypair = keypair ?? generateApprovalKeypair();
  }

  current(): ApprovalKeypair {
    return this.keypair;
  }
}

export interface FileApprovalKeyProviderOptions {
  path: string;
}

export class FileApprovalKeyProvider implements ApprovalKeyProvider {
  private readonly keypair: ApprovalKeypair;

  constructor(options: FileApprovalKeyProviderOptions) {
    const target = resolve(options.path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const raw = readFileSync(target, "utf8");
      const parsed = JSON.parse(raw) as ApprovalKeypair;
      if (typeof parsed.kid !== "string" || typeof parsed.privateKeyPem !== "string" || typeof parsed.publicKeyPem !== "string") {
        throw new Error("approval key file is malformed");
      }
      this.keypair = parsed;
    } else {
      this.keypair = generateApprovalKeypair();
      writeFileSync(target, JSON.stringify(this.keypair, null, 2), { encoding: "utf8", mode: 0o600 });
    }
    try {
      chmodSync(target, 0o600);
    } catch {
      // Non-POSIX platforms (Windows ACLs) have no chmod 600 equivalent here;
      // the file content itself stays a private key and is never exposed.
    }
    if (process.platform !== "win32") {
      try {
        const mode = statSync(target).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new Error("approval key file must be owner-accessible only (mode 600)");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("owner-accessible")) throw err;
      }
    }
  }

  current(): ApprovalKeypair {
    return this.keypair;
  }
}
