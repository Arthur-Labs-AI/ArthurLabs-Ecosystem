/**
 * Permission + approval skeleton (spec section 12; audit BLOCKER 2, MEDIUM 7).
 *
 * Maps a tool's risk and allowed modes to an execution decision. Approval
 * binding (canonical argument digest) lives here so a generic "yes" can never
 * authorize a different command.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { ArthurMode } from "../core/modes/mode";
import { ApprovalToken, PermissionDecision, ToolDefinition } from "./contracts";

export class PermissionService {
  evaluate(definition: ToolDefinition, mode: ArthurMode): PermissionDecision {
    if (!definition.allowed_modes.includes(mode)) {
      return "reject";
    }
    switch (definition.risk) {
      case "read":
      case "low_write":
        return "auto";
      case "approval_required":
        return "approval";
      case "high_risk":
        // Phase 1: high-risk actions are rejected by default.
        return "reject";
      default:
        return "reject";
    }
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical, key-sorted JSON used to bind an approval to exactly one action.
 * Two approvals only match when tool name AND normalized arguments match.
 */
export function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(args));
}

/**
 * Cryptographic digest of the canonical arguments. Persisted on the approval
 * and verified (not compared by string equality) at execution time so an
 * approval can never authorize a different argument set than the one shown.
 */
export function argumentsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeArgs(args)).digest("hex");
}

// ---- Approval token integrity (audit MEDIUM 7 / BLOCKER 2) --------------
//
// The orchestrator signs each approval token with an app-level secret. The
// harness adapter verifies the signature before trusting the token, so a
// caller that forges an approved:true token-shaped object cannot authorize an
// action without the secret. The signature covers every binding field.

export type SignableApprovalToken = Omit<ApprovalToken, "signature">;

function approvalTokenPayload(token: SignableApprovalToken): string {
  return JSON.stringify([
    token.approval_id,
    token.tool_name,
    token.session_id,
    token.turn_id,
    token.arguments_hash,
    token.issued_at,
    token.expires_at,
  ]);
}

/** Produce the HMAC-SHA256 signature for an approval token binding fields. */
export function signApprovalToken(token: SignableApprovalToken, secret: string): string {
  return createHmac("sha256", secret).update(approvalTokenPayload(token)).digest("hex");
}

/** Constant-time verification that an approval token was signed with `secret`. */
export function verifyApprovalToken(token: ApprovalToken, secret: string): boolean {
  if (typeof token.signature !== "string" || token.signature.length === 0) {
    return false;
  }
  const expected = signApprovalToken(
    {
      approval_id: token.approval_id,
      tool_name: token.tool_name,
      session_id: token.session_id,
      turn_id: token.turn_id,
      arguments_hash: token.arguments_hash,
      issued_at: token.issued_at,
      expires_at: token.expires_at,
    },
    secret,
  );
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token.signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
