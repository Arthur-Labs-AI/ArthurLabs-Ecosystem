import { describe, expect, it, vi } from "vitest";
import { EVOLUTION_BLOCKERS, isEvolutionStatus, isRevisionProposal, isUnresolvedClaim } from "@arthur/contracts";
import { EvolutionError } from "./arthur-client";
import { createArthurClient } from "./index";
import type { Invoke } from "./tauri-ipc";

const androidEnv = { isTauri: true, tauriPlatform: "android" };
const desktopEnv = { isTauri: true, tauriPlatform: "linux" };

const SECRET = "ts-SECRET-must-never-come-back-71";
const provider = (consented: boolean, has: boolean, version: string) => ({ provider: "TypeSafe", consented, hasCredential: has, disclosureVersion: version, disclosure: ["a plain sentence"] });
const status = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  mode: "review_first",
  ready: false,
  active: false,
  blockers: [...EVOLUTION_BLOCKERS],
  typesafe: provider(false, false, "typesafe-optin-2026-10-v1"),
  synthesis: provider(false, false, "openai-synthesis-2026-10-v1"),
  verification: provider(false, false, "openai-verification-samefamily-2026-10-v1"),
  sameFamilyVerification: true,
  ...over,
});
const proposal = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  state: "open",
  change: "additive",
  objectId: "o1",
  projectId: "inbox",
  projectArchived: false,
  baseRevisionId: "r1",
  current: { revisionId: "r1", kind: "idea", title: "Mobile", body: "Arthur is a mobile app.", origin: "initial" },
  proposed: { kind: "idea", title: "Mobile", body: "Arthur is a mobile and desktop app." },
  diff: { oldRevisionId: "r1", newRevisionId: "proposed", kind: { changed: false, from: "idea", to: "idea" }, title: { changed: false, segments: [{ op: "equal", text: "Mobile" }] }, body: { changed: true, segments: [{ op: "equal", text: "Arthur is a mobile " }, { op: "insert", text: "and desktop " }, { op: "equal", text: "app." }] } },
  verification: { mode: "same_family_review", status: "passed", synthesisModel: "gpt-6-luna-20260922", verifierModel: "gpt-6-luna" },
  claim: { pendingId: "pc1", captureId: "c2", ordinal: 0, kind: "idea", title: "Desktop", body: "It will also support desktop.", sourceStart: 0, sourceEnd: 5, reasons: ["review_required"], state: "open" },
  evidence: [{ role: "claim", captureId: "c2", start: 0, end: 5 }],
  stale: false,
  blocked: null,
  userEdited: false,
  finalBody: null,
  resultRevisionId: null,
  createdAt: "2026-10-09T10:00:00Z",
  reviewedAt: null,
  ...over,
});
const claim = { claim: proposal().claim, projectId: "inbox", projectArchived: false, dueAt: null, createdAt: "2026-10-09T10:00:00Z", candidates: [{ objectId: "o1", title: "Mobile", currentRevisionId: "r1" }], proposalId: null, proposalState: null, reframing: false };

describe.each([
  ["mobile", androidEnv],
  ["desktop", desktopEnv],
] as const)("Thought Evolution over IPC (%s client)", (_kind, env) => {
  it("calls exactly the documented native commands with exactly the documented arguments", async () => {
    const call = vi.fn<Invoke>().mockImplementation((command) => {
      if (command.includes("status") || ["set_evolution_enabled", "set_evolution_consent", "set_typesafe_credential", "delete_typesafe_credential"].includes(command)) return Promise.resolve(status());
      if (command === "list_revision_proposals") return Promise.resolve([proposal()]);
      if (command === "get_revision_proposal") return Promise.resolve(proposal());
      if (command === "review_revision_proposal") return Promise.resolve({ proposal: proposal({ state: "approved" , finalBody: "x", resultRevisionId: "r2", reviewedAt: "2026-10-09T10:05:00Z" }), applied: true, revisionId: "r2", createdObjectId: null });
      if (command === "list_unresolved_claims") return Promise.resolve([claim]);
      if (command === "resolve_unresolved_claim") return Promise.resolve({ claimState: "deferred", createdObjectId: null, applied: true });
      if (command === "list_object_approvals") return Promise.resolve([{ revisionId: "r2", proposalId: "p1", userEdited: false, approvedAt: "2026-10-09T10:05:00Z", verificationMode: "same_family_review", synthesisModel: "gpt-6-luna" }]);
      return Promise.resolve({ id: "r3", objectId: "o1", kind: "idea", title: "T", body: "B", createdAt: "2026-10-09T10:06:00Z", origin: "merge", parentRevisionIds: ["r1", "r2"] });
    });
    const client = createArthurClient(env, call);

    await client.getEvolutionStatus();
    await client.setEvolutionEnabled(true);
    await client.setEvolutionConsent("verification", true, "openai-verification-samefamily-2026-10-v1");
    await client.setEvolutionConsent("typesafe", false);
    await client.setTypesafeCredential(SECRET);
    await client.deleteTypesafeCredential();
    await client.listRevisionProposals({ projectId: "inbox", states: ["open", "deferred"] });
    await client.listRevisionProposals();
    await client.getRevisionProposal("p1");
    // Extra fields a caller might try to add (a revision id to write, a project, model text) never reach the native layer.
    await client.reviewRevisionProposal({ proposalId: "p1", action: "approve", reviewedRevisionId: "r1", resultRevisionId: "evil", projectId: "evil", body: "evil" } as never);
    await client.reviewRevisionProposal({ proposalId: "p1", action: "edit_approve", editedBody: "my words", reviewedRevisionId: "r1" });
    await client.listUnresolvedClaims({ projectId: "inbox" });
    await client.resolveUnresolvedClaim({ pendingId: "pc1", action: "defer", dueAt: "2030-01-01T00:00:00Z" });
    await client.listObjectApprovals("o1");
    await client.restoreRevision("o1", "r1", "r2");

    expect(call.mock.calls).toEqual([
      ["get_evolution_status", undefined],
      ["set_evolution_enabled", { enabled: true }],
      ["set_evolution_consent", { kind: "verification", granted: true, disclosureVersion: "openai-verification-samefamily-2026-10-v1" }],
      ["set_evolution_consent", { kind: "typesafe", granted: false }],
      ["set_typesafe_credential", { secret: SECRET }],
      ["delete_typesafe_credential", undefined],
      ["list_revision_proposals", { projectId: "inbox", states: ["open", "deferred"] }],
      ["list_revision_proposals", undefined],
      ["get_revision_proposal", { proposalId: "p1" }],
      ["review_revision_proposal", { input: { proposalId: "p1", action: "approve", reviewedRevisionId: "r1" } }],
      ["review_revision_proposal", { input: { proposalId: "p1", action: "edit_approve", editedBody: "my words", reviewedRevisionId: "r1" } }],
      ["list_unresolved_claims", { projectId: "inbox" }],
      ["resolve_unresolved_claim", { input: { pendingId: "pc1", action: "defer", dueAt: "2030-01-01T00:00:00Z" } }],
      ["list_object_approvals", { objectId: "o1" }],
      ["restore_revision", { objectId: "o1", targetRevisionId: "r1", expectedCurrentRevisionId: "r2" }],
    ]);
  });

  it("maps native failures to EvolutionError with the code, the safe message and the revision that is current now", async () => {
    const call = vi.fn<Invoke>().mockRejectedValue({ code: "stale", message: "This idea changed after the suggestion was written.", currentRevisionId: "r9" });
    const client = createArthurClient(env, call);
    const failure = await client.reviewRevisionProposal({ proposalId: "p1", action: "approve", reviewedRevisionId: "r1" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(EvolutionError);
    expect(failure).toMatchObject({ code: "stale", currentRevisionId: "r9" });
    const notReady = createArthurClient(env, vi.fn<Invoke>().mockRejectedValue({ code: "not_ready", message: "Automatic Thought Evolution needs: typesafe_consent." }));
    await expect(notReady.setEvolutionEnabled(true)).rejects.toMatchObject({ code: "not_ready" });
    // anything that is not an evolution payload passes through untouched
    const other = createArthurClient(env, vi.fn<Invoke>().mockRejectedValue(new Error("boom")));
    await expect(other.getEvolutionStatus()).rejects.toThrow("boom");
  });

  it("refuses a malformed request before it reaches the native layer", async () => {
    const call = vi.fn<Invoke>();
    const client = createArthurClient(env, call);
    await expect(client.reviewRevisionProposal({ proposalId: "p1", action: "edit_approve", editedBody: "   ", reviewedRevisionId: "r1" })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.reviewRevisionProposal({ proposalId: "p1", action: "edit_approve", editedBody: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.reviewRevisionProposal({ proposalId: "p1", action: "approve" })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.reviewRevisionProposal({ proposalId: "", action: "reject" })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.reviewRevisionProposal({ proposalId: "p1", action: "edit_approve", editedBody: "x".repeat(2001), reviewedRevisionId: "r1" })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.setTypesafeCredential("   ")).rejects.toMatchObject({ code: "invalid_credential" });
    await expect(client.setEvolutionConsent("anything" as never, true, "v")).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a native answer that does not match the contract instead of passing it on", async () => {
    for (const [method, payload] of [
      ["getEvolutionStatus", { enabled: "yes" }],
      ["getEvolutionStatus", { ...status(), mode: "auto_apply" }],
      ["listRevisionProposals", [{ id: "p1" }]],
      ["listUnresolvedClaims", [{}]],
      ["listObjectApprovals", [{ revisionId: 1 }]],
    ] as const) {
      const client = createArthurClient(env, vi.fn<Invoke>().mockResolvedValue(payload));
      await expect((client[method] as (...args: never[]) => Promise<unknown>)()).rejects.toThrow(/invalid/i);
    }
    const noMode = createArthurClient(env, vi.fn<Invoke>().mockResolvedValue(proposal({ verification: { mode: "unknown", status: "passed", synthesisModel: "m", verifierModel: "m" } })));
    await expect(noMode.getRevisionProposal("p1")).rejects.toThrow(/invalid/i);
  });

  it("has no operation that reads a key back, applies text a model chose, or switches review off", () => {
    const client = createArthurClient(env, vi.fn<Invoke>());
    const names = Object.keys(client);
    expect(names.filter((name) => /Typesafe/i.test(name)).sort()).toEqual(["deleteTypesafeCredential", "setTypesafeCredential"]);
    expect(names.some((name) => /^get.*(Key|Secret|Credential)/.test(name))).toBe(false);
    expect(names.some((name) => /auto(matic)?(ally)?Appl|applyProposal|setMode|setApprovalMode/i.test(name))).toBe(false);
  });
});

describe("evolution contracts", () => {
  it("accept what the native layer sends and nothing else", () => {
    expect(isEvolutionStatus(status())).toBe(true);
    expect(isEvolutionStatus(status({ blockers: ["something_else"] }))).toBe(false);
    expect(isEvolutionStatus(status({ mode: "auto_apply" }))).toBe(false);
    expect(isRevisionProposal(proposal())).toBe(true);
    expect(isRevisionProposal(proposal({ current: null, diff: null, blocked: "object_missing", stale: true }))).toBe(true);
    expect(isRevisionProposal(proposal({ state: "unknown" }))).toBe(false);
    expect(isRevisionProposal(proposal({ blocked: "whatever" }))).toBe(false);
    expect(isUnresolvedClaim(claim)).toBe(true);
    expect(isUnresolvedClaim({ ...claim, candidates: [{ objectId: 1 }] })).toBe(false);
  });
});
