/**
 * HR-03A: hybrid registry foundation barrel (nodes, providers, routing).
 *
 * In-memory deterministic trust metadata only: no routing engine, no
 * network, no persistence, no config, no model execution. The LLM never
 * decides WHERE something executes; a future HR-03B/C engine will filter
 * these registries by hard constraints and rank deterministically.
 */

export {
  ARTHUR_NODE_ROLES,
  ARTHUR_NODE_RUNTIME_MODES,
  MAX_NODE_CAPABILITIES,
  MAX_NODE_ID_CHARS,
  MAX_NODE_PLATFORM_CHARS,
  MAX_NODE_TOOL_IDS,
  MAX_NODE_TOOL_ID_CHARS,
  NODE_STATUSES,
  defaultNodeState,
  isArthurNodeRole,
  isArthurNodeRuntimeMode,
  isNodeStatus,
  nodeDescriptorsEqual,
  normalizeNodeDescriptor,
  normalizeNodeState,
  type ArthurNodeDescriptor,
  type ArthurNodeRole,
  type ArthurNodeRuntimeMode,
  type NodeRuntimeState,
  type NodeStatus,
} from "./node";
export { NodeRegistry, type NodeRecord } from "./node_registry";
export {
  MAX_CONTEXT_TOKENS,
  MAX_PROVIDER_CAPABILITIES,
  MAX_PROVIDER_ID_CHARS,
  normalizeProviderDescriptor,
  providerDescriptorsEqual,
  type ProviderModelMetadata,
  type RuntimeProviderDescriptor,
} from "./provider_descriptor";
export { ProviderRegistry } from "./provider_registry";
export {
  DATA_LOCALITY_POLICIES,
  EXTENDED_ROUTING_REASONS,
  MAX_ROUTING_ALTERNATIVES,
  MAX_ROUTING_CAPABILITIES,
  MAX_ROUTING_ID_CHARS,
  REASONING_PROFILES,
  ROUTING_OPERATIONS,
  allowedRuntimeModesFor,
  assertExtendedRoutingReason,
  isBackwardCompatibleReason,
  isDataLocalityPolicy,
  isExtendedRoutingReason,
  isReasoningProfile,
  isRoutingOperation,
  normalizeHybridRoutingDecision,
  normalizeRoutingRequest,
  runtimeModeAllowed,
  type DataLocalityPolicy,
  type ExtendedRoutingReason,
  type HybridRoutingDecision,
  type ReasoningProfile,
  type RoutingConstraints,
  type RoutingOperation,
  type RoutingRequest,
} from "./routing_contracts";
export { validateProviderNodeBinding } from "./validation";export {
  HYBRID_ERROR_REASONS,
  HybridRegistryError,
  isHybridErrorReason,
  type HybridErrorReason,
} from "./errors";export {
  DEFAULT_ROUTING_POLICY,
  normalizeRoutingPolicy,
  preferenceListFor,
  preferenceRankOf,
  type RoutingPolicy,
  type RuntimePreferenceTable,
} from "./routing_policy";
export {
  HybridRoutingEngine,
  isNoEligibleTargetError,
  isRejectionReason,
  NO_ELIGIBLE_TARGET,
  NoEligibleTargetError,
  REJECTION_REASONS,
  type EngineNodeCandidate,
  type EngineProviderCandidate,
  type HybridRoutingEngineDeps,
  type RejectionReason,
} from "./routing_engine";
