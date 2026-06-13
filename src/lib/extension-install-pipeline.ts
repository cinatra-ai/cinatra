import "server-only";

// The live install pipeline core (what the runtime loader's trusted
// anchor reads back). Given a registry coordinate it: resolves the tarball
// integrity → materializes the verified package into the on-disk store →
// records the REAL integrity + content hash on the canonical install row →
// records the requested host-port grant → AUTO-APPROVES the grant ONLY for a
// `trusted-signed` package (the capability split); everything else (incl.
// `trusted-bootstrap`) stays pending for an admin to approve.
//
// Dependency-injected so the orchestration is unit-testable without a registry
// or a DB; `makeDefaultInstallPipelineDeps` wires the real materializer +
// canonical store + grant store.

import type { HostPortName } from "@cinatra-ai/sdk-extensions";
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

import { classifyExtensionTrust } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  computeClosureHash,
  parseMaterializationPlan,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { computeRequestedPortsHash } from "@/lib/extension-host-port-grants";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import {
  evaluateHostSdkCompat,
  formatHostSdkCompatRefusal,
} from "@/lib/extension-host-compat";

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
};

export type InstallPipelineDeps = {
  /**
   * Resolve the published tarball's sha512 SRI (the root of trust) + the registry
   * it lives on, plus an optional additive sha256 attestation.
   */
  resolveIntegrity: (packageName: string, version: string) => Promise<{ integrity: string; registryUrl: string; sha256?: string; signature?: string | null; resolvedVersion?: string; materializationPlan?: unknown }>;
  /** Materialize the verified tarball into the store (SRI-checked before write). */
  materialize: (input: { packageName: string; version: string; expectedIntegrity: string; registryUrl: string; storeRoot?: string; plan?: MaterializationPlan | null; expectedClosureHash?: string | null }) => Promise<{ storeDir: string; digest: string; integrity: string; contentHash: string }>;
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
  }) => Promise<void>;
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
  verifyActivatableBeforeFinalize: (input: {
    packageName: string;
    orgId: string | null;
    storeDir: string;
    integrity: string;
    contentHash: string;
    approvedPorts: readonly string[];
    storeRoot?: string;
  }) => Promise<{ supersedes: false } | { supersedes: true; ok: true } | { supersedes: true; ok: false; reason: string }>;
  /**
   * GC a single just-materialized (failed) store dir + its sibling `.tgz`. Called
   * ONLY when `verifyActivatableBeforeFinalize` rejects a NEW update digest, so a
   * bad new digest never lingers on disk to trip the boot duplicate-name gate
   * against the (intact) previous install. Best-effort. Optional (the default
   * factory wires `rm`).
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
};

/**
 * Structured operational event for a FAILED durable-restore step (cinatra#158).
 * Log-scrapers / ops alerting key on `event: "install_durable_restore_failed"`.
 */
export type InstallDurableRestoreFailureEvent = {
  event: "install_durable_restore_failed";
  packageName: string;
  orgId: string | null;
  /** Which durable axis failed to restore. */
  step: "provenance" | "grant" | "dependencies" | "journal";
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

/**
 * Emit a structured durable-restore-failure operational event (cinatra#158 (d)) and
 * mirror it to `console.error` (so a deployment without structured-event collection
 * still surfaces the loud signal). Best-effort: a throwing sink is swallowed so it
 * never masks the original install error.
 */
function emitDurableRestoreFailure(
  deps: Pick<InstallPipelineDeps, "emitOperationalEvent">,
  evt: Omit<InstallDurableRestoreFailureEvent, "event">,
): void {
  const event: InstallDurableRestoreFailureEvent = { event: "install_durable_restore_failed", ...evt };
  try {
    deps.emitOperationalEvent?.(event);
  } catch {
    /* sink must never mask the original error */
  }
  // eslint-disable-next-line no-console
  console.error(
    `[extension-install-pipeline] durable restore FAILED (${event.scope}/${event.step}) for ` +
      `${event.packageName} (org ${event.orgId ?? "(global)"}) — the previous install may be only ` +
      `PARTIALLY restored until a successful re-install: ${event.reason}`,
  );
}

/**
 * Run the install pipeline. The grant is AUTO-APPROVED only for a `trusted-signed`
 * package from a trusted activation host (the capability split — never a
 * merely `trusted-bootstrap` or untrusted package); everything else stays
 * `pending` until an admin approves it — so a bootstrap/untrusted package, even
 * when materialized, never self-grants host ports.
 */
export async function installExtensionFromRegistry(
  input: InstallPipelineInput,
  deps: InstallPipelineDeps,
): Promise<InstallPipelineResult> {
  const installOpId =
    input.installOpId ??
    `${input.packageName}@${input.version}:${Math.random().toString(36).slice(2, 10)}`;

  const { integrity, registryUrl, sha256, signature, resolvedVersion: resolvedFromRegistry, materializationPlan } = await deps.resolveIntegrity(input.packageName, input.version);
  // The signature payload + provenance MUST bind the RESOLVED concrete version, not
  // the caller's input (which may be a dist-tag). Fall back to the input only when
  // the resolver doesn't surface one (legacy/test deps).
  const resolvedVersion = resolvedFromRegistry ?? input.version;

  // cinatra#181 — SIGNED MATERIALIZATION PLAN (library dependency closure).
  // Parse the raw packument transport FAIL-CLOSED (any malformed plan throws —
  // normalizing to "no plan" would silently downgrade the package to v1
  // semantics), bind the plan's self-declared identity to the RESOLVED
  // (name, version), and recompute the closureHash the v2 signature must bind.
  let plan: MaterializationPlan | null = null;
  let closureHash: string | null = null;
  if (materializationPlan !== null && materializationPlan !== undefined) {
    plan = parseMaterializationPlan(materializationPlan);
    if (plan.package.name !== input.packageName || plan.package.version !== resolvedVersion) {
      throw new Error(
        `[install-pipeline] ${input.packageName}@${resolvedVersion}: the served materialization plan ` +
          `identifies as ${plan.package.name}@${plan.package.version} — a plan must bind the exact ` +
          `resolved package; refusing`,
      );
    }
    closureHash = computeClosureHash(plan);
  }

  // SIGNATURE VERDICT — computed BEFORE materialize (PR-4 review HIGH 1): a
  // plan-bearing package whose v2 signature does not verify against the
  // host-recomputed closureHash is REFUSED before ANY fetch/write — the plan
  // must never EXECUTE (per-node fetches + store writes) on unverified trust.
  // The downgrade matrix makes the verdict hard boolean whenever a plan is
  // present (v1/absent/no-key/invalid all === false), and a closure package
  // could never activate anyway — installing it would only burn bytes and
  // leave an inert store dir. Closure-LESS packages keep today's semantics
  // byte-for-byte (the same verdict value feeds classifyExtensionTrust below;
  // untrusted closure-less installs still finalize with a pending grant).
  const signatureVerified = resolveSignatureVerdict({
    packageName: input.packageName,
    version: resolvedVersion,
    integrity,
    signature,
    closureHash,
  });
  if (plan && signatureVerified !== true) {
    throw new Error(
      `[install-pipeline] ${input.packageName}@${resolvedVersion}: carries a materialization plan but no ` +
        `VERIFIED v2 signature binding its closureHash (v1/absent/unknown-prefix signatures and missing ` +
        `trusted keys are hard refusals — cinatra#181 downgrade refusal). Refusing BEFORE any fetch or ` +
        `write: the signed plan must verify before it may execute.`,
    );
  }

  const mat = await deps.materialize({
    packageName: input.packageName,
    // The RESOLVED concrete version (a dist-tag input would otherwise name the
    // store dir + sidecar + plan-identity check against the tag, while the
    // signature/provenance bind the resolved version — codex round-0 finding 6).
    version: resolvedVersion,
    expectedIntegrity: integrity,
    registryUrl,
    storeRoot: input.storeRoot,
    plan,
    expectedClosureHash: closureHash,
  });

  const requestedPorts = await deps.readRequestedPorts(mat.storeDir);

  // Read the CURRENT (package, org) journal op EARLY — read-only. Two consumers:
  // (1) the HOST-COMPAT GATE's GC guard just below (a same-version re-install
  // materializes to the SAME digest/dir as the LIVE install — GC'ing it on
  // refusal would destroy the working install's store dir), and (2) the
  // journal-compensation capture before `beginInstallOp` overwrites the single
  // (package, org) row (see the capture comment further down).
  const priorOp = await deps.readInstallOp?.(input.packageName, input.orgId);

  // HOST-COMPAT GATE — the extension → host/SDK half of the compatibility
  // contract. The materialized (SRI-verified) manifest's `cinatra.sdkAbiRange`
  // must admit this host's frozen SDK ABI — the SAME verdict both loaders gate
  // activation on (`evaluateHostSdkCompat` wraps the SDK's own checker, so the
  // install gate can never drift from the activation gate). Runs BEFORE the
  // update probe / journal / grant / provenance — the FIRST durable mutation is
  // `beginInstallOp` below — so a refused install OR update is fully inert: a
  // prior install's journal row stays `finalized`, its grant + provenance are
  // untouched, and a fresh install leaves nothing behind. The just-materialized
  // dir is GC'd (best-effort) UNLESS it IS the live install's dir (the
  // same-digest re-install case above). An undeclared/"*" range is unpinned →
  // allowed (parity with the loaders; refusing would brick every published
  // unpinned extension); a declared-but-malformed or unsatisfied range fails
  // closed with an actionable error (declared range vs. this host's ABI).
  if (deps.readDeclaredCompat) {
    const declared = await deps.readDeclaredCompat(mat.storeDir);
    if (!evaluateHostSdkCompat(declared.sdkAbiRange).compatible) {
      const isLiveDigest = priorOp?.phase === "finalized" && priorOp.digest === mat.digest;
      if (deps.gcStoreDir && !isLiveDigest) {
        try {
          await deps.gcStoreDir(mat.storeDir);
        } catch {
          /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
        }
      }
      throw new Error(
        formatHostSdkCompatRefusal({
          op: priorOp?.phase === "finalized" ? "update" : "install",
          packageName: input.packageName,
          version: resolvedVersion,
          sdkAbiRange: declared.sdkAbiRange,
        }),
      );
    }
  }

  // DEPENDENCY-EDGE READ (#180) — the dual-read helper over the materialized
  // (SRI-verified) manifest. Runs EARLY, with the host-compat gate above and
  // the same inertness contract: a malformed `cinatra.dependencies` entry or a
  // canonical-vs-legacy `agentDependencies` conflict THROWS here, BEFORE the
  // first durable mutation (`beginInstallOp` below) — a prior install's
  // journal/grant/provenance are untouched and the just-materialized dir is
  // GC'd (unless it IS the live install's dir, the same-digest re-install
  // guard the host-compat gate uses). The edges themselves are PERSISTED late,
  // at the finalize seam below.
  let dependencyEdges: ExtensionDependency[] | null = null;
  if (deps.readDependencyEdges) {
    try {
      dependencyEdges = await deps.readDependencyEdges(mat.storeDir);
    } catch (err) {
      const isLiveDigest = priorOp?.phase === "finalized" && priorOp.digest === mat.digest;
      if (deps.gcStoreDir && !isLiveDigest) {
        try {
          await deps.gcStoreDir(mat.storeDir);
        } catch {
          /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
        }
      }
      throw err;
    }
  }

  // Classify the in-process import trust tier (vendor-agnostic). The host
  // allowlist + bootstrap lever come from the trust-config seam (publicRegistryUrl
  // only — never the instance's own publish target). Computed PURELY (no mutation)
  // up front so the pre-finalize gate below can probe-register the new digest with
  // the ports it WOULD get, WITHOUT first mutating the persisted grant.
  const verdict = classifyExtensionTrust({
    packageName: input.packageName,
    registryUrl,
    integrityVerified: true,
    persistedTrustDecision: true,
    // When signing is configured/required, the install-time decision
    // respects it too (undefined = no signing → bootstrap/transition
    // behavior). Computed ONCE, above, BEFORE materialize — when the package
    // carries a plan the verdict is NEVER undefined and a non-true verdict
    // already refused the install before any write (cinatra#181).
    signatureVerified,
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  });

  // Capability split: auto-granting privileged host ports AND
  // running host DDL require `trusted-signed` (a verified signature) — never
  // `trusted-bootstrap` alone. A bootstrap-trusted multi-vendor package may import
  // in-process (the loader allows it), but its requested ports stay PENDING for an
  // admin and its declared migrations do NOT auto-run. An admin can later approve
  // the pending grant out-of-band.
  const autoGrantPrivileged = verdict.tier === "trusted-signed";

  // HOT-UPDATE pre-finalize activation gate. If the
  // just-materialized digest SUPERSEDES an existing one (an UPDATE), PROVE the new
  // digest activates (imports + integrity-verifies + register(ctx) succeeds)
  // BEFORE we mutate ANY shared (package, org) state — the install-op JOURNAL row,
  // the host-port GRANT, or the provenance. The probe
  // runs against the IN-FLIGHT integrity/contentHash + the EFFECTIVE ports the new
  // digest will ACTUALLY activate with:
  //   - `trusted-signed` (`autoGrantPrivileged`): `requestedPorts` — it self-grants
  //     them this install, so the activation has them.
  //   - otherwise (`trusted-bootstrap`/untrusted, NO auto-grant): the EXACT-scope
  //     admin-approved grant's ports for this (package, org) — but ONLY when that
  //     grant predicts what activation will ACTUALLY grant. The probe must mirror
  //     `recordRequestedGrant` (below) + the anchor's exact-scope resolution:
  //       (1) `recordRequestedGrant` resets an existing grant to `pending` when the
  //           requested-ports hash CHANGED (different ports) → activation gets [].
  //           Only an UNCHANGED requested-ports hash keeps the prior approval.
  //       (2) `resolveInstallAnchor` counts ports ONLY for a grant whose scope
  //           EXACTLY matches the install's org (NO global-fallback inheritance) and
  //           whose status is `approved`.
  //     So the EFFECTIVE bootstrap ports are the exact-(package, org)-scoped grant's
  //     approvedPorts IFF it exists AND its org matches AND it is `approved` AND its
  //     stored requestedPortsHash equals the in-flight requested ports' hash — ELSE
  //     []. Reading the EXACT-scope row (not `readApprovedPorts`, whose global
  //     fallback would leak a cross-scope grant the anchor refuses) keeps the probe ==
  //     activation's effective grant. Read-only — the intent (no AUTO-grant for
  //     bootstrap) is preserved: `approveGrant` below still runs ONLY for
  //     `autoGrantPrivileged`.
  //
  // CRITICAL ORDERING: this gate is the FIRST thing after
  // materialize, BEFORE beginInstallOp / recordRequestedGrant / approveGrant. For
  // a superseding UPDATE whose new digest fails the gate we GC the bad dir and
  // THROW immediately — having touched NOTHING shared:
  //   - the previous install's install-op journal row is still `finalized`, so the
  //     trust anchor still resolves it and the boot RuntimePackageLoader still
  //     activates the previous install;
  //   - the previous install's host-port grant is untouched — neither reset to
  //     `pending` nor re-approved against the new digest's ports;
  //   - the previous provenance + the old store dir are unchanged.
  // So a failed update is fully inert: the previous install is durably intact AND
  // boot-activatable AND keeps its exact prior access state.
  //
  // A fresh install (`supersedes:false`) is unaffected: there is no prior anchor /
  // grant to protect, the gate is a no-op, and the mutations below proceed.
  //
  // TRUST GATE on the probe (cinatra#181): the probe
  // IMPORTS the new digest and calls `register(ctx)` — executing package code.
  // An UNTRUSTED package (e.g. a closure package whose v1/absent signature the
  // downgrade-refusal matrix hard-refused, or any tampered signature) must
  // never get code execution out of the probe. Skipping it is safe: an
  // untrusted update's REAL safety boundary is unchanged — the post-commit
  // hot-update activation runs under the loader's trust gate (which refuses
  // the import) and the durable rollback restores the OLD install.
  if (deps.verifyActivatableBeforeFinalize && verdict.trusted) {
    // EFFECTIVE ports the new digest will activate with (see the block comment):
    // a `trusted-signed` install self-grants its requested ports; otherwise the
    // probe must equal what activation will grant AFTER `recordRequestedGrant` +
    // the anchor's exact-scope resolution. The exact-(package, org)-scoped grant's
    // approvedPorts count ONLY IF that grant exists, its org matches, it is
    // `approved`, and its stored requestedPortsHash still matches the in-flight
    // requested ports (an UNCHANGED request keeps the prior approval; a CHANGED
    // request will reset the grant to pending → no ports). Anything else → [].
    // No reader wired (older unit tests) → [] (the bootstrap/untrusted path).
    let effectiveBootstrapPorts: readonly string[] = [];
    if (!autoGrantPrivileged && deps.readGrantForScope) {
      const grant = await deps.readGrantForScope(input.packageName, input.orgId);
      if (
        grant &&
        (grant.orgId ?? null) === (input.orgId ?? null) &&
        grant.status === "approved" &&
        grant.requestedPortsHash === computeRequestedPortsHash(requestedPorts)
      ) {
        effectiveBootstrapPorts = grant.approvedPorts;
      }
    }
    const probeApprovedPorts = autoGrantPrivileged ? requestedPorts : effectiveBootstrapPorts;
    const gate = await deps.verifyActivatableBeforeFinalize({
      packageName: input.packageName,
      orgId: input.orgId,
      storeDir: mat.storeDir,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      approvedPorts: probeApprovedPorts,
      ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
    });
    if (gate.supersedes && !gate.ok) {
      // GC the failed new digest so two dirs never coexist for the boot
      // duplicate-name gate (the previous install's dir is the sole survivor).
      if (deps.gcStoreDir) {
        try {
          await deps.gcStoreDir(mat.storeDir);
        } catch {
          /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
        }
      }
      // Do NOT journal this failed attempt. `beginInstallOp` deliberately has not
      // run yet (it runs below, AFTER the gate), so there is no install-op row for
      // this attempt — and the journal is one row per (package, org) that
      // `beginInstallOp` UPSERTs, so minting/advancing one here would RESET the
      // PREVIOUS install's `finalized` journal row and break the still-working old
      // version. The journal correctly stays the old `finalized` op;
      // the bad new digest is already GC'd above; the throw below is the
      // authoritative failure signal.
      throw new Error(
        `update of ${input.packageName}@${input.version} could not activate the new digest ` +
          `(${gate.reason}) — the previous install is left durably intact (journal, grant, ` +
          `provenance + store dir unchanged) and the failed new digest was GC'd; no finalize.`,
      );
    }
  }

  // `priorOp` (read EARLY, above the host-compat gate) captures the CURRENT
  // (package, org) journal op BEFORE `beginInstallOp` below overwrites the single
  // (package, org) row. On a hot-UPDATE this is the OLD install's `finalized` op
  // (its id + digest); on a FRESH install it is null (or a non-finalized
  // leftover). The single-row UPSERT means `beginInstallOp` for the NEW attempt
  // DESTROYS the old `finalized` op — so if any post-begin step throws on an
  // update, we re-create this prior op (the catch below) to keep the
  // previously-working install boot-anchorable (`resolveInstallAnchor` requires
  // `phase === 'finalized'`).

  // CAPTURE (UPDATE only): before the mutations below overwrite durable
  // state, snapshot what a post-commit DURABLE ROLLBACK needs to re-pin the OLD
  // install:
  //   (b) the prior canonical source/provenance (read BEFORE `recordProvenance`'s
  //       sourceSwitch overwrites it) — re-recorded on rollback;
  //   (c) the prior EXACT-(package, org)-scoped host-port grant row (status +
  //       approvedPorts + requestedPortsHash) — re-recorded + re-approved on rollback.
  // Only meaningful when a prior finalized install exists (a real UPDATE); a fresh
  // install captures null/none and never takes the rollback path.
  const isUpdate = priorOp?.phase === "finalized";
  const priorSource = isUpdate ? (await deps.readCurrentSource?.(input.packageName, input.orgId)) ?? null : null;
  const priorGrant = isUpdate ? (await deps.readGrantForScope?.(input.packageName, input.orgId)) ?? null : null;
  // (d) the prior canonical row's persisted dependency EDGES (#180) — the NEW
  // manifest's edges land at the finalize seam below, so a failed update must
  // restore these on BOTH unwind paths or every closure gate reads the failed
  // version's edges against the still-live OLD install.
  const priorEdges = isUpdate
    ? (await deps.readCurrentDependencies?.(input.packageName, input.orgId)) ?? null
    : null;

  let grantStatus: "approved" | "pending" = "pending";
  try {
    // Journal-begin at `materialized` — the row exists but is NOT yet finalized,
    // so the anchor gate refuses it until the LATE finalize below. Begins ONLY
    // after the pre-finalize gate above has PROVEN the new digest activatable (for
    // a superseding update), so a failed update never resets the previous install's
    // `finalized` journal row. For a fresh install the gate was a no-op.
    await deps.beginInstallOp?.({ installOpId, packageName: input.packageName, orgId: input.orgId, digest: mat.digest });

    // Record the requested grant + auto-approve AFTER the gate proved the new
    // digest activatable, so a failed update never resets/re-approves the previous
    // install's grant. Auto-approve follows the capability split:
    // only a `trusted-signed` package (`autoGrantPrivileged`) self-grants its
    // requested ports — a bootstrap/untrusted install records the request but stays
    // PENDING for an admin.
    await deps.recordRequestedGrant({ packageName: input.packageName, orgId: input.orgId, requestedPorts });

    if (autoGrantPrivileged) {
      await deps.approveGrant({
        packageName: input.packageName,
        orgId: input.orgId,
        approvedPorts: requestedPorts,
        requestedPorts,
        approvedBy: input.actorUserId ?? "system:auto-trusted-signed",
      });
      grantStatus = "approved";
    }
    await deps.advanceInstallOpPhase?.({ installOpId, phase: "granted" });

    // Apply the extension's declared, host-run node-pg-migrate migrations
    // (`cinatra.migrationsDir`, #118) BEFORE finalize — a failed migration
    // THROWS here, so the journal never reaches `finalized` and the trust
    // anchor refuses the row (no partial install looks trusted). Gated on
    // `autoGrantPrivileged` (the capability split): running host DDL is a
    // privileged capability, so it requires `trusted-signed` — never a
    // bootstrap-only or untrusted install. A bootstrap / pending install
    // must NOT create extension-owned tables; its migrations run only once it
    // becomes signed-trusted+activated (the loader's trusted boot pass applies DDL
    // ONLY to signed records — see runtime-package-loader.ts). Only runs when wired
    // (the default factory does); a package that declares no migrationsDir is a
    // no-op (the common case), and the RETIRED legacy `cinatra.migrations`
    // JSON-DSL field throws fail-closed.
    if (deps.preflightMigrations) {
      // Validate-only, EVERY install: throws on the retired legacy field or a
      // malformed declaration; returns whether host migrations are declared.
      const declaresMigrations = await deps.preflightMigrations({
        storeDir: mat.storeDir,
        packageName: input.packageName,
      });
      if (declaresMigrations && !autoGrantPrivileged) {
        throw new Error(
          `[install-pipeline] ${input.packageName} declares host migrations (cinatra.migrationsDir) but this ` +
            `install is not trusted-signed — host DDL requires a verified signature (#118). Refusing to finalize: ` +
            `the migrations would never run and the install could never safely activate.`,
        );
      }
    }
    if (deps.applyMigrations && autoGrantPrivileged) {
      await deps.applyMigrations({
        storeDir: mat.storeDir,
        packageName: input.packageName,
        version: resolvedVersion,
        orgId: input.orgId,
      });
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "preflighted" });
    }

    // Provenance is written LATE — AFTER the requested grant + the auto-approve
    // (and after the pre-finalize activation gate), as the last write before the
    // journal is finalized. So a crash anywhere above leaves the row WITHOUT real
    // provenance AND WITHOUT a `finalized` journal phase, and the anchor gate
    // refuses it. Provenance + finalize land together at the tail. Binds the
    // RESOLVED concrete version (never the caller's dist-tag).
    await deps.recordProvenance({
      packageName: input.packageName,
      orgId: input.orgId,
      version: resolvedVersion,
      registryUrl,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      ...(sha256 ? { attestedSha256: sha256 } : {}),
      ...(signature ? { signature } : {}),
      ...(closureHash ? { closureHash } : {}),
    });

    // EDGE PERSISTENCE at the FINALIZE SEAM (#180): the
    // manifest's dependency edges (read EARLY above, fail-loud) land on the
    // canonical row together with the provenance, BEFORE the journal advances
    // to `finalized` — so a `finalized` install-op implies persisted edges.
    // Runs for fresh installs AND updates (an update's new manifest must
    // refresh the row's edges, or every downstream closure gate reads stale
    // truth). A throw here aborts the finalize: the catch below restores the
    // prior op on an update; a fresh install's non-finalized row is the
    // dispatcher's to roll back.
    if (dependencyEdges !== null && deps.persistDependencyEdges) {
      await deps.persistDependencyEdges({
        packageName: input.packageName,
        orgId: input.orgId,
        dependencies: dependencyEdges,
      });
    }

    // FORWARD INSTALL GATE (#180 item 5) — FRESH installs only: with the
    // candidate's edges persisted, refuse to finalize when an
    // install-blocking edge's target is not installed (edgeType-aware: peer
    // and optional edges never block). The throw routes into the existing
    // rollback (journal never `finalized`; the dispatcher drops the
    // placeholder row). An UPDATE is not gated here — the previous install
    // stays protected by the hot-update machinery, and update-time
    // constraint evaluation is the version-aware stage of #180.
    if (!isUpdate && deps.assertForwardInstallClosure) {
      await deps.assertForwardInstallClosure({
        packageName: input.packageName,
        orgId: input.orgId,
      });
    }

    // SUPERSESSION SEAM (cinatra#158): finalize through `finalizeInstallOp`, which
    // atomically demotes any prior `finalized` op for this (package, org) to
    // `superseded` and promotes THIS op — never a plain phase advance (that would
    // leave two `finalized` rows and violate the partial-unique invariant).
    await deps.finalizeInstallOp?.(installOpId);
  } catch (err) {
    // A post-begin step threw. cinatra#158 (append-only journal): `beginInstallOp`
    // above APPENDED a NEW non-finalized op for THIS attempt; it did NOT touch the
    // OLD install's `finalized` op (which still exists). So the OLD anchor is intact
    // with ZERO journal restore — we only TERMINALIZE the NEW op so it can never be
    // mistaken for the anchor and the boot sweep treats it as settled. THIS replaces
    // the deleted re-begin+re-finalize "restore choreography".
    //
    // On a FRESH install (no prior finalized op) terminalize-NEW also applies: the
    // non-finalized row is the dispatcher's to roll back via the journal-aware check;
    // terminalizing it here makes that explicit and keeps the boot sweep clean.
    try {
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "failed" });
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "rolled_back" });
    } catch (terminalizeErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[extension-install-pipeline] failed to terminalize the aborted install-op ` +
          `${installOpId} for ${input.packageName} (boot sweep will compensate it): ` +
          `${terminalizeErr instanceof Error ? terminalizeErr.message : String(terminalizeErr)}`,
      );
    }
    // The OLD install's canonical state (provenance, host-port grant, dependency
    // edges) may have been OVERWRITTEN by this attempt's late writes BEFORE the
    // throw — those are SEPARATE durable state on the canonical row / grant row that
    // the append-only journal does NOT undo. So on an UPDATE (a prior finalized op
    // existed) RESTORE the captured OLD provenance/grant/edges. Best-effort +
    // isolated; each FAILED step emits a structured operational event (cinatra#158
    // (d)) AND logs, never masking the original error. A FRESH install captured none.
    if (isUpdate) {
      // ALSO restore the OLD host-port grant — `recordRequestedGrant`/`approveGrant`
      // may have reset/re-approved it against the new ports before the throw.
      if (priorGrant && deps.restoreGrant) {
        try {
          await deps.restoreGrant({
            packageName: input.packageName,
            orgId: input.orgId,
            status: priorGrant.status as "pending" | "approved" | "revoked",
            approvedPorts: priorGrant.approvedPorts,
            requestedPortsHash: priorGrant.requestedPortsHash,
            approvedBy: priorGrant.approvedBy ?? null,
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "grant",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
      // ALSO restore the OLD provenance + dependency EDGES (#180). The tail of the
      // try block is `recordProvenance` → `persistDependencyEdges` → forward gate →
      // finalize, so a throw in that window can leave the NEW version's source/edges
      // on the canonical row while the OLD journal op anchors the OLD install — a
      // contradiction the loader's digest binding (cinatra#158) refuses, but which we
      // still re-pin to keep the canonical row coherent. Idempotent same-value
      // rewrites when the corresponding write never ran.
      if (priorSource) {
        try {
          await deps.recordProvenance({
            packageName: input.packageName,
            orgId: input.orgId,
            version: priorSource.version,
            registryUrl: priorSource.registryUrl,
            integrity: priorSource.integrity,
            contentHash: priorSource.contentHash ?? "",
            ...(priorSource.attestedSha256 ? { attestedSha256: priorSource.attestedSha256 } : {}),
            ...(priorSource.signature ? { signature: priorSource.signature } : {}),
            // cinatra#181: the prior install's closureHash MUST ride every restore —
            // sourceSwitchExtension replaces the WHOLE source object.
            ...(priorSource.closureHash ? { closureHash: priorSource.closureHash } : {}),
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "provenance",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
      if (priorEdges !== null && deps.persistDependencyEdges) {
        try {
          await deps.persistDependencyEdges({
            packageName: input.packageName,
            orgId: input.orgId,
            dependencies: priorEdges,
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "dependencies",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
    }
    throw err;
  }

  // POST-COMMIT in-process activation. The install is now FINALIZED — provenance
  // recorded, journal `finalized`, grant approved — so the trusted anchor resolves
  // the row and the loader will activate it. Pick it up in the CURRENT process
  // WITHOUT a restart.
  //
  // Routing:
  //   - FRESH install (no prior finalized op, or the new digest does NOT supersede
  //     one): plain best-effort `activateInProcess` — a throw is swallowed (the
  //     install already committed; the boot loader is the durable path). NO
  //     quarantine/rollback path. When no activator is wired (unit tests), no-op.
  //   - UPDATE (a prior finalized install exists AND the new digest differs):
  //     `activateUpdateWithRollback` — QUARANTINE the old digest, activate the NEW
  //     digest, and DURABLY ROLL BACK to the OLD version if the new digest fails
  //     live activation for ANY reason the pre-finalize probe could not predict.
  //     The pre-finalize probe is NOT the safety boundary; THIS rollback is.
  let activated = false;
  let rolledBack = false;
  // Default true so a non-rollback path (fresh install / good update) never emits a
  // spurious rollbackComplete:false. Only a rollback sets it from the activator's
  // verdict: a PARTIAL durable restore flips it to false.
  let rollbackComplete = true;
  let activationReason: string | undefined = "no-activator";

  const isSupersedingUpdate = isUpdate && priorOp!.digest !== mat.digest;

  if (isSupersedingUpdate && deps.activateUpdateWithRollback) {
    // Build the DURABLE ROLLBACK closure from the CAPTURED prior state. Runs (only)
    // when the NEW digest fails live activation: re-pins every durable axis to OLD —
    // provenance/source, the host-port grant, the dependency edges, and the install-op
    // JOURNAL. cinatra#158 (append-only): the NEW op's `finalizeInstallOp` above
    // DEMOTED the OLD finalized op to `superseded` and promoted NEW to `finalized`.
    // So the journal re-pin is NOT the deleted re-begin choreography — it is a single
    // phase flip of rows that STILL EXIST: terminalize NEW (failed→rolled_back) and
    // re-promote the OLD `superseded` row back to `finalized`. Each step is
    // best-effort + isolated; a FAILED restore step emits a structured operational
    // event (cinatra#158 (d)). The closure returns a CLEAN-vs-PARTIAL verdict (a
    // clean rollback requires EVERY applicable step to succeed); a not-applicable
    // step (no prior source / grant / dep) is NOT a failure.
    const restoreDurableAnchor = async (): Promise<{ complete: boolean; reason?: string }> => {
      const failedSteps: string[] = [];
      const recordFailure = (step: InstallDurableRestoreFailureEvent["step"], e: unknown) => {
        failedSteps.push(step);
        emitDurableRestoreFailure(deps, {
          packageName: input.packageName,
          orgId: input.orgId,
          step,
          scope: "post-commit-rollback",
          reason: e instanceof Error ? e.message : String(e),
        });
      };
      // (i-a) re-record the OLD provenance/source so the canonical row points to OLD.
      if (priorSource) {
        try {
          await deps.recordProvenance({
            packageName: input.packageName,
            orgId: input.orgId,
            version: priorSource.version,
            registryUrl: priorSource.registryUrl,
            integrity: priorSource.integrity,
            contentHash: priorSource.contentHash ?? "",
            ...(priorSource.attestedSha256 ? { attestedSha256: priorSource.attestedSha256 } : {}),
            ...(priorSource.signature ? { signature: priorSource.signature } : {}),
            ...(priorSource.closureHash ? { closureHash: priorSource.closureHash } : {}),
          });
        } catch (e) {
          recordFailure("provenance", e);
        }
      }
      // (i-b) JOURNAL re-pin (cinatra#158): terminalize the NEW op, then re-promote
      // the OLD `superseded` op back to `finalized`. With the append-only journal the
      // OLD row was never destroyed. Re-pin OLD through the ATOMIC supersession seam
      // `finalizeInstallOp(OLD)` as a SINGLE operation: in ONE transaction it demotes
      // the CURRENT finalized op for the scope (the NEW op, finalized just above) to
      // `superseded` and promotes OLD to `finalized` (with 23505 retry). This is
      // crash-atomic (codex refute finding): there is NEVER a window with ZERO
      // finalized anchors — either the transaction commits (OLD finalized, NEW
      // superseded) or it does not (NEW stays finalized — the SAFE direction; the NEW
      // digest's bytes are quarantined/restored by the activator and the loader's
      // digest binding refuses a NEW-op-vs-OLD-source mismatch). We deliberately do
      // NOT pre-terminalize NEW (that two-step left a zero-anchor crash window).
      // NEW's terminal end-state is `superseded`, which is non-anchorable + never swept.
      try {
        await deps.finalizeInstallOp?.(priorOp!.installOpId);
      } catch (e) {
        recordFailure("journal", e);
      }
      // (i-c) restore the OLD host-port grant's exact captured state.
      if (priorGrant && deps.restoreGrant) {
        try {
          await deps.restoreGrant({
            packageName: input.packageName,
            orgId: input.orgId,
            status: priorGrant.status as "pending" | "approved" | "revoked",
            approvedPorts: priorGrant.approvedPorts,
            requestedPortsHash: priorGrant.requestedPortsHash,
            approvedBy: priorGrant.approvedBy ?? null,
          });
        } catch (e) {
          recordFailure("grant", e);
        }
      }
      // (i-d) restore the OLD dependency EDGES (#180): the finalize seam above
      // persisted the NEW manifest's edges; with the OLD version re-pinned,
      // leaving them would corrupt every closure gate that reads the canonical row.
      if (priorEdges !== null && deps.persistDependencyEdges) {
        try {
          await deps.persistDependencyEdges({
            packageName: input.packageName,
            orgId: input.orgId,
            dependencies: priorEdges,
          });
        } catch (e) {
          recordFailure("dependencies", e);
        }
      }
      return failedSteps.length === 0
        ? { complete: true }
        : { complete: false, reason: `failed restore steps: ${failedSteps.join(", ")}` };
    };

    try {
      const res = await deps.activateUpdateWithRollback({
        packageName: input.packageName,
        orgId: input.orgId,
        storeDir: mat.storeDir,
        ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
        restoreDurableAnchor,
      });
      activated = res.activated;
      rolledBack = res.rolledBack ?? false;
      // On a rollback, default completeness to true ONLY when the activator
      // explicitly says so; an absent flag on a rollback is treated as INCOMPLETE
      // (fail-closed — never claim a clean rollback we cannot confirm).
      rollbackComplete = rolledBack ? res.rollbackComplete === true : true;
      activationReason = res.reason;
    } catch (err) {
      // The rollback activator itself threw (it should not — it is best-effort
      // internally). Treat as a failed-but-rolled-back update: the durable state may
      // be partially restored, but we must NOT report update success. Run the
      // durable restore directly as a last resort so OLD is re-pinned, and honor its
      // completeness verdict (a partial restore here is NOT a clean rollback).
      let lastResortComplete = false;
      try {
        const outcome = await restoreDurableAnchor();
        lastResortComplete = outcome.complete;
      } catch {
        /* already logged inside; treat as incomplete */
        lastResortComplete = false;
      }
      activated = false;
      rolledBack = true;
      rollbackComplete = lastResortComplete;
      activationReason = `update-activate-threw:${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (deps.activateInProcess) {
    try {
      const res = await deps.activateInProcess({
        packageName: input.packageName,
        orgId: input.orgId,
        storeDir: mat.storeDir,
        ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
      });
      activated = res.activated;
      activationReason = res.reason;
    } catch (err) {
      activated = false;
      activationReason = `activate-threw:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    packageName: input.packageName,
    version: resolvedVersion,
    storeDir: mat.storeDir,
    digest: mat.digest,
    integrity: mat.integrity,
    contentHash: mat.contentHash,
    requestedPorts,
    grantStatus,
    installed: true,
    activated,
    ...(rolledBack ? { rolledBack: true, rollbackComplete } : {}),
    ...(activationReason ? { reason: activationReason } : {}),
  };
}

/**
 * Read the materialized package's declared `cinatra.requestedHostPorts` from its
 * on-disk `package.json` (absent/non-array → no ports requested). Defensive
 * parse — the manifest is structurally validated at materialize time; this only
 * surfaces the ports the grant request is recorded against.
 */
async function readRequestedHostPortsFromStore(storeDir: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return [];
  }
  let manifest: { cinatra?: { requestedHostPorts?: unknown } };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return [];
  }
  const ports = manifest.cinatra?.requestedHostPorts;
  return Array.isArray(ports) ? ports.filter((p): p is string => typeof p === "string") : [];
}

/**
 * Resolve the FINAL registry identity URL — the deployment's PUBLIC registry
 * base (`registry.cinatra.ai`). This is the URL recorded as the package origin
 * (provenance) and used to classify trust, on BOTH the legacy and the gatekept
 * paths.
 *
 * It is a PUBLIC, credential-free URL: `loadDeploymentRegistryConfig()` carries
 * the read credential in the separate `publicReadToken` field, never in
 * `publicRegistryUrl`. Resolving the final identity this way (instead of via
 * `loadVerdaccioConfigForServer()`, which requires decryptable server creds)
 * keeps a gatekept consumer-only install free of any server-credential
 * dependency.
 */
async function getFinalRegistryIdentityUrl(): Promise<string> {
  const { loadDeploymentRegistryConfig } = await import("@/lib/deployment-registry-config");
  return loadDeploymentRegistryConfig().publicRegistryUrl;
}

/**
 * Wire the production install-pipeline defaults (the seam writer):
 *  - `resolveIntegrity` → `resolveExtensionDistIntegrity` (sha512 SRI root +
 *    additive sha256), authed via `loadVerdaccioConfigForServer()` on the legacy
 *    (flag-OFF) path, or via the broker grant on the gatekept (flag-ON) path —
 *    the latter requires NO server credentials and returns the FINAL registry
 *    identity (not the broker URL) for trust classification;
 *  - `materialize` → `materializePackageToStore` (the SRI-checked materializer);
 *  - `readRequestedPorts` → the manifest's `cinatra.requestedHostPorts`;
 *  - `readDeclaredCompat` → the manifest's `cinatra.sdkAbiRange` (the
 *    HOST-COMPAT GATE's basis);
 *  - `recordProvenance` → `sourceSwitchExtension` (the ONLY sanctioned provenance
 *    writer; persists the REAL integrity + content hash + the new attestedSha256);
 *  - `recordRequestedGrant` / `approveGrant` → the host-port grant store;
 *  - the install-op journal hooks → the install-ops journal store.
 *
 * The LIVE production caller is `runHostExtensionInstallAndActivate` in
 * `src/lib/extension-runtime-activate.ts`: the
 * `extensions_install` dispatch hook resolves the canonical verdaccio row, then
 * calls `makeDefaultInstallPipelineDeps()` + `installExtensionFromRegistry(...)`
 * to drive the REAL-integrity pipeline against the real registry. This factory
 * also exists so the DI defaults are wired + unit-testable.
 */
export async function makeDefaultInstallPipelineDeps(): Promise<InstallPipelineDeps> {
  const { resolveExtensionDistIntegrity } = await import("@cinatra-ai/registries");
  const { materializePackageToStore } = await import("@/lib/extension-package-store");
  const { recordRequestedGrant, approveGrant, readGrantForScope, restoreGrant } = await import("@/lib/extension-host-port-grants");
  const { beginInstallOp, advanceInstallOpPhase, finalizeInstallOp, readInstallOp } = await import("@/lib/extension-install-ops");
  const { readInstalledExtensionsByPackageName } = await import("@cinatra-ai/extensions/canonical-store");
  const { sourceSwitchExtension } = await import("@cinatra-ai/extensions/lifecycle-primitive");
  const { pickSingleActiveRow } = await import("@/lib/extension-install-anchor");
  const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig } = await import("@/lib/gatekept-install");

  // Gatekept install: when ON, resolveIntegrity + materialize fetch
  // through the marketplace broker read-proxy (grant as token, broker base as
  // registry). pacote still re-verifies the sha512 SRI over the downloaded
  // bytes on EVERY path. Provenance + trust classification, however, see the
  // FINAL `registry.cinatra.ai` identity (NOT the broker URL) — the broker is
  // only a delivery mechanism.
  //
  // The final registry identity is the deployment's PUBLIC registry URL — a
  // public, credential-free URL (`loadDeploymentRegistryConfig().publicRegistryUrl`;
  // the read credential lives in the separate `publicReadToken` field, never in
  // this URL). Resolving it this way means a gatekept (consumer-only) install
  // NEVER needs server registry credentials. `loadVerdaccioConfigForServer()`
  // (which DOES require server creds) is only loaded LAZILY inside the legacy
  // flag-OFF branches below — so the flag-OFF path is byte-for-byte unchanged
  // and the flag-ON path stays credential-free.
  const finalRegistryUrl = await getFinalRegistryIdentityUrl();

  // Lazy server-cred loader for the legacy (flag-OFF) direct-read path ONLY.
  // Never invoked when gatekept install is ON.
  const loadServerRegistryConfig = async () => {
    const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
    return loadVerdaccioConfigForServer();
  };

  return {
    resolveIntegrity: async (packageName, version) => {
      if (isGatekeptInstallEnabled()) {
        // Broker-pointed config: registryUrl = broker base, token = opaque grant.
        // We fetch the packument THROUGH the broker to read dist.integrity, but
        // the returned `registryUrl` MUST be the FINAL registry identity — the
        // upper orchestration classifies trust from this URL (a trusted
        // first-party package would otherwise be mis-classified UNTRUSTED
        // because broker base != registry.cinatra.ai). SRI is unchanged: the
        // sha512 dist.integrity read through the broker is the same digest the
        // registry serves, and pacote re-verifies it over the bytes.
        const { config } = await resolveGatekeptInstallConfig(packageName, version);
        const resolved = await resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
        return { ...resolved, registryUrl: finalRegistryUrl };
      }
      const config = await loadServerRegistryConfig();
      return resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
    },
    materialize: async (i) => {
      // Gatekept install: fetch the tarball bytes through the broker
      // read-proxy (grant as token, broker base as registry). pacote enforces
      // the sha512 SRI over the downloaded bytes; materializePackageToStore
      // ALSO re-verifies the SRI before writing — integrity is never weakened by
      // routing through the broker. The `registryUrl` PERSISTED on the store
      // sidecar is overridden to the FINAL registry (the broker is delivery, not
      // origin — same rule recordProvenance enforces). When OFF, the default
      // fetch path (real registry) runs unchanged.
      let fetchTarball: import("@/lib/extension-package-store").FetchTarball | undefined;
      let persistRegistryUrl = i.registryUrl;
      if (isGatekeptInstallEnabled()) {
        const { config } = await resolveGatekeptInstallConfig(i.packageName, i.version);
        const { fetchExtensionTarballBytes } = await import("@cinatra-ai/registries");
        fetchTarball = (input) =>
          fetchExtensionTarballBytes(
            {
              packageName: input.packageName,
              packageVersion: input.packageVersion,
              expectedIntegrity: input.expectedIntegrity,
            },
            config,
          );
        persistRegistryUrl = finalRegistryUrl;
      }
      const mat = await materializePackageToStore(
        {
          packageName: i.packageName,
          version: i.version,
          expectedIntegrity: i.expectedIntegrity,
          registryUrl: persistRegistryUrl,
          storeRoot: i.storeRoot,
          // cinatra#181: the parsed plan + verified closureHash thread into the
          // materializer (step 4.7); per-node fetches ride the SAME fetchTarball
          // seam built above, so a gatekept install's plan nodes keep the broker
          // grant/identity (codex round-0 finding 7).
          plan: i.plan ?? null,
          expectedClosureHash: i.expectedClosureHash ?? null,
        },
        fetchTarball ? { fetchTarball } : {},
      );
      return { storeDir: mat.storeDir, digest: mat.digest, integrity: mat.integrity, contentHash: mat.contentHash };
    },
    readRequestedPorts: (storeDir) => readRequestedHostPortsFromStore(storeDir),
    // HOST-COMPAT GATE basis: the materialized manifest's `cinatra.sdkAbiRange`
    // (verified bytes — same basis as readRequestedPorts above).
    readDeclaredCompat: async (storeDir) => {
      const { readDeclaredHostCompatFromStore } = await import("@/lib/extension-host-compat");
      return readDeclaredHostCompatFromStore(storeDir);
    },
    // DEPENDENCY EDGES (#180): dual-read over the materialized manifest
    // (canonical `cinatra.dependencies` wins; legacy `cinatra.agentDependencies`
    // projected; conflict/malformed = fail-loud throw).
    readDependencyEdges: async (storeDir) => {
      const { readManifestDependencyEdgesFromStore } = await import(
        "@cinatra-ai/extensions/manifest-dependencies"
      );
      const { edges } = await readManifestDependencyEdgesFromStore(storeDir);
      return edges;
    },
    // EDGE PERSISTENCE at the finalize seam: the sanctioned canonical writer,
    // bound to the SAME single (package, org) row the provenance write resolved.
    persistDependencyEdges: async (p) => {
      const rows = await readInstalledExtensionsByPackageName(p.packageName);
      const target = pickSingleActiveRow(rows, p.orgId);
      if (!target) {
        throw new Error(
          `persistDependencyEdges: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      const { recordExtensionDependencies } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await recordExtensionDependencies(target.id, p.dependencies, {
        actor: { source: "runtime-installer" },
        reason: `manifest dependency edges @ install`,
      });
    },
    // FORWARD INSTALL GATE (#180 item 5): edgeType-aware closure check over the
    // canonical snapshot, scoped to the install's org.
    assertForwardInstallClosure: async (p) => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      const { assertForwardInstallClosureForPackage } = await import(
        "@cinatra-ai/extensions/dependency-closure"
      );
      const allRows = await listInstalledExtensions({});
      assertForwardInstallClosureForPackage(p.packageName, allRows, {
        organizationId: p.orgId,
      });
    },
    recordProvenance: async (p) => {
      // The ONLY sanctioned provenance writer is sourceSwitchExtension (it
      // re-validates the source then writes via the lifecycle path). Resolve the
      // canonical row for the SAME (package, org) scope the journal + grant use,
      // so a multi-org package never records one org's source against another
      // org's finalized journal/grant (the trust gate must resolve ONE row).
      const rows = await readInstalledExtensionsByPackageName(p.packageName);
      // Exactly ONE active row must match this (package, org) scope; 0 or >1
      // (ambiguous owner scope) fails closed — provenance must bind the single row
      // the anchor will later resolve, never an arbitrary owner's install.
      const target = pickSingleActiveRow(rows, p.orgId);
      if (!target) {
        throw new Error(
          `recordProvenance: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      // Gatekept install: provenance records the FINAL
      // `registry.cinatra.ai` identity + the verified SRI, NEVER the broker URL.
      // The broker is a delivery mechanism; recording its URL as the package
      // origin would corrupt the trust anchor (the loader classifies trust on
      // the registry URL). When OFF, `p.registryUrl` is already the real
      // registry, so this is a no-op substitution.
      const provenanceRegistryUrl = isGatekeptInstallEnabled() ? finalRegistryUrl : p.registryUrl;
      await sourceSwitchExtension(
        target.id,
        {
          type: "verdaccio",
          registryUrl: provenanceRegistryUrl,
          packageName: p.packageName,
          version: p.version,
          integrity: p.integrity,
          contentHash: p.contentHash,
          ...(p.attestedSha256 ? { attestedSha256: p.attestedSha256 } : {}),
          ...(p.signature ? { signature: p.signature } : {}),
          ...(p.closureHash ? { closureHash: p.closureHash } : {}),
        },
        { actor: { source: "runtime-installer" }, reason: `runtime install provenance @ ${p.version}` },
      );
    },
    applyMigrations: async (i) => {
      const { applyExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
      await applyExtensionMigrationsFromStore({
        storeDir: i.storeDir,
        packageName: i.packageName,
        packageVersion: i.version,
      });
    },
    preflightMigrations: async (i) => {
      const { preflightExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
      const pre = await preflightExtensionMigrationsFromStore({
        storeDir: i.storeDir,
        packageName: i.packageName,
      });
      return pre !== null;
    },
    recordRequestedGrant: (g) =>
      recordRequestedGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        requestedPorts: g.requestedPorts as readonly HostPortName[],
      }).then(() => undefined),
    approveGrant: (g) =>
      approveGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        approvedPorts: g.approvedPorts as readonly HostPortName[],
        requestedPorts: g.requestedPorts as readonly HostPortName[],
        approvedBy: g.approvedBy,
      }).then(() => undefined),
    // The hot-UPDATE probe's EFFECTIVE-ports basis for a non-auto-grant
    // (bootstrap/untrusted) install: the EXACT-(package, org)-scoped grant ROW
    // (status + approvedPorts + requestedPortsHash), with NO global fallback — the
    // SAME exact-scope resolution `resolveInstallAnchor` uses for its port decision
    // (it refuses a cross-scope global grant). The pipeline then counts the ports
    // only when this grant is approved AND its requestedPortsHash still matches the
    // in-flight request (mirroring `recordRequestedGrant`'s reset-on-change rule).
    readGrantForScope: async (packageName, orgId) => {
      const g = await readGrantForScope({ packageName, orgId });
      return g
        ? {
            orgId: g.orgId,
            status: g.status,
            approvedPorts: g.approvedPorts,
            requestedPortsHash: g.requestedPortsHash,
            approvedBy: g.approvedBy,
          }
        : null;
    },
    // DURABLE ROLLBACK: re-write the OLD grant row to its captured state.
    restoreGrant: (i) =>
      restoreGrant({
        packageName: i.packageName,
        orgId: i.orgId,
        status: i.status,
        approvedPorts: i.approvedPorts,
        requestedPortsHash: i.requestedPortsHash,
        approvedBy: i.approvedBy,
      }).then(() => undefined),
    // CAPTURE: read the CURRENT canonical verdaccio source for the EXACT
    // (package, org) scope the journal + grant use — captured BEFORE recordProvenance
    // overwrites it, so the post-commit rollback can re-record the OLD source.
    readCurrentSource: async (packageName, orgId) => {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const target = pickSingleActiveRow(rows, orgId);
      const src = target?.source;
      if (!src || (src as { type?: string }).type !== "verdaccio") return null;
      const v = src as {
        registryUrl: string;
        version: string;
        integrity: string;
        contentHash?: string;
        attestedSha256?: string;
        signature?: string;
        closureHash?: string;
      };
      return {
        registryUrl: v.registryUrl,
        version: v.version,
        integrity: v.integrity,
        ...(v.contentHash ? { contentHash: v.contentHash } : {}),
        ...(v.attestedSha256 ? { attestedSha256: v.attestedSha256 } : {}),
        ...(v.signature ? { signature: v.signature } : {}),
        ...(v.closureHash ? { closureHash: v.closureHash } : {}),
      };
    },
    // CAPTURE (#180): the prior canonical row's persisted dependency edges —
    // restored by both unwind paths when an UPDATE fails after the finalize
    // seam overwrote them with the new manifest's edges.
    readCurrentDependencies: async (packageName, orgId) => {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const target = pickSingleActiveRow(rows, orgId);
      return target ? target.dependencies : null;
    },
    beginInstallOp: (b) => beginInstallOp(b).then(() => undefined),
    advanceInstallOpPhase: (a) => advanceInstallOpPhase(a).then(() => undefined),
    // cinatra#158: the SUPERSESSION seam — atomic demote-OLD + promote-NEW.
    finalizeInstallOp: (id) => finalizeInstallOp(id).then(() => undefined),
    readInstallOp: (pkg, oid) => readInstallOp(pkg, oid),
    verifyActivatableBeforeFinalize: async (i) => {
      // Detect supersession: any materialized store dir for this package that is
      // NOT the just-installed current digest = a prior digest (an UPDATE). A
      // fresh install has none → no pre-finalize gate (supersedes:false).
      const { discoverSupersededStoreDirsForPackage, verifyDigestImportsAndRegisters } = await import(
        "@/lib/extension-runtime-activate"
      );
      const { DEFAULT_PACKAGE_STORE_PATH } = await import("@cinatra-ai/sdk-extensions");
      const storeRoot = i.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;
      const superseded = await discoverSupersededStoreDirsForPackage(i.packageName, storeRoot, i.storeDir);
      if (superseded.length === 0) return { supersedes: false };
      const verdict = await verifyDigestImportsAndRegisters(i.packageName, storeRoot, i.storeDir, {
        integrity: i.integrity,
        contentHash: i.contentHash,
        approvedPorts: i.approvedPorts,
      });
      return verdict.ok ? { supersedes: true, ok: true } : { supersedes: true, ok: false, reason: verdict.reason };
    },
    gcStoreDir: async (storeDir) => {
      const { rm } = await import("node:fs/promises");
      await rm(storeDir, { recursive: true, force: true });
      await rm(`${storeDir}.tgz`, { force: true }).catch(() => undefined);
    },
    activateInProcess: async (i) => {
      const { activateInstalledPackageInProcess, summarizeActivation } = await import("@/lib/extension-runtime-activate");
      const results = await activateInstalledPackageInProcess(i.packageName, i.orgId, {
        currentStoreDir: i.storeDir,
        ...(i.storeRoot ? { storeRoot: i.storeRoot } : {}),
      });
      // Shared verdict: the loader emits ONE result per phase (register, then
      // bootstrap), so success requires a registration AND no failure — a fresh
      // install whose bootstrap throws must report activated:false, not true. Reuse
      // summarizeActivation so this rule never drifts from the hot-update path.
      // (Non-fatal: a fresh install has no prior version to roll back to.)
      const { activated, reason } = summarizeActivation(results, i.packageName);
      return reason === undefined ? { activated } : { activated, reason };
    },
    // The atomic hot-update activator with durable-rollback-first.
    activateUpdateWithRollback: async (i) => {
      const { hotUpdateWithDurableRollback } = await import("@/lib/extension-runtime-activate");
      return hotUpdateWithDurableRollback(
        i.packageName,
        i.orgId,
        i.storeDir,
        { restoreDurableAnchor: i.restoreDurableAnchor },
        { ...(i.storeRoot ? { storeRoot: i.storeRoot } : {}) },
      );
    },
    // cinatra#158 (d): the structured operational-event sink. No central event bus
    // backs the install path, so the default is the stable structured console
    // emitter (the same surface the hot-update rollbackComplete signal uses). Ops
    // alerting keys on `event: "install_durable_restore_failed"`.
    emitOperationalEvent: (event) => {
      // eslint-disable-next-line no-console
      console.error(`[operational-event] ${JSON.stringify(event)}`);
    },
  };
}

/**
 * Fully-wired INERT `InstallPipelineDeps` for unit tests (cinatra#158 (c)). Every
 * one of the now-REQUIRED deps gets a safe no-op/in-memory default; spread
 * `overrides` to swap in the specific behaviors a test exercises. This keeps test
 * call sites terse now that the deps are no longer individually optional. The
 * inert defaults intentionally disable the saga/gate machinery (no journal, no
 * activation, no compensation) — exactly the "omit it" behavior tests relied on
 * when these fields were optional, but now type-safe and explicit.
 */
export function makeTestInstallPipelineDeps(
  overrides: Partial<InstallPipelineDeps> = {},
): InstallPipelineDeps {
  const noop = async (): Promise<void> => undefined;
  const base: InstallPipelineDeps = {
    resolveIntegrity: async () => ({ integrity: "sha512-test", registryUrl: "https://registry.test" }),
    materialize: async (i) => ({
      storeDir: `/tmp/test-store/${i.packageName}/${i.version}`,
      digest: "testdigest",
      integrity: i.expectedIntegrity,
      contentHash: "testcontenthash",
    }),
    readRequestedPorts: async () => [],
    readDeclaredCompat: async () => ({ sdkAbiRange: null }),
    recordProvenance: noop,
    recordRequestedGrant: noop,
    approveGrant: noop,
    readGrantForScope: async () => null,
    restoreGrant: noop,
    applyMigrations: noop,
    preflightMigrations: async () => false,
    beginInstallOp: noop,
    advanceInstallOpPhase: noop,
    finalizeInstallOp: noop,
    readInstallOp: async () => null,
    readCurrentSource: async () => null,
    readCurrentDependencies: async () => null,
    activateInProcess: async () => ({ activated: false, reason: "no-activator" }),
    activateUpdateWithRollback: async () => ({ activated: false, reason: "no-activator" }),
    verifyActivatableBeforeFinalize: async () => ({ supersedes: false }),
    gcStoreDir: noop,
    readDependencyEdges: async () => [],
    persistDependencyEdges: noop,
    assertForwardInstallClosure: noop,
    emitOperationalEvent: () => undefined,
  };
  return { ...base, ...overrides };
}
