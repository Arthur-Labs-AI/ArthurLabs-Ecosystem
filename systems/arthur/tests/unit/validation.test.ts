import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { parseModeChange, parseTurnRequest } from "../../src/core/conversation/validation";
import { isArthurMode, parseArthurMode } from "../../src/core/modes/mode";

test("parseTurnRequest accepts a valid request", () => {
  const req = parseTurnRequest(
    { mode: "personal", message: "hi", client_request_id: "r1", metadata: { client_type: "cli" } },
    8000,
  );
  assert.equal(req.mode, "personal");
  assert.equal(req.message, "hi");
  assert.equal(req.metadata?.client_type, "cli");
});

test("parseTurnRequest rejects invalid mode", () => {
  assert.throws(
    () => parseTurnRequest({ mode: "agency", message: "hi", client_request_id: "r1" }, 8000),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
  );
});

test("parseTurnRequest rejects empty message and oversized message", () => {
  assert.throws(() => parseTurnRequest({ mode: "personal", message: "", client_request_id: "r1" }, 8000), ArthurError);
  assert.throws(
    () => parseTurnRequest({ mode: "personal", message: "x".repeat(9000), client_request_id: "r1" }, 8000),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
  );
});

test("parseTurnRequest rejects missing client_request_id", () => {
  assert.throws(() => parseTurnRequest({ mode: "personal", message: "hi" }, 8000), ArthurError);
});

test("parseModeChange validates mode", () => {
  assert.deepEqual(parseModeChange({ mode: "business" }), { mode: "business" });
  assert.throws(() => parseModeChange({ mode: "nope" }), ArthurError);
});

test("mode helpers validate and parse", () => {
  assert.equal(isArthurMode("personal"), true);
  assert.equal(isArthurMode("business"), true);
  assert.equal(isArthurMode("other"), false);
  assert.equal(parseArthurMode("business"), "business");
  assert.throws(() => parseArthurMode("other"));
});
