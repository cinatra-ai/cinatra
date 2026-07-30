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
 * Since the S1 service slice, ALSO in this package (see `./service/*`): the
 * HTTP/mTLS SERVICE BOUNDARY — the versioned wire contract, mutual-TLS identity
 * with exact URI-SAN + EKU authorization, thin broker/worker servers over the
 * classes above, and the two clients that make a remote placement
 * indistinguishable from an in-process one (`SandboxExecutor` for the app,
 * `SandboxWorker` for the broker).
 *
 * Still OUTSIDE this package (later slices / app wiring): OBO-ceiling
 * authorization on the service boundary, a DURABLE `commandId` ledger (the
 * shipped one is process-local — see `service/command-ledger.ts`), durable
 * jobs/audit DB tables (migration-seq-at-merge), routing the broker's L2
 * workspace + read-only skills volume operations to a REMOTE worker (the broker
 * still performs them through its own docker seam), a broker-side per-command
 * run-liveness binding for the remote placement, making the `remote` placement
 * mode selectable in the platform-admin settings surface, a live broker
 * reachability probe in the health-view boot phase, and the registry
 * read-through cache on the gateway.
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
  containerNamePrefixFor,
  isContainerNameForJob,
  SANDBOX_CONTAINER_LABEL,
  SANDBOX_CONTAINER_JOB_LABEL,
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
export {
  createBrokerSandboxExecutor,
  type BrokerSandboxExecutorOptions,
  type CommandVoucherMinter,
} from "./executor";

// Exec-plane L3 (epic cinatra#1705): the TYPED host-operation seam that lets a
// broker place its volume + container operations on the worker host instead of
// its own, and the host-exclusivity precondition it revalidates before every
// placement decision.
export {
  createLocalDockerContainerOps,
  createLocalDockerVolumeOps,
  type SandboxContainerOps,
  type SandboxVolumeOps,
} from "./volume-ops";

// ---------------------------------------------------------------------------
// The per-command authorization boundary (epic #1705). VERIFY-ONLY: the signing
// side lives in the app layer (src/lib/execution/execution-voucher-mint.ts),
// which is the only holder of the private key and of the run store the OBO
// ceiling is re-derived from. The canonical wire form is exported so the mint
// site produces byte-identical bodies without restating the format — the app
// reaches it through the dependency-free `@cinatra-ai/execution-plane/voucher`
// subpath, never through this barrel.
// ---------------------------------------------------------------------------
export {
  ExecutionVoucherVerifier,
  VoucherKeyMaterialError,
  VOUCHER_VERSION,
  VOUCHER_SIGNING_DOMAIN,
  VOUCHER_CLOCK_SKEW_MS,
  DEFAULT_VOUCHER_NONCE_CAPACITY,
  canonicalVoucherPayload,
  encodeVoucherBody,
  voucherSigningInput,
  assembleVoucher,
  commandDigest,
  type ExecutionVoucherClaims,
  type ExecutionVoucherVerifierOptions,
  type VoucherRejection,
  type VoucherVerification,
  type VoucherVerificationContext,
} from "./authz/voucher";

export {
  clampEgressPolicy,
  intersectAllowlists,
  type EgressClampAxis,
  type EgressClampResult,
  type EgressDeploymentMaximum,
} from "./authz/egress-clamp";

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
  type ExecRevalidationChallenge,
  type PlacementGuard,
  type PlacementVerdict,
} from "./types";

// ---------------------------------------------------------------------------
// L1 declared environments (exec-plane S3, cinatra#1708): the trusted
// content-addressed builder, the layer cache + org-scoped recipe references +
// retention GC + teardown participant, signed per-layer provenance, the
// promotion data seam, and the broker/worker MOUNT contract — an opened job
// may carry a resolved L1 layer (`ResolvedEnvironmentMount`) that every command
// runs over, mounted by its SIGNED digest after the worker re-verifies
// provenance (fail-closed, AC4). Still OUTSIDE this package (the app-layer
// service slice): resolving a run's DECLARED environment into that layer
// (declared spec → trusted builder → cache entry → `openJob({ environment })`),
// scheduling the retention GC, and composing the teardown participant into
// `src/lib`.
// ---------------------------------------------------------------------------

export {
  ENVIRONMENT_BUILDER_VERSION,
  computeEnvironmentSpecKey,
  computeEnvironmentRecipeKey,
  canonicalSpecKeyJson,
  canonicalRecipeJson,
  resolvedArtifactDigest,
  type EnvironmentBuildPolicy,
  type EnvironmentPlatform,
  type EnvironmentSpecKeyInputs,
  type EnvironmentResolvedArtifact,
  type EnvironmentBuildRecipe,
} from "./environment/recipe";

export {
  signEnvironmentProvenance,
  verifyEnvironmentProvenance,
  type EnvironmentLayerProvenance,
  type SignedEnvironmentLayerProvenance,
} from "./environment/provenance";

export {
  EnvironmentLayerCache,
  createInMemoryEnvironmentLayerStore,
  makeEnvironmentTeardownParticipant,
  DEFAULT_ENVIRONMENT_LAYER_RETENTION_MS,
  type EnvironmentLayerCacheEntry,
  type EnvironmentLayerCacheOptions,
  type EnvironmentLayerPartition,
  type EnvironmentLayerStore,
  type EnvironmentRecipeReference,
  type LayerLookupResult,
  type ReferenceMatch,
} from "./environment/cache";

export {
  TrustedEnvironmentBuilder,
  EnvironmentBuildRefusedError,
  renderEnvironmentDockerfile,
  buildEnvironmentImageArgs,
  assertNoCredentialBuildArgs,
  resolveImageDigest,
  L1_IMAGE_REPO,
  ENV_LOCK_DIR,
  DEFAULT_BUILD_REGISTRY_ALLOWLIST,
  DEFAULT_BUILD_RESOURCES,
  type EnvironmentBuildResources,
  type TrustedEnvironmentBuilderOptions,
  type EnsureEnvironmentLayerResult,
} from "./environment/builder";

export {
  computePromotionCandidates,
  applyPromotion,
  DEFAULT_PROMOTION_WINDOW_RUNS,
  DEFAULT_PROMOTION_THRESHOLD,
  type ObservedAdhocInstall,
  type PromotionCandidate,
  type PromotionProposal,
} from "./environment/promotion";

// The broker/worker MOUNT contract for a resolved L1 layer: the projection a
// command carries + the fail-closed verify-before-mount resolver/refusal.
export {
  resolveEnvironmentMount,
  EnvironmentMountRefusedError,
  type ResolvedEnvironmentMount,
  type EnvironmentMountRefusalReason,
  type EnvironmentMountResolution,
} from "./environment/mount";

// ---------------------------------------------------------------------------
// The HTTP/mTLS SERVICE BOUNDARY (exec-plane S1 service slice, epic #1705).
//
// The managed placement's two hops — app→broker and broker→worker — as a
// versioned wire contract (`service/protocol.ts`), mutual-TLS identity with
// byte-exact URI-SAN + EKU authorization (`service/mtls.ts`), thin servers over
// the merged `ExecutionBroker` / `SandboxWorker` (`service/broker-server.ts`,
// `service/worker-server.ts`), and the two clients that keep a remote placement
// indistinguishable from an in-process one: `BrokerServiceClient` +
// `createRemoteSandboxExecutor` for the app, and `WorkerServiceClient` — which
// IMPLEMENTS `SandboxWorker`, so the broker cannot tell the difference.
//
// The runnable entrypoints (`service/broker-entry.ts`,
// `service/worker-entry.ts`) are deliberately NOT exported: nothing that
// listens, reads `process.argv` or reads the filesystem at import time belongs
// in this barrel — the same separation `runtime/egress-gateway.cjs` already has.
// `pnpm build:exec-service-bundle` bundles those entries for a container.
// ---------------------------------------------------------------------------

export {
  EXEC_PROTOCOL_VERSION,
  EXEC_PROTOCOL_VERSION_ENV,
  EXEC_PROTOCOL_HEADER,
  EXEC_SERVICE_TOKEN_HEADER,
  EXEC_RPC_PATH,
  EXEC_DEFAULT_MAX_BODY_BYTES,
  EXEC_ERROR_STATUS,
  BROKER_OPS,
  WORKER_OPS,
  checkProtocolVersion,
  checkProtocolHeader,
  parseBrokerRequest,
  parseWorkerRequest,
  execRequestEnvelope,
  execOkResponse,
  execErrorResponse,
  type BrokerOp,
  type WorkerOp,
  type BrokerRequest,
  type WorkerRequest,
  type BrokerResultFor,
  type WorkerResultFor,
  type ExecErrorCode,
  type ExecErrorBody,
  type ExecRequestEnvelope,
  type ExecResponseEnvelope,
  type ExecutionStdioEntry,
  type OpenJobPayload,
  type ExecPayload,
  type CloseJobPayload,
  type TerminateJobsForRunPayload,
  type SweepPayload,
  type DrainAuditPayload,
  type DrainAuditResultPayload,
  type HealthResultPayload,
  type RunCommandPayload,
  type StageSkillsPayload,
} from "./service/protocol";

export {
  EXEC_URI_SAN_SCHEME,
  EXEC_SERVICE_ROLES,
  EXEC_TLS_MIN_VERSION,
  EXEC_TLS_CERT_FILE_ENV,
  EXEC_TLS_KEY_FILE_ENV,
  EXEC_TLS_CA_FILE_ENV,
  EXEC_TLS_KEY_PASSPHRASE_ENV,
  EXEC_TLS_CLIENT_CERT_FILE_ENV,
  EXEC_TLS_CLIENT_KEY_FILE_ENV,
  EXEC_TLS_CLIENT_KEY_PASSPHRASE_ENV,
  EKU_SERVER_AUTH,
  EKU_CLIENT_AUTH,
  execServiceUri,
  parseUriSans,
  authorizePeerIdentity,
  authorizeServiceClient,
  execServerTlsOptions,
  execClientTlsOptions,
  loadExecTlsMaterial,
  loadExecClientTlsMaterial,
  type ExecServiceRole,
  type ExecServerRole,
  type ExecClientRole,
  type ExecPeerCertificate,
  type ExecTlsMaterial,
  type ExecServerTlsConfig,
  type ExecClientTlsConfig,
  type ExecClientTlsOptions,
  type PeerAuthorization,
  type PeerRefusalReason,
} from "./service/mtls";

export {
  createInMemoryCommandLedger,
  DEFAULT_COMMAND_LEDGER_MAX_RECORDS,
  DEFAULT_COMMAND_LEDGER_RETENTION_MS,
  DEFAULT_COMMAND_LEDGER_MIN_REPLAY_MS,
  COMMAND_LEDGER_HARD_MAX_MULTIPLE,
  type CommandLedger,
  type CommandLedgerRecord,
  type CommandClaim,
  type CommandOutcome,
} from "./service/command-ledger";

export {
  ExecRpcClient,
  createExecRpcListener,
  EXEC_DEFAULT_REQUEST_TIMEOUT_MS,
  type ExecRpcClientConfig,
  type ExecRpcCallResult,
  type ExecRpcContext,
  type ExecRpcDispatch,
  type ExecRpcListenerConfig,
  type ExecRpcReply,
} from "./service/rpc-transport";

export {
  createBrokerService,
  createBrokerDispatch,
  createBufferedAuditRelay,
  DEFAULT_AUDIT_RELAY_MAX_RECORDS,
  DEFAULT_AUDIT_RELAY_MAX_STDIO,
  type BrokerService,
  type BrokerServiceConfig,
  type BrokerServiceBroker,
  type ExecAuditRelay,
} from "./service/broker-server";

export {
  createWorkerService,
  createWorkerDispatch,
  type WorkerService,
  type WorkerServiceConfig,
} from "./service/worker-server";

export {
  BrokerServiceClient,
  createRemoteSandboxExecutor,
  ExecServiceUnavailableError,
  type BrokerServiceClientConfig,
  type RemoteExecutorBroker,
} from "./service/broker-client";

export {
  WorkerServiceClient,
  DEFAULT_WORKER_CLIENT_MAX_ATTEMPTS,
  DEFAULT_WORKER_CLIENT_RETRY_DELAY_MS,
  type WorkerServiceClientConfig,
} from "./service/worker-client";

// The worker's fail-closed NAME POLICY for the typed ops (exec-plane L3).
export {
  ExecVolumeNameRefusedError,
  assertDrainJobId,
  assertExecVolumeName,
  assertExecVolumeOwnership,
  assertStagingJobId,
  assertWorkspaceKey,
  type ExecVolumeTier,
} from "./service/volume-guard";

// The host-exclusivity lease the broker revalidates before every placement.
export {
  DEFAULT_HOST_EXCLUSIVITY_LEASE_PATH,
  DEFAULT_LEASE_CACHE_TTL_MS,
  LOCK_RELEASE_ATTEMPTS,
  LOCK_SPIN_ATTEMPTS,
  LOCK_SPIN_DELAY_MS,
  STALE_LOCK_MINUTES,
  TEMP_NAME_ATTEMPTS,
  lockIsStale,
  HOST_EXCLUSIVITY_LEASE_PATH_ENV,
  HOST_EXCLUSIVITY_LOCK_DIR_NAME,
  HOST_EXCLUSIVITY_MODE_ENV,
  HOST_EXCLUSIVITY_RENEW_INTERVAL_ENV,
  HOST_EXCLUSIVITY_TENANT_ENV,
  HostExclusivityLeaseGuard,
  TENANT_SLUG_RE,
  evaluateHostExclusivityLease,
  hostExclusivityPlacementGuard,
  nodeLeaseIo,
  parseHostExclusivityLease,
  serializeHostExclusivityLease,
  startHostExclusivityRenewal,
  type HostExclusivityGuardConfig,
  type HostExclusivityLease,
  type LeaseIo,
  type LeaseRefusalReason,
  type LeaseRenewalResult,
  type LeaseVerdict,
} from "./service/lease";
