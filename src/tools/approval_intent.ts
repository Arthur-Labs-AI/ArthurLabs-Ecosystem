/**
 * Approval Binding v2 intent + tool definition fingerprint (SC-02 sections 7-14, 25).
 *
 * An approval binds AT MINIMUM: binding version, approval/tool-call/session/
 * turn ids, mode, tool name + version + definition fingerprint, risk level,
 * canonical argument digest, presentation digest, and expiry. The
 * `authorization_digest` is the single cryptographic identity of the whole
 * authorized operation: SHA-256 over the JCS-canonical ApprovalIntentV2.
 */

import type { ArthurMode } from "../core/modes/mode";
import type { ToolRisk } from "./contracts";
import type { ToolDefinition } from "./contracts";
import { canonicalizeJson, sha256Canonical } from "./canonical_json";

export const APPROVAL_BINDING_VERSION = 2;

export interface ApprovalIntentV2 {
  binding_version: 2;
  approval_id: string;
  tool_call_id: string;
  session_id: string;
  turn_id: string;
  mode: ArthurMode;
  tool_name: string;
  tool_version: string;
  tool_definition_hash: string;
  risk_level: ToolRisk;
  arguments_hash: string;
  presentation_hash: string;
  created_at: string;
  expires_at: string;
}

export interface ApprovalPresentationDetail {
  label: string;
  value: string;
}

export interface ApprovalPresentation {
  action: string;
  details: ApprovalPresentationDetail[];
  warning?: string;
}

export type ApprovalPresenter = (args: Record<string, unknown>) => ApprovalPresentation;

/** Security-relevant manifest snapshot fingerprinted at registration. */
export function toolDefinitionFingerprintSource(definition: ToolDefinition): Record<string, unknown> {
  return {
    allowed_modes: [...definition.allowed_modes].sort(),
    description: definition.description,
    input_schema: definition.input_schema,
    name: definition.name,
    output_schema: definition.output_schema ?? null,
    risk: definition.risk,
    version: definition.version,
  };
}

/** SHA-256 over the canonical manifest snapshot (SC-02 section 12). */
export function toolDefinitionHash(definition: ToolDefinition): string {
  return sha256Canonical(toolDefinitionFingerprintSource(definition));
}

/** Canonical argument digest: hash of exactly what the executor will receive. */
export function approvalArgumentsHash(executionArgsSnapshot: Record<string, unknown>): string {
  return sha256Canonical(executionArgsSnapshot);
}

/** Digest of the exact presentation the user saw (SC-02 section 19). */
export function presentationHash(presentation: ApprovalPresentation): string {
  return sha256Canonical(presentation as unknown as Record<string, unknown>);
}

/** Single cryptographic identity of the whole authorized operation. */
export function authorizationDigest(intent: ApprovalIntentV2): string {
  return sha256Canonical(intent as unknown as Record<string, unknown>);
}

export function canonicalIntentJson(intent: ApprovalIntentV2): string {
  return canonicalizeJson(intent as unknown as Record<string, unknown>);
}
