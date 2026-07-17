/**
 * Execution plane — core injection + session spine (exec-plane S1,
 * cinatra#1706). Barrel for the `@cinatra-ai/llm` public surface.
 *
 * This slice ships the provider-agnostic FOUNDATION only:
 *  - the `sandbox_execution` tool contract + builder/guard/stripper,
 *  - trusted session minting + opaque broker-verifiable sealing,
 *  - the single `injectExecutionCapability` site + policy (rollout merge gate,
 *    D4 availability, task carve-outs, central cue composition, step budget).
 *
 * S2 (cinatra#1707) adds the executor binding seam (`SandboxExecutor` in
 * ../types), staged-skill snapshot merging, and delivery of tool + cue +
 * step budget through the orchestration entry points; the per-provider
 * translation lives in ../providers/*. The broker service, sandbox worker +
 * hardened container, egress gateway, audit-kernel records, admin
 * settings/health surfaces, and DB migrations are separate slices that
 * consume this contract.
 */

export {
  EXECUTION_SURFACES,
  mintExecutionSession,
  normalizeExecutionSession,
  sealExecutionSession,
  openSealedSession,
  UnidentifiableExecutionCallerError,
  ExecutionBrokerSecretMissingError,
  DEFAULT_CARRIER_TTL_MS,
  type ExecutionSurface,
  type ExecutionSession,
  type MintExecutionSessionInput,
  type OpenSealedSessionResult,
} from "./session";

export {
  isExecutionPlaneRolloutEnabled,
  shouldSuppressExecutionForTask,
  ensureToolAwareStepBudget,
  composeExecutionCue,
  type ExecutionAvailability,
} from "./policy";

export {
  SANDBOX_EXECUTE_TOOL_NAME,
  isSandboxExecutionTool,
  hasSandboxExecutionTool,
  buildSandboxExecutionTool,
  stripSandboxExecutionTools,
} from "./tool";

export {
  injectExecutionCapability,
  type ExecutionCapabilityError,
  type ExecutionInjectionResult,
  type ExecutionInjectionParams,
} from "./inject";
