/**
 * Harness stub adapter (spec section 11; audit BLOCKER 2, MEDIUM 7).
 *
 * Demonstrates the approval boundary without importing any real Harness
 * internals. createJob refuses to run without a valid, unexpired, and
 * HMAC-signed approval token that (a) authorizes exactly harness.create_job
 * and (b) whose argument digest matches the exact job spec. It also
 * de-duplicates by approval id so a duplicate invocation can never create a
 * second job. Jobs are held in memory only (Phase 1 has no real execution).
 */

import { createHash } from "node:crypto";

import { ApprovalToken, HarnessAdapter, HarnessJob, HarnessJobSpec, HarnessStatus } from "../contracts";
import { argumentsDigest, verifyApprovalToken } from "../permissions";

export interface HarnessStubOptions {
  /** Secret used to verify approval-token HMAC signatures (fail closed). */
  verificationSecret?: string;
}

export class HarnessStubAdapter implements HarnessAdapter {
  private readonly jobs = new Map<string, HarnessJob>();
  private readonly jobByApproval = new Map<string, HarnessJob>();
  private readonly verificationSecret?: string;

  constructor(opts: HarnessStubOptions = {}) {
    this.verificationSecret = opts.verificationSecret;
  }

  async getStatus(): Promise<HarnessStatus> {
    return { status: "online", version: "0.0.0-stub", jobs_active: this.jobs.size };
  }

  async createJob(spec: HarnessJobSpec, approval: ApprovalToken): Promise<HarnessJob> {
    this.assertApproval(approval);
    const specDigest = argumentsDigest({ kind: spec.kind, payload: spec.payload });
    if (specDigest !== approval.arguments_hash) {
      throw new Error("approval token does not authorize this exact job spec");
    }

    // Idempotency: one approval id may only ever produce one job.
    const existing = this.jobByApproval.get(approval.approval_id);
    if (existing) {
      return existing;
    }

    // Deterministic operation identity survives adapter/process restart. The
    // approval id is the durable external idempotency key.
    const id = `job-${createHash("sha256").update(approval.approval_id).digest("hex").slice(0, 32)}`;
    const job: HarnessJob = { id, status: "queued", spec };
    this.jobs.set(id, job);
    this.jobByApproval.set(approval.approval_id, job);
    return job;
  }

  async getJob(jobId: string): Promise<HarnessJob> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Harness job not found: ${jobId}`);
    }
    return job;
  }

  async cancelJob(jobId: string, approval: ApprovalToken): Promise<void> {
    this.assertApproval(approval);
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Harness job not found: ${jobId}`);
    }
    job.status = "cancelled";
  }

  private assertApproval(approval: ApprovalToken): void {
    if (!approval) {
      throw new Error("harness.create_job requires an explicit approval token");
    }
    if (!this.verificationSecret) {
      throw new Error("harness adapter is not configured to verify approval tokens");
    }
    if (!verifyApprovalToken(approval, this.verificationSecret)) {
      throw new Error("approval token signature is invalid");
    }
    if (approval.tool_name !== "harness.create_job") {
      throw new Error("approval token does not authorize harness.create_job");
    }
    if (typeof approval.approval_id !== "string" || approval.approval_id.length === 0) {
      throw new Error("approval token is missing an approval id");
    }
    if (typeof approval.arguments_hash !== "string" || !/^[0-9a-f]{64}$/.test(approval.arguments_hash)) {
      throw new Error("approval token has an invalid argument digest");
    }
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      throw new Error("approval token has expired");
    }
    if (new Date(approval.issued_at).getTime() > Date.now() + 60000) {
      throw new Error("approval token was issued in the future");
    }
  }
}
