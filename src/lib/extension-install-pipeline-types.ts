// ---------------------------------------------------------------------------
// THE INSTALL-PIPELINE TYPE SURFACE.
//
// Extracted VERBATIM from `extension-install-pipeline.ts` (the pipeline file is
// a file-size-ratchet tracked architecture bottleneck, and the source-agnostic
// entry of cinatra#3204 D1 adds code to it). Pure code motion: no behaviour
// change, no signature drift.
//
// This module holds TYPES ONLY, and every importer takes it with `import type` /
// `export type`, so the statement is erased at build time: it adds no runtime
// edge and no reachable module to any route graph. The pipeline module
// re-exports the whole surface, so every caller's import path
// (`@/lib/extension-install-pipeline`) is byte-for-byte unchanged.
// ---------------------------------------------------------------------------

import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";
import type { OwnershipGrantInstallHooks } from "@/lib/extension-capability-ownership-grants";
import type { ConnectorAccessDeclarationInstallDeps } from "@/lib/connector-access-config-host";
import type { WidgetAuthTokenKeysInstallDeps } from "@/lib/extension-install-canonical-row-deps";
import type { AssistantDeclarationInstallDeps } from "@/lib/assistant-declaration-host";
import type { SkillPackagingInstallDeps } from "@/lib/skill-packaging-install-gate";
import type { MaterializationPlan } from "@/lib/extension-materialization-plan-core";

export type InstallPipelineInput = {
  packageName: string;
  version: string;
  orgId: string | null;
  /** Who triggered the install (for the auto-approve audit trail). */
  actorUserId?: string | null;
  storeRoot?: string;
  /**
   * The install-op journal id. The saga supplies a stable id so a retry resumes
   * the same op; when omitted the pipeline mints one (`${packageName}@${version}`
   * suffixed with a nonce) so a one-shot install still journals + finalizes.
   */
  installOpId?: string;
  /** Caller-known kind (cinatra#791): authoritative for the kind-segregated store placement; the manifest must match fail-closed. */
  expectedKind?: import("@/lib/extension-package-store-core").ExtensionStoreKind;
};

export type InstallPipelineDeps = {
  /**
   * Resolve the published tarball's sha512 SRI (the root of trust) + the registry
   * it lives on, plus an optional additive sha256 attestation.
   */
  resolveIntegrity: (packageName: string, version: string) => Promise<{ integrity: string; registryUrl: string; sha256?: string; signature?: string | null; resolvedVersion?: string; materializationPlan?: unknown }>;
  /** Materialize the verified tarball into the store (SRI-checked before write). */
  materialize: (input: { packageName: string; version: string; expectedIntegrity: string; registryUrl: string; storeRoot?: string; expectedKind?: import("@/lib/extension-package-store-core").ExtensionStoreKind; plan?: MaterializationPlan | null; expectedClosureHash?: string | null }) => Promise<{ storeDir: string; digest: string; integrity: string; contentHash: string }>;
  /** Read the materialized package's declared requestedHostPorts. */
  readRequestedPorts: (storeDir: string) => Promise<string[]>;
  /**
   * Read the materialized package's declared host/SDK compatibility range
   * (`cinatra.sdkAbiRange`) — the basis of the HOST-COMPAT GATE that refuses an
   * install/update whose declared range this host's frozen SDK ABI does not
   * satisfy, BEFORE any durable state mutates. Same trust basis as
   * `readRequestedPorts` (the SRI-verified materialized bytes). Optional so
   * existing unit tests can omit it (then no install-time compat gate runs —
   * the loaders' activation-time ABI gate remains the backstop); the default
   * factory always wires it.
   */
  readDeclaredCompat: (storeDir: string) => Promise<{ sdkAbiRange: string | null }>;
  /**
   * Read the materialized package's COMPOSED agent document (its
   * `cinatra/oas.json`), the basis of the PARENT-SATISFIED CONTEXT-SLOT GATE
   * (cinatra#3032, plan (C) item 0.29: "The declaration is static and checked at
   * install against the children's slots [...] a conflict refuses the install").
   * `null` for a package that carries none — every non-agent extension, and
   * every agent that declares no composition. Same trust basis as
   * `readDeclaredCompat` (the SRI-verified materialized bytes). Optional so
   * existing unit tests can omit it (then no install-time slot gate runs); the
   * default factory always wires it.
   */
  readComposedAgentOas?: (storeDir: string) => Promise<unknown | null>;
  /**
   * Persist the REAL provenance on the canonical install row — the sha512
   * integrity + content hash (+ the additive sha256 attestation). The default
   * routes through `sourceSwitchExtension` (the only sanctioned provenance
   * writer). Called LATE (see the body) so a half-install never leaves a
   * trusted-anchorable row.
   */
  recordProvenance: (input: {
    packageName: string;
    orgId: string | null;
    version: string;
    registryUrl: string;
    integrity: string;
    contentHash: string;
    attestedSha256?: string;
    /** base64 Ed25519 signature over the tarball, if the producer signed it. */
    signature?: string | null;
    /** The verified materialization-plan closureHash (cinatra#181), if the package carried a plan. */
    closureHash?: string | null;
    /**
     * The store tarball digest to bind as the row's DB-authoritative
     * `source.activeDigest` (cinatra#792) — `mat.digest` on the forward path,
     * the CAPTURED prior digest on a durable-rollback re-record. null/undefined
     * = no digest recorded (legacy prior sources) → selection falls back to
     * the journal digest at read time. The default writer also mirrors the
     * digest into the plain-text `current` store file (best-effort — the
     * mirror is an ops/GC hint, never a selector).
     */
    digest?: string | null;
    /** Store-root override threaded from the install input (the `current` mirror's root). */
    storeRoot?: string;
  }) => Promise<void>;
  /**
   * FINALIZE-TIME CROSS-CHECK basis (cinatra#792): read back the canonical
   * row's `source.activeDigest` for the (package, org) AFTER `recordProvenance`
   * so the pipeline can assert row digest == journal digest BEFORE
   * `finalizeInstallOp` — a torn/clobbered provenance write is refused instead
   * of finalized (the throw routes into the existing restore path). Optional so
   * existing unit tests can omit it (then no cross-check runs — the read-time
   * journal gate in `selectActiveDigest` remains the backstop); the default
   * factory always wires it.
   */
  readActiveDigest?: (packageName: string, orgId: string | null) => Promise<string | null>;
  /** Record the pending host-port grant request. */
  recordRequestedGrant: (input: { packageName: string; orgId: string | null; requestedPorts: string[] }) => Promise<void>;
  /** Approve a grant (auto-approve path for a `trusted-signed` package). requestedPorts is the mandatory subset basis. */
  approveGrant: (input: { packageName: string; orgId: string | null; approvedPorts: string[]; requestedPorts: string[]; approvedBy: string }) => Promise<void>;
  /**
   * Read the grant row at the EXACT (package, org) scope — NO global
   * (org_id IS NULL) fallback. The hot-UPDATE pre-finalize probe needs this to
   * predict EXACTLY what activation will grant, which is the EXACT-scope
   * resolution `resolveInstallAnchor` uses: the anchor reads the grant but then
   * DISCARDS any global-fallback grant whose org does not match the install's
   * org, and counts ports ONLY when that exact-scope grant is `approved` AND its
   * `requestedPortsHash` still matches the in-flight requested ports (a changed
   * request resets the grant to pending → []). So the probe must read the
   * exact-scope ROW (status + approvedPorts + requestedPortsHash), NOT
   * `readApprovedPorts` (whose global fallback would leak a cross-scope grant the
   * anchor refuses, predicting ports activation will NOT actually grant). NOT a
   * grant mutation — read-only. Optional so existing unit tests can omit it (then
   * the probe is []); the default factory wires `readGrantForScope`.
   */
  readGrantForScope: (
    packageName: string,
    orgId: string | null,
  ) => Promise<{ orgId: string | null; status: string; approvedPorts: string[]; requestedPortsHash: string; approvedBy?: string | null } | null>;
  /**
   * Durable rollback: re-write the OLD grant row to its EXACT captured
   * state (status + approvedPorts + requestedPortsHash + approvedBy) after a failed
   * hot-update — bypassing the forward request→approve gates because the captured
   * state was already valid (the live grant of the previous, working install).
   * Optional (omitted → the grant is not restored, only the source/journal are); the
   * default factory wires `restoreGrant`.
   */
  restoreGrant: (input: {
    packageName: string;
    orgId: string | null;
    status: "pending" | "approved" | "revoked";
    approvedPorts: readonly string[];
    requestedPortsHash: string;
    approvedBy: string | null;
  }) => Promise<void>;
  /**
   * Apply the materialized package's declared migrations — its
   * `cinatra.migrationsDir` node-pg-migrate modules, host-run through the
   * shared runner under the `cinatra-schema-init` advisory lock (#118).
   * Runs BEFORE finalize so a failed migration aborts the install (no
   * `finalized` journal phase → the anchor refuses the row). Optional so existing
   * unit tests can omit it; the default factory wires the host entry point
   * (`applyExtensionMigrationsFromStore`). A package that declares no
   * migrationsDir is a clean no-op; the RETIRED legacy `cinatra.migrations`
   * JSON-DSL field is rejected fail-closed. `ctx.db` stays UNWIRED — the host
   * runs the modules; the extension never gets a DB handle.
   */
  applyMigrations: (input: { storeDir: string; packageName: string; version: string; orgId: string | null }) => Promise<void>;
  /**
   * Validate-only migration preflight (#118): returns true when the
   * materialized package DECLARES host migrations (cinatra.migrationsDir),
   * throws on a malformed declaration or the RETIRED legacy
   * `cinatra.migrations` JSON-DSL field. Runs for EVERY install (not just
   * trusted-signed) so a non-signed package that declares migrations is
   * REFUSED before finalize — its DDL would never run, and a finalized
   * install that can never activate is a trap. Optional so existing unit
   * tests can omit it; the default factory wires the host preflight.
   */
  preflightMigrations: (input: { storeDir: string; packageName: string }) => Promise<boolean>;
  /**
   * Install-op journal hooks (the saga's idempotency + the anchor's `finalized`
   * trust gate run over these). The default factory wires the journal store.
   */
  beginInstallOp: (input: { installOpId: string; packageName: string; orgId: string | null; digest?: string | null }) => Promise<void>;
  advanceInstallOpPhase: (input: { installOpId: string; phase: "materialized" | "granted" | "preflighted" | "finalized" | "failed" | "rolled_back" | "superseded"; digest?: string | null }) => Promise<void>;
  /**
   * FINALIZE the install op — the SUPERSESSION seam (cinatra#158). Unlike a plain
   * `advanceInstallOpPhase({phase:'finalized'})`, this ATOMICALLY demotes the prior
   * `finalized` op for the same (package, org) to `superseded` and promotes this op
   * to `finalized`, upholding the DB partial-unique-on-`finalized` invariant (exactly
   * one anchor per (package, org)). The HAPPY-path finalize MUST route through this,
   * never the plain advance. The default factory wires `finalizeInstallOp`.
   */
  finalizeInstallOp: (installOpId: string) => Promise<void>;
  /**
   * Read the current (package, org) install-op journal row (or null). The update-
   * compensation path captures this BEFORE `beginInstallOp` overwrites the single
   * (package, org) row: on a hot-UPDATE it is the OLD install's `finalized` op, so
   * if a post-begin step throws the pipeline can RESTORE that op (re-`begin` it at
   * its original `installOpId` + `digest`, then re-advance to `finalized`) and keep
   * the previously-working install boot-anchorable. Optional so existing unit tests
   * can omit it (then no restore runs); the default factory wires the journal read.
   */
  readInstallOp: (packageName: string, orgId: string | null) => Promise<{ installOpId: string; phase: string; digest: string | null } | null>;
  /**
   * Durable-rollback-first: capture the CURRENT canonical source/provenance
   * for the (package, org) BEFORE `recordProvenance` (sourceSwitch) overwrites it. On
   * a hot-UPDATE this is the OLD install's verdaccio source — the basis for the
   * post-commit DURABLE ROLLBACK (re-record it via `recordProvenance` if the NEW
   * digest fails live activation). Optional (omitted → no source capture → the
   * post-commit rollback re-records nothing, only the journal/grant restore run);
   * the default factory wires the canonical-store read.
   */
  readCurrentSource: (
    packageName: string,
    orgId: string | null,
  ) => Promise<{
    registryUrl: string;
    version: string;
    integrity: string;
    contentHash?: string;
    attestedSha256?: string;
    signature?: string | null;
    closureHash?: string | null;
    /** The prior install's DB-authoritative digest (cinatra#792) — re-pinned on rollback. */
    activeDigest?: string;
  } | null>;
  /**
   * Capture the CURRENT canonical row's persisted dependency edges for the
   * (package, org) BEFORE `persistDependencyEdges` overwrites them (#180). On
   * a hot-UPDATE these are the OLD install's edges — restored by BOTH unwind
   * paths (the pre-finalize catch and the post-commit durable rollback) so a
   * failed update never leaves the NEW manifest's edges on a row whose live
   * install is the OLD version (that would corrupt every closure gate that
   * reads the row). Returns null when no live row exists. Optional (omitted →
   * edges are not restored on rollback); the default factory wires the
   * canonical-store read.
   */
  readCurrentDependencies: (
    packageName: string,
    orgId: string | null,
  ) => Promise<ExtensionDependency[] | null>;
  /**
   * POST-COMMIT in-process activation for a FRESH install (no prior digest to
   * protect). Called AFTER finalize with the just-materialized store dir, so the
   * running process picks the package up WITHOUT a restart (targeted
   * `loadRuntimePackageExtensions({ onlyPackage })` through the trusted anchor).
   * Best-effort: the pipeline swallows a throw here — activation is process
   * convenience layered on a COMMITTED install, never a rollback trigger.
   * Optional so unit tests can omit it (then `activated:false`,
   * `reason:"no-activator"`); the default factory wires
   * `activateInstalledPackageInProcess`.
   */
  activateInProcess: (input: {
    packageName: string;
    orgId: string | null;
    storeDir: string;
    storeRoot?: string;
  }) => Promise<{ activated: boolean; reason?: string }>;
  /**
   * POST-COMMIT activation for an UPDATE (atomic hot-update with
   * durable-rollback-first). Called AFTER finalize when the just-materialized digest
   * SUPERSEDES a prior finalized install. It QUARANTINES the old digest, activates
   * the NEW digest in-process, and — if the new digest fails live activation for ANY
   * reason the pre-finalize probe could not predict — DURABLY ROLLS BACK to the OLD
   * version: it invokes `restoreDurableAnchor` (re-record OLD provenance + re-finalize
   * OLD journal op + re-approve OLD grant), tears down partial new registrations,
   * restores the old store dir from quarantine, and re-activates the OLD digest.
   * Returns `{ rolledBack:true, activated:false }` on a rolled-back update so the
   * pipeline reports the update did NOT take (previous version retained). Optional
   * (omitted → falls back to `activateInProcess`); the default factory wires
   * `hotUpdateWithDurableRollback`.
   */
  activateUpdateWithRollback: (input: {
    packageName: string;
    orgId: string | null;
    storeDir: string;
    storeRoot?: string;
    /** Previously-ACTIVE digest — targeted module destroy (cinatra#796; full
     *  contract on `hotUpdateWithDurableRollback`'s opts). null = destroy-all. */
    priorDigest?: string | null;
    /**
     * Re-pin the durable anchor to the OLD install (pipeline-owned writers).
     * Returns a `{ complete }` verdict: `complete:false` means ≥1 durable restore
     * step FAILED (provenance/journal/grant), so the rollback is only PARTIAL and
     * the caller must NOT report a clean rollback.
     */
    restoreDurableAnchor: () => Promise<{ complete: boolean; reason?: string }>;
  }) => Promise<{ activated: boolean; rolledBack?: boolean; rollbackComplete?: boolean; reason?: string }>;
  /**
   * HOT-UPDATE pre-finalize probe (BEST-EFFORT EARLY-OUT ONLY; NOT
   * THE SAFETY BOUNDARY). When the just-materialized digest SUPERSEDES an
   * already-materialized digest (an UPDATE), this cheaply checks the NEW digest
   * imports + integrity-verifies + its `register(ctx)` succeeds against an inert
   * probe ctx, BEFORE the pipeline mutates durable state. Its ONLY purpose is to
   * avoid the rollback churn of committing-then-rolling-back for an OBVIOUSLY-corrupt
   * digest. It can NEVER perfectly predict the live `register()` (different process
   * region — no jobs/notifications/peer-capability context), so a `register` that
   * passes the probe but fails live is EXPECTED and is handled by the post-commit
   * DURABLE ROLLBACK (`activateUpdateWithRollback`), which is the authoritative
   * guarantee. Returning `{ supersedes:false }` means a fresh install (no early-out).
   * `{ supersedes:true, ok:false, reason }` → the pipeline THROWS pre-finalize (the
   * cheap early-out) AND GCs the failed new digest dir, leaving the previous install
   * durably intact. Optional (unit tests omit it → no early-out; the default factory
   * wires the host probe). DO NOT chase probe-vs-live fidelity here — the rollback is
   * the boundary.
   */
  /**
   * The host's trusted activation hosts and the unsigned-bootstrap lever.
   *
   * Injectable so a unit test can state the host policy it is testing instead of
   * reaching into deployment configuration through the environment. Production
   * callers omit both and the real config readers are used. The classifier
   * itself is NEVER injectable: what counts as trusted is not a test fixture.
   */
  trustedActivationHosts?: () => string[];
  allowMarketplaceBootstrapTrust?: () => boolean;
  verifyActivatableBeforeFinalize: (input: {
    packageName: string;
    orgId: string | null;
    storeDir: string;
    integrity: string;
    contentHash: string;
    approvedPorts: readonly string[];
    storeRoot?: string;
  }) => Promise<{ supersedes: boolean; ok: boolean; reason?: string }>;
  /**
   * GC a single just-materialized (failed) store dir + its sibling `.tgz`. Called
   * by every pre-finalize refusal that owns the dir: the host-compat gate, the
   * untrusted-install gate, and a rejected activation probe (for a fresh install
   * as well as an update), so failed bytes never linger on disk to trip the boot
   * duplicate-name gate against an intact previous install. Never called when the
   * materialized dir IS the live install's dir. Best-effort. Optional (the
   * default factory wires `rm`).
   */
  gcStoreDir: (storeDir: string) => Promise<void>;
  /**
   * Read the materialized manifest's dependency edges (#180) — the DUAL-READ
   * helper over the SRI-verified bytes (`cinatra.dependencies` canonical-wins;
   * legacy `cinatra.agentDependencies` projected to required runtime edges;
   * both-present-and-inequivalent or malformed = THROW, fail-loud). Runs
   * EARLY (with the host-compat gate, before any durable mutation) so a
   * refused manifest is fully inert. Optional so existing unit tests can omit
   * it (then no edges are read/persisted); the default factory always wires it.
   */
  readDependencyEdges: (storeDir: string) => Promise<ExtensionDependency[]>;
  /**
   * Persist the manifest edges onto the canonical install row at the SAME
   * (package, org) scope the journal/grant/provenance bind (#180 edge
   * persistence). Called at the FINALIZE SEAM — after
   * `recordProvenance`, immediately before the journal advances to
   * `finalized` — so no install-op reaches `finalized` without persisted
   * edges. The dispatcher's row seed stays `dependencies: []` (the manifest
   * is unreadable pre-materialize); THIS write is where edges become real.
   * Optional for unit tests; the default factory wires the sanctioned
   * canonical writer (`recordExtensionDependencies`).
   */
  persistDependencyEdges: (input: {
    packageName: string;
    orgId: string | null;
    dependencies: ExtensionDependency[];
  }) => Promise<void>;
  /**
   * FORWARD install-closure gate (#180 item 5) for a FRESH install: after the
   * candidate's edges are persisted, refuse to finalize when an
   * install-blocking (required runtime/install-time) edge's target is not
   * installed — peer edges never block, optional edges never block. A throw
   * here routes into the EXISTING failure path: the journal never reaches
   * `finalized` and the dispatcher rolls the placeholder row back. NOT run
   * for an update (the hot-update path protects the previous install; update
   * constraint gating is the version-aware stage of #180). Optional for unit
   * tests; the default factory wires the shared closure gate.
   */
  assertForwardInstallClosure: (input: {
    packageName: string;
    orgId: string | null;
  }) => Promise<void>;
  /**
   * Structured operational-event sink (cinatra#158 (d)). Fired when ANY durable
   * RESTORE step — the OLD provenance / host-port grant / dependency-edges
   * re-pin — FAILS in either unwind path (the pre-finalize update catch, or the
   * post-commit hot-update durable rollback). A failed restore leaves the
   * previous install only PARTIALLY re-pinned; this is the structured parity
   * with how the hot-update path surfaces `rollbackComplete:false`. Best-effort:
   * a throw from the sink is swallowed so it never masks the original error. The
   * default factory wires a stable structured console emitter; tests inject a
   * spy. Required (the test factory supplies an inert default).
   */
  emitOperationalEvent: (event: InstallDurableRestoreFailureEvent) => void;
  // The access-declaration vertical slice (cinatra#951) lives in
  // connector-access-config-host.ts: readAccessDeclaration /
  // persistAccessDeclaration / readCurrentAccessDeclaration.
  // The assistant-declaration install-gate slice (cinatra#1874 W1) lives in
  // assistant-declaration-host.ts: readAssistantInstallSignals (pre-finalize
  // XOR + platform-scope gate).
} & ConnectorAccessDeclarationInstallDeps & AssistantDeclarationInstallDeps & SkillPackagingInstallDeps & OwnershipGrantInstallHooks & WidgetAuthTokenKeysInstallDeps;

/**
 * Structured operational event for a FAILED durable-restore step (cinatra#158).
 * Log-scrapers / ops alerting key on `event: "install_durable_restore_failed"`.
 */
export type InstallDurableRestoreFailureEvent = {
  event: "install_durable_restore_failed";
  packageName: string;
  orgId: string | null;
  /** Which durable axis failed to restore. */
  step: "provenance" | "grant" | "ownership-grant" | "dependencies" | "journal" | "access-declaration" | "widget-auth-token-keys";
  /** Which unwind path raised it. */
  scope: "pre-finalize" | "post-commit-rollback";
  reason: string;
};

export type InstallPipelineResult = {
  packageName: string;
  version: string;
  storeDir: string;
  digest: string;
  integrity: string;
  contentHash: string;
  requestedPorts: string[];
  grantStatus: "approved" | "pending";
  /** Always true once this function returns (the install committed + finalized).
   *  A failure before finalize throws — it never returns `installed:false`. */
  installed: true;
  /** Whether the POST-COMMIT in-process activation registered the package this
   *  call (false when no activator is wired, the anchor refused it, or activation
   *  threw — all NON-FATAL, the boot loader is the durable path). */
  activated: boolean;
  /**
   * For an UPDATE whose NEW digest failed live activation and was DURABLY
   * ROLLED BACK to the previous version. When true, the update did NOT take — the
   * caller (dispatcher / extensions_update handler) MUST report the previous version
   * was retained, NOT update success. `activated` is always false when this is true.
   */
  rolledBack?: boolean;
  /**
   * When `rolledBack` is true, whether the durable rollback was CLEAN —
   * EVERY durable restore step (OLD provenance, journal op, host-port grant)
   * succeeded. `true` ⇒ the previous version is fully restored (the caller may
   * report the calm "previous version retained" outcome). `false` ⇒ the durable
   * state is only PARTIALLY restored, so the caller MUST surface a LOUD
   * manual-recovery error, NOT a calm success. Undefined when not a rollback.
   */
  rollbackComplete?: boolean;
  /** Machine-readable reason when `activated` is false. */
  reason?: string;
};
