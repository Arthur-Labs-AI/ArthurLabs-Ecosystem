/**
 * HR-03E: hybrid tool execution barrel (caller-side routing + bindings).
 *
 * Routing happens AFTER authorization at the AttemptInvoker boundary:
 * ToolRegistry builds the hybrid invoker internally over its PRIVATE raw
 * executor closure, so raw executors never become a public API.
 */

export {
  AttemptDispatchError,
  DISPATCH_ERROR_CODES,
  isAttemptDispatchError,
  isDispatchErrorCode,
  type DispatchErrorCode,
  type DispatchFailureKind,
  type DispatchOutcomeEvidence,
} from "./errors";
export {
  NodeToolExecutionBindings,
  RemoteNodeExecutorBindings,
  type RemoteToolExecutorClient,
  type RemoteToolResult,
  type RemoteToolWireAttempt,
  type RemoteToolWireContext,
} from "./node_executor_bindings";
export { HybridToolAttemptInvoker, type HybridToolAttemptInvokerDeps, type LocalToolInvoke } from "./attempt_router";
