/**
 * SC-05 git tool pack (spec sections 3, 45-88, 140).
 *
 * Six read-only tools: git.repositories / git.status / git.diff / git.log /
 * git.branches / git.show. All risk=read, effects=none, max_attempts=1,
 * cooperative cancellation, no reconciliation. Schemas carry semantic
 * parameters only (repo_id + bounded filters): no argv, options, pathspecs,
 * executables, or physical paths ever reach the model.
 */

import { ArthurMode } from "../../core/modes/mode";
import type { LocalCapabilityHost } from "../local_host";
import type { ToolRegistry } from "../registry";
import type { GitDiffScope } from "../git/contracts";

const REPO_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" };
const REF_SCHEMA = { type: "string", minLength: 1, maxLength: 256 };
const GIT_PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 4096 };

function gitPolicy(attemptMs: number, totalMs: number): import("../execution_policy").ToolExecutionPolicy {
  return {
    effects: "none",
    attempt_timeout_ms: attemptMs,
    total_timeout_ms: totalMs,
    abort_grace_ms: 1000,
    cancellation: "cooperative",
    idempotency: "intrinsic",
    retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 },
    reconciliation: "none",
    result_persistence: "summary_only",
  };
}

export function registerGitPack(registry: ToolRegistry, host: LocalCapabilityHost): void {
  const git = host.git;
  if (!git) return;

  registry.register(
    {
      name: "git.repositories",
      version: "1.0.0",
      description: "List the trusted git repositories ARTHUR may inspect (id + label + availability only, no paths). Read-only.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          repositories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                available: { type: "boolean" },
              },
              required: ["id", "label", "available"],
              additionalProperties: false,
            },
          },
        },
        required: ["repositories"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(10000, 10000),
    },
    async (_args, ctx) => {
      const result = await git.listRepositories(ctx.mode);
      return { ok: true, summary: result.repositories.length + " git repositorie(s)", data: result };
    },
  );

  registry.register(
    {
      name: "git.status",
      version: "1.0.0",
      description: "Inspect the working-tree status of a trusted repository (branch, staged/unstaged/untracked/conflicted). Read-only.",
      input_schema: {
        type: "object",
        properties: { repo_id: REPO_ID_SCHEMA },
        required: ["repo_id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          branch: {
            type: "object",
            properties: {
              name: { type: ["string", "null"] },
              detached: { type: "boolean" },
              unborn: { type: "boolean" },
              head_oid: { type: ["string", "null"] },
              upstream: { type: ["string", "null"] },
              ahead: { type: "integer", minimum: 0 },
              behind: { type: "integer", minimum: 0 },
            },
            required: ["name", "detached", "unborn", "head_oid", "upstream", "ahead", "behind"],
            additionalProperties: false,
          },
          clean: { type: "boolean" },
          staged: { type: "array", maxItems: 500 },
          unstaged: { type: "array", maxItems: 500 },
          untracked: { type: "array", maxItems: 500 },
          conflicted: { type: "array", maxItems: 500 },
          truncated: { type: "boolean" },
          observed_at: { type: "string" },
          shallow: { type: "boolean" },
          history_complete: { type: "boolean" },
          operation_state: { type: "object" },
        },
        required: ["repository", "branch", "clean", "staged", "unstaged", "untracked", "conflicted", "truncated", "observed_at", "shallow", "history_complete", "operation_state"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(5000, 5000),
    },
    async (args, ctx) => {
      const result = await git.getStatus(String(args.repo_id), ctx.mode, ctx.signal, 5000);
      return { ok: true, summary: result.clean ? "working tree clean" : "working tree dirty", data: result };
    },
  );

  registry.register(
    {
      name: "git.diff",
      version: "1.0.0",
      description: "Compare working-tree or commit states of a trusted repository (structured stats plus a bounded patch). Read-only.",
      input_schema: {
        type: "object",
        properties: {
          repo_id: REPO_ID_SCHEMA,
          scope: { type: "string", enum: ["unstaged", "staged", "working_tree", "commits"] },
          path: GIT_PATH_SCHEMA,
          base_ref: REF_SCHEMA,
          target_ref: REF_SCHEMA,
        },
        required: ["repo_id", "scope"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          scope: { type: "string" },
          base_oid: { type: ["string", "null"] },
          target_oid: { type: ["string", "null"] },
          files: { type: "array", maxItems: 500 },
          patch_available: { type: "boolean" },
          patch_truncated: { type: "boolean" },
          patch: { type: ["string", "null"], maxLength: 24576 },
          truncated: { type: "boolean" },
          observed_at: { type: "string" },
        },
        required: ["repository", "scope", "base_oid", "target_oid", "files", "patch_available", "patch_truncated", "patch", "truncated", "observed_at"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(10000, 10000),
    },
    async (args, ctx) => {
      const scope = String(args.scope) as GitDiffScope;
      const result = await git.getDiff(
        String(args.repo_id),
        ctx.mode,
        scope,
        {
          path: args.path === undefined ? undefined : String(args.path),
          base_ref: args.base_ref === undefined ? undefined : String(args.base_ref),
          target_ref: args.target_ref === undefined ? undefined : String(args.target_ref),
        },
        ctx.signal,
        10000,
      );
      return { ok: true, summary: result.files.length + " changed file(s)", data: result };
    },
  );

  registry.register(
    {
      name: "git.log",
      version: "1.0.0",
      description: "Read structured commit history of a trusted repository (metadata only, no patches or emails). Read-only.",
      input_schema: {
        type: "object",
        properties: {
          repo_id: REPO_ID_SCHEMA,
          ref: REF_SCHEMA,
          limit: { type: "integer", minimum: 1, maximum: 50 },
          path: GIT_PATH_SCHEMA,
          since: { type: "string", minLength: 1, maxLength: 64 },
          until: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: ["repo_id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          ref: { type: "string" },
          resolved_oid: { type: ["string", "null"] },
          commits: { type: "array", maxItems: 50 },
          truncated: { type: "boolean" },
          history_complete: { type: "boolean" },
          observed_at: { type: "string" },
        },
        required: ["repository", "ref", "resolved_oid", "commits", "truncated", "history_complete", "observed_at"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(5000, 5000),
    },
    async (args, ctx) => {
      const result = await git.getLog(
        String(args.repo_id),
        ctx.mode,
        {
          ref: args.ref === undefined ? undefined : String(args.ref),
          limit: args.limit === undefined ? undefined : Number(args.limit),
          path: args.path === undefined ? undefined : String(args.path),
          since: args.since === undefined ? undefined : String(args.since),
          until: args.until === undefined ? undefined : String(args.until),
        },
        ctx.signal,
        5000,
      );
      return { ok: true, summary: result.commits.length + " commit(s)", data: result };
    },
  );

  registry.register(
    {
      name: "git.branches",
      version: "1.0.0",
      description: "List local and remote-tracking branches of a trusted repository (local cached refs only, no network). Read-only.",
      input_schema: {
        type: "object",
        properties: { repo_id: REPO_ID_SCHEMA },
        required: ["repo_id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          current: { type: ["string", "null"] },
          detached: { type: "boolean" },
          local: { type: "array", maxItems: 200 },
          remote_tracking: { type: "array", maxItems: 200 },
          truncated: { type: "boolean" },
          observed_at: { type: "string" },
        },
        required: ["repository", "current", "detached", "local", "remote_tracking", "truncated", "observed_at"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(5000, 5000),
    },
    async (args, ctx) => {
      const result = await git.getBranches(String(args.repo_id), ctx.mode, ctx.signal, 5000);
      return { ok: true, summary: result.local.length + " local branch(es)", data: result };
    },
  );

  registry.register(
    {
      name: "git.show",
      version: "1.0.0",
      description: "Inspect one commit of a trusted repository (metadata, file stats, optional bounded patch). Commits only. Read-only.",
      input_schema: {
        type: "object",
        properties: {
          repo_id: REPO_ID_SCHEMA,
          ref: REF_SCHEMA,
          include_patch: { type: "boolean" },
        },
        required: ["repo_id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          ref: { type: "string" },
          oid: { type: "string" },
          parents: { type: "array" },
          author_name: { type: "string" },
          authored_at: { type: "string" },
          committed_at: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          body_truncated: { type: "boolean" },
          files: { type: "array", maxItems: 500 },
          patch_available: { type: "boolean" },
          patch_truncated: { type: "boolean" },
          patch: { type: ["string", "null"], maxLength: 24576 },
          observed_at: { type: "string" },
        },
        required: ["repository", "ref", "oid", "parents", "author_name", "authored_at", "committed_at", "subject", "body", "body_truncated", "files", "patch_available", "patch_truncated", "patch", "observed_at"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: gitPolicy(10000, 10000),
    },
    async (args, ctx) => {
      const result = await git.showCommit(
        String(args.repo_id),
        ctx.mode,
        {
          ref: args.ref === undefined ? undefined : String(args.ref),
          include_patch: args.include_patch === undefined ? undefined : Boolean(args.include_patch),
        },
        ctx.signal,
        10000,
      );
      return { ok: true, summary: "commit " + result.oid.slice(0, 7), data: result };
    },
  );
}
