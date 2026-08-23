import { test } from "node:test";
import assert from "node:assert/strict";

import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { ApprovalToken } from "../../src/tools/contracts";
import { argumentsDigest, signApprovalToken, verifyApprovalToken } from "../../src/tools/permissions";

const SECRET = "test-signing-secret";

function makeToken(): ApprovalToken {
  const signable = {
    approval_id: "ap-1",
    tool_name: "harness.create_job",
    session_id: "s-1",
    turn_id: "t-1",
    arguments_hash: argumentsDigest({ kind: "deploy" }),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  return { ...signable, signature: signApprovalToken(signable, SECRET) };
}

test("sign + verify round-trips and detects tampering", () => {
  const token = makeToken();
  assert.equal(verifyApprovalToken(token, SECRET), true);
  assert.equal(verifyApprovalToken({ ...token, tool_name: "other.tool" }, SECRET), false);
  assert.equal(verifyApprovalToken({ ...token, arguments_hash: argumentsDigest({ kind: "other" }) }, SECRET), false);
  assert.equal(verifyApprovalToken({ ...token, signature: "" }, SECRET), false);
  assert.equal(verifyApprovalToken(token, "wrong-secret"), false);
});

test("harness stub verifies signed tokens and rejects forgeries", async () => {
  const stub = new HarnessStubAdapter({ verificationSecret: SECRET });
  const signed = makeToken();
  const job = await stub.createJob({ kind: "deploy" }, signed);
  assert.ok(job.id);

  // Same approval id de-duplicates (no second job).
  const again = await stub.createJob({ kind: "deploy" }, signed);
  assert.equal(again.id, job.id);

  // Forged signature is rejected.
  const forged = { ...makeToken(), signature: "0".repeat(64) };
  await assert.rejects(() => stub.createJob({ kind: "deploy" }, forged), /signature is invalid/);

  // Token authorizing a different spec is rejected.
  await assert.rejects(() => stub.createJob({ kind: "destroy" }, signed), /does not authorize this exact job spec/);

  // Adapter without a verification secret fails closed.
  const unconfigured = new HarnessStubAdapter();
  await assert.rejects(() => unconfigured.createJob({ kind: "deploy" }, signed), /not configured/);
});

test("harness approval id is a restart-stable external idempotency key", async () => {
  const token = makeToken();
  const first = new HarnessStubAdapter({ verificationSecret: SECRET });
  const second = new HarnessStubAdapter({ verificationSecret: SECRET });
  const a = await first.createJob({ kind: "deploy" }, token);
  const b = await second.createJob({ kind: "deploy" }, token);
  assert.equal(a.id, b.id);
});
