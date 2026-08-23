import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ArthurError,
  approvalInvalid,
  invalidRequest,
  sessionNotFound,
  sanitizePublicError,
  toArthurError,
} from "../../src/core/errors/errors";
import { ModelGateway } from "../../src/models/gateway";
import { SecretSanitizer } from "../../src/security/sanitize";
import { FakeProvider } from "../../src/models/providers/fake";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../src/models/contracts";

test("typed error carries stable code and http status", () => {
  const err = sessionNotFound("abc");
  assert.equal(err.code, "SESSION_NOT_FOUND");
  assert.equal(err.httpStatus, 404);
  assert.deepEqual(err.toJSON(), {
    error: { code: "SESSION_NOT_FOUND", message: "Session not found: abc", details: { session_id: "abc" } },
  });
});



test("public error boundary sanitizes messages identifiers and nested details", () => {
  const configured = "configured-credential-value";
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const err = new ArthurError("INVALID_REQUEST", `bad ${configured} ${github}`, {
    exposeDetails: true,
    details: {
      session_id: configured,
      nested: { password: "hunter2", request_id: github, input_tokens: 42 },
    },
  });
  err.stack = `stack with ${configured}`;
  const publicError = sanitizePublicError(err, new SecretSanitizer([configured]));
  const serialized = JSON.stringify(publicError);
  assert.equal(publicError.body.error.code, "INVALID_REQUEST");
  assert.ok(!serialized.includes(configured));
  assert.ok(!serialized.includes(github));
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("stack with"));
  assert.equal((publicError.body.error.details?.nested as { input_tokens: number }).input_tokens, 42);
});

test("toArthurError maps unknown errors to INTERNAL_ERROR without leaking cause", () => {
  const mapped = toArthurError(new Error("boom"));
  assert.equal(mapped.code, "INTERNAL_ERROR");
  assert.equal(mapped.httpStatus, 500);
  assert.deepEqual(mapped.toJSON(), { error: { code: "INTERNAL_ERROR", message: "Unexpected internal failure" } });
});

test("toArthurError preserves ArthurError instances", () => {
  const original = invalidRequest("bad");
  assert.equal(toArthurError(original), original);
});

test("gateway maps provider errors to typed model errors", async () => {
  const gateway = new ModelGateway(new FakeProvider({ responder: () => { throw new ProviderTimeoutError(); } }));
  await assert.rejects(
    () => gateway.generate({} as never),
    (err: unknown) => err instanceof ArthurError && err.code === "MODEL_TIMEOUT",
  );
});

test("gateway maps each provider error type", async () => {
  const cases: Array<{ err: Error; code: string }> = [
    { err: new ProviderAuthError(), code: "MODEL_UNAVAILABLE" },
    { err: new ProviderUnavailableError(), code: "MODEL_UNAVAILABLE" },
    { err: new ProviderBadResponseError(), code: "MODEL_BAD_RESPONSE" },
    { err: new Error("network"), code: "MODEL_UNAVAILABLE" },
  ];
  for (const c of cases) {
    const gateway = new ModelGateway(new FakeProvider({ responder: () => { throw c.err; } }));
    await assert.rejects(
      () => gateway.generate({} as never),
      (err: unknown) => err instanceof ArthurError && err.code === c.code,
    );
  }
});

test("approvalInvalid carries approval code", () => {
  const err = approvalInvalid("Approval expired");
  assert.equal(err.code, "APPROVAL_INVALID");
  assert.equal(err.httpStatus, 400);
});
