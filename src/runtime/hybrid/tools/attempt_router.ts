/**
 * HR-03E: hybrid tool-attempt router (AttemptInvoker boundary).
 *
 * Routing happens AFTER authorization: SingleAttemptExecutionService has
 * already run ToolRegistry validation, PermissionService evaluation, the
 * SC-02 final approval verification, and the pre-dispatch abort check
 * before this invoker is called. This invoker answers only WHICH
 * already-authorized target executes the attempt - never whether the tool
 * is allowed.
 *
 * Per SC-03 attempt: route once (operation tool.execute, exact canonical
 * tool_id constraint, trusted metadata only), select one node, dispatch
 * once. No within-attempt fallback, no transport retry, no local fallback:
 * a failed target returns its typed failure to SC-03, which alone owns
 * retry/quarantine decisions for a NEW durable attempt.
 */

import type { ToolAttemptContext, ToolExecutionContext, ToolResult } from "../../../tools/contracts";
import type { AttemptInvoker } from "../../../tools/execution_service_v2";
import type { HybridRoutingEngine } from "../routing_engine";
import type { NodeRegistry } from "../node_registry";
import { AttemptDispatchError } from "./errors";
import type { NodeToolExecutionBindings } from "./node_executor_bindings";

export type LocalToolInvoke = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  attempt: ToolAttemptContext,
) => Promise<ToolResult>;

export interface HybridToolAttemptInvokerDeps {
  nodes: NodeRegistry;
  routing: HybridRoutingEngine;
  /** Trusted configured local node id: the ONE local machine for this Core. */
  localNodeId: string;
  /** Explicitly bound LAN execution clients (caller side). */
  remotes: NodeToolExecutionBindings;
  /** Private ToolRegistry local executor closure (never exposed). */
  localInvoke: LocalToolInvoke;
  /** Trusted caller ToolRegistry metadata for contract binding. */
  toolContract: (name: string) => { version: string; definitionHash: string } | undefined;
}

export class HybridToolAttemptInvoker {
  private readonly nodes: NodeRegistry;
  private readonly routing: HybridRoutingEngine;
  private readonly localNodeId: string;
  private readonly remotes: NodeToolExecutionBindings;
  private readonly localInvoke: LocalToolInvoke;
  private readonly toolContract: (name: string) => { version: string; definitionHash: string } | undefined;

  constructor(deps: HybridToolAttemptInvokerDeps) {
    if (deps === null || typeof deps !== "object") throw new Error("hybrid tool invoker requires deps");
    if (deps.nodes === null || typeof deps.nodes !== "object" || typeof (deps.nodes as NodeRegistry).list !== "function") {
      throw new Error("hybrid tool invoker requires a NodeRegistry");
    }
    if (deps.routing === null || typeof deps.routing !== "object" || typeof (deps.routing as HybridRoutingEngine).route !== "function") {
      throw new Error("hybrid tool invoker requires a HybridRoutingEngine");
    }
    if (typeof deps.localNodeId !== "string" || deps.localNodeId.trim() === "") {
      throw new Error("hybrid tool invoker requires a local node id");
    }
    if (deps.remotes === null || typeof deps.remotes !== "object" || typeof (deps.remotes as NodeToolExecutionBindings).get !== "function") {
      throw new Error("hybrid tool invoker requires remote node executor bindings");
    }
    if (typeof deps.localInvoke !== "function") throw new Error("hybrid tool invoker requires a local invoke closure");
    if (typeof deps.toolContract !== "function") throw new Error("hybrid tool invoker requires a tool contract lookup");
    this.nodes = deps.nodes;
    this.routing = deps.routing;
    this.localNodeId = deps.localNodeId.trim();
    this.remotes = deps.remotes;
    this.localInvoke = deps.localInvoke;
    this.toolContract = deps.toolContract;
  }

  readonly invoke: AttemptInvoker = async (name, args, ctx, attempt) => {
    // Trusted construction metadata only: exact canonical tool name from
    // the already-validated SC-03 attempt. Never model/user prose, never
    // tool arguments, never inferred aliases.
    const decision = this.routing.route({
      operation: "tool.execute",
      required_capabilities: [],
      data_locality: "lan_or_local",
      constraints: { tool_id: name },
    });
    if (decision.runtime_mode === "cloud") {
      throw new AttemptDispatchError("permanent", "not_applied", "NO_ELIGIBLE_TOOL_NODE", "cloud is not a tool execution target");
    }
    if (decision.runtime_mode === "local") {
      // Exactly one local machine relative to this Core: the selected
      // local node MUST be the trusted configured localNodeId.
      if (decision.target_node_id !== this.localNodeId) {
        throw new AttemptDispatchError("permanent", "not_applied", "LOCAL_NODE_MISMATCH", "local routing selected an unknown node");
      }
      return await this.localInvoke(name, args, ctx, attempt);
    }
    // LAN: exactly one bound node, dispatched once. Alternatives are
    // diagnostic only and MUST NOT be executed within this attempt.
    const targetNodeId = decision.target_node_id;
    if (typeof targetNodeId !== "string" || targetNodeId === "") {
      throw new AttemptDispatchError("permanent", "not_applied", "NO_ELIGIBLE_TOOL_NODE", "lan decision has no target node");
    }
    const client = this.remotes.get(targetNodeId);
    if (client === undefined) {
      throw new AttemptDispatchError("permanent", "not_applied", "REMOTE_TOOL_BINDING_MISSING", "no execution binding for selected lan node");
    }
    const contract = this.toolContract(name);
    if (contract === undefined) {
      throw new AttemptDispatchError("permanent", "not_applied", "TOOL_EXECUTOR_NOT_FOUND", "unknown tool contract");
    }
    // Bounded minimal wire context: identity + attempt scope only. Never
    // authorization, approval tokens, signatures, or provider metadata.
    // 'approved' stays false/informational: it carries no authority.
    const remoteCtx = { ...ctx, approved: false, authorization: undefined, approvalToken: undefined };
    void remoteCtx;
    return await client.execute(name, contract.version, contract.definitionHash, args, {
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      trace_id: ctx.trace_id,
      mode: ctx.mode,
    }, {
      execution_id: attempt.execution_id,
      attempt_id: attempt.attempt_id,
      attempt_no: attempt.attempt_no,
      deadline_at: attempt.deadline_at,
      signal: attempt.signal,
    });
  };
}
