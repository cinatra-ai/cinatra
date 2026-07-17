/**
 * @cinatra-ai/execution-plane — broker + sandbox worker (exec-plane S1,
 * cinatra#1706; epic #1705).
 *
 * Consumes the sealed execution-session contract from `@cinatra-ai/llm`
 * (`openSealedSession`) and provides everything between the injected
 * capability and a running container:
 *
 *  - `ExecutionBroker`   — carrier verification, per-command run-liveness
 *    revalidation, per-org quotas + bounded FIFO queueing, audit + separated
 *    stdio retention, job/workspace lifecycle, the hard-removal teardown hook;
 *  - `LocalDevSandboxWorker` — fresh hardened container per command over the
 *    digest-pinned L0 image (docker/sandbox/Dockerfile), L2 workspace volume,
 *    enforced disk quota, host-side timeout + output caps;
 *  - egress policy → NETWORK-layer enforcement (`--network none` /
 *    internal-network + attributing gateway), with the local-dev gateway
 *    lifecycle in `local-gateway.ts` and the gateway process itself in
 *    `runtime/egress-gateway.cjs`.
 *
 * Still OUTSIDE this package (later S1 slices / app wiring): the HTTP/mTLS
 * service boundary + OBO-ceiling authorization, durable jobs/audit DB tables
 * (migration-seq-at-merge), the authz-kernel sink binding, the platform-admin
 * settings surface, the health-view boot phase, and the registry read-through
 * cache on the gateway.
 */

export {
  ExecutionBroker,
  verifyServiceToken,
  toAuthzAuditEventInput,
  type ExecutionBrokerOptions,
} from "./broker";

export { LocalDevSandboxWorker, type LocalDevWorkerOptions } from "./worker";

export {
  SANDBOX_RUNTIME_UID,
  SANDBOX_RUNTIME_GID,
  SANDBOX_WORKSPACE_DIR,
  DEFAULT_L0_IMAGE_LOCAL_DEV,
  resolveL0ImageRef,
  assertSafeImageRef,
  containerNameFor,
  sandboxEnvironment,
  wrapSandboxCommand,
  buildHardenedRunArgs,
  assertNoBindMounts,
} from "./l0-profile";

export {
  DEFAULT_SANDBOX_NETWORK,
  hostMatchesAllowlist,
  resolveEgress,
  registerJobEgress,
  gatewayEnvironment,
  EgressGatewayRequiredError,
  EgressRegistrationError,
} from "./egress";

export {
  WORKSPACE_VOLUME_PREFIX,
  WORKSPACE_LABEL,
  workspaceVolumeName,
  ensureWorkspaceVolume,
  removeWorkspaceVolume,
  measureWorkspaceKb,
  listWorkspaceVolumes,
  gcExpiredWorkspaces,
} from "./workspace";

// Exec-plane S2 (cinatra#1707): read-only /skills staging + the broker-backed
// SandboxExecutor binding for the llm injection contract.
export {
  SKILLS_VOLUME_PREFIX,
  SANDBOX_SKILLS_DIR,
  SkillStagingError,
  skillsVolumeName,
  stageSkillsVolume,
  removeSkillsVolume,
} from "./staging";
export { createBrokerSandboxExecutor } from "./executor";

export {
  GATEWAY_CONTAINER_NAME,
  GATEWAY_PROXY_PORT,
  GATEWAY_ADMIN_PORT,
  ensureInternalNetwork,
  startLocalGateway,
  type LocalGateway,
} from "./local-gateway";

export { runDocker, type DockerCli, type DockerRunOutcome } from "./docker-cli";

export {
  DEFAULT_SANDBOX_LIMITS,
  DEFAULT_BROKER_QUOTAS,
  type EgressMode,
  type EgressPolicy,
  type EgressGatewayEndpoint,
  type ResolvedEgress,
  type SandboxResourceLimits,
  type SandboxCommandSpec,
  type StagedSkillInput,
  type SandboxCommandResult,
  type SandboxTermination,
  type SandboxEgressUse,
  type SandboxWorker,
  type RunLivenessProbe,
  type CommandPolicyHook,
  type BrokerQuotas,
  type ExecutionAuditRecord,
  type ExecutionAuditSink,
  type ExecutionStdioSink,
  type ExecutionStdioRedactor,
  type OpenJobResult,
  type OpenJobFailureReason,
  type ExecResult,
  type ExecFailureReason,
} from "./types";
