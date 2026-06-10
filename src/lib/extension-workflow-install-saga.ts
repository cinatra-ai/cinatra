import "server-only";

// Atomic install saga for a kind:"workflow" extension.
//
// The saga is transactional across the two pg pools (workflows + dashboards),
// sources its sidecars from the integrity-verified package store, materializes
// per-project dashboard instances, and has a journal / rollback / idempotent
// finalize:
//
//   withInstallLock(packageName):
//     begin → MATERIALIZE → GRANTED → PREFLIGHT-ALL → writes → recordProvenance
//     → FINALIZE          (the `finalized` journal phase is the PRIMARY
//                          activatability gate `resolveInstallAnchor` reads)
//
// MODEL-B (governing rule): workflow extension CODE is NOT executed here — the
// host compiles `cinatra/workflow.bpmn` and validates `cinatra/dashboard.json`
// DECLARATIVELY. No host-SDK peer is bundled or shared. The single model-B edge
// is that sidecars are read from the integrity-verified PACKAGE STORE
// (`mat.storeDir` — SRI-checked + symlink-rejected by the materializer), NOT the
// dev checkout — so there is no `CINATRA_RUNTIME_MODE==="development"` fail-closed.
//
// PREFLIGHT-ALL runs BEFORE any write: (a) BPMN compile, (b) dashboard v1.2 WITH
// the typed-portlet registry (closes the legacy "validate-without-registry" gap
// so the kind/version check fails the install ahead of WRITE 1), (c) the cube
// guard (unknown cube ⇒ reject; declared cube contributions ⇒ requires-rebuild —
// a distinct surfaced state, NOT a partial install), (d) migration-spec validate
// (validate-only; applying migrations is a separate step). A throw anywhere
// triggers an INVERSE-ORDER compensating rollback (archive dashboards → delete the
// just-created workflow_template — never a pre-existing template on a re-install)
// then marks the journal `rolled_back`, log-and-continue per step so a failed
// compensation never masks the original error.
//
// The driver is fully DEPENDENCY-INJECTED (journal, materialize, sidecar reads,
// the workflow/dashboard writers, the trust/grant/provenance hooks) so it is
// unit-testable without a registry or a DB. `makeDefaultWorkflowInstallSagaDeps`
// wires the real host primitives. The production caller IS wired — the host injects
// the saga (extensions.ts) and the workflows extension-handler delegates installs to
// it; `runHostExtensionInstallAndActivate` drives the integrity pipeline.

import { classifyExtensionTrust } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import {
  evaluateHostSdkCompat,
  formatHostSdkCompatRefusal,
} from "@/lib/extension-host-compat";

// ---------------------------------------------------------------------------
// Errors that map a preflight verdict to a distinct surfaced state.
// ---------------------------------------------------------------------------

/** A cube-guard `requires-rebuild` verdict — the extension declares new cube
 *  contributions, which can only register at a static boot pass. Surfaced as a
 *  DISTINCT state, never a partial install. */
export class WorkflowInstallRequiresRebuildError extends Error {
  readonly code = "REQUIRES_REBUILD";
  readonly offendingCubes: string[];
  constructor(message: string, offendingCubes: string[]) {
    super(message);
    this.name = "WorkflowInstallRequiresRebuildError";
    this.offendingCubes = offendingCubes;
  }
}

/** A fail-closed preflight rejection (bad BPMN, unknown portlet kind, unknown
 *  cube reference, invalid migration spec) — refused BEFORE any write. */
export class WorkflowInstallPreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkflowInstallPreflightError";
  }
}

// ---------------------------------------------------------------------------
// DI surface
// ---------------------------------------------------------------------------

export type WorkflowInstallSagaInput = {
  packageName: string;
  version?: string;
  actor: { userId?: string | null; orgId?: string | null };
};

/** The compiled, ready-to-write artifacts the preflight produces from the store. */
export type WorkflowInstallPreflightResult = {
  /** The parsed+compiled workflow template manifest (the first write payload). */
  manifest: unknown;
  /** The parsed dashboard config, or null when the extension ships no dashboard. */
  dashboardConfig: unknown | null;
};

export type WorkflowInstallSagaDeps = {
  // -- lock --------------------------------------------------------------
  /** Serialize the saga under the package's install lock (re-entrant; nests under
   *  the global lifecycle lock). The default is `@cinatra-ai/agents`'s. */
  withInstallLock: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;

  // -- journal -----------------------------------------------------------
  beginInstallOp: (input: { installOpId: string; packageName: string; orgId: string | null; digest?: string | null }) => Promise<void>;
  advanceInstallOpPhase: (input: { installOpId: string; phase: "materialized" | "granted" | "preflighted" | "writing" | "finalized" | "failed" | "rolled_back"; digest?: string | null }) => Promise<void>;
  finalizeInstallOp: (installOpId: string) => Promise<void>;
  failInstallOp: (installOpId: string) => Promise<void>;
  /** Read the current op's phase + id for (package, org) — drives the
   *  idempotent short-circuit (a finalized op for the SAME artifact → no-op). */
  readInstallOp: (packageName: string, orgId: string | null) => Promise<{ phase: string; installOpId: string } | null>;

  // -- materialize -------------------------------------------------------
  /** Resolve the tarball SRI + the registry it lives on (root of trust) + the optional signature. */
  resolveIntegrity: (packageName: string, version: string) => Promise<{ integrity: string; registryUrl: string; sha256?: string; signature?: string | null; resolvedVersion?: string }>;
  /** Materialize the SRI-verified tarball into the on-disk store. */
  materialize: (input: { packageName: string; version: string; expectedIntegrity: string; registryUrl: string }) => Promise<{ storeDir: string; digest: string; integrity: string; contentHash: string }>;

  // -- preflight (ALL read from the materialized storeDir) ---------------
  /** Read+compile the BPMN sidecar + dashboard.json from the storeDir, run the
   *  typed-portlet-registry v1.2 check + the cube guard + the migration-spec
   *  validate. Throws `WorkflowInstallPreflightError` /
   *  `WorkflowInstallRequiresRebuildError` on any fail-closed verdict. */
  preflightFromStore: (input: { storeDir: string; packageName: string; version?: string }) => Promise<WorkflowInstallPreflightResult>;

  // -- writes ------------------------------------------------------------
  /** WRITE 1: upsert the workflow_template. Returns the template id AND whether
   *  the row already existed (`wasReinstall` — the upsert created nothing new, so
   *  rollback must NOT delete it). */
  installWorkflowTemplate: (input: { manifest: unknown; orgId: string; userId: string; packageName: string }) => Promise<{ templateId: string; wasReinstall: boolean }>;
  /** WRITE 2: upsert the dashboard TEMPLATE row. */
  materializeDashboardTemplate: (input: { packageName: string; orgId: string; userId: string; config: unknown }) => Promise<void>;
  /** The org's project ids — the per-project instance fan-out basis. Derived
   *  HOST-side from session/org, never from package-supplied fields. */
  listOrgProjectIds: (orgId: string) => Promise<string[]>;
  /** WRITE 3: clone the dashboard template into a per-project INSTANCE.
   *  Idempotent on (extension, org, project). */
  materializeInstanceForProject: (input: { packageName: string; orgId: string; userId: string; projectId: string }) => Promise<void>;
  /** WRITE 4: reactivate any previously-archived template+instances (re-install). */
  restoreDashboards: (input: { packageName: string; orgId: string; userId: string }) => Promise<void>;

  // -- provenance + grant (LATE) -----------------------------------------
  /** Read the materialized package's declared `cinatra.requestedHostPorts`. */
  readRequestedPorts: (storeDir: string) => Promise<string[]>;
  /** Read the materialized package's declared host/SDK compatibility range
   *  (`cinatra.sdkAbiRange`) — the HOST-COMPAT GATE's basis. Optional so existing
   *  unit tests can omit it (then no install-time compat gate runs); the default
   *  factory always wires it. */
  readDeclaredCompat?: (storeDir: string) => Promise<{ sdkAbiRange: string | null }>;
  /** GC a just-materialized store dir (+ its sibling `.tgz`) after a HOST-COMPAT
   *  refusal, so an incompatible digest never lingers to trip the boot
   *  duplicate-name gate. Best-effort. Optional; the default factory wires `rm`. */
  gcStoreDir?: (storeDir: string) => Promise<void>;
  recordRequestedGrant: (input: { packageName: string; orgId: string | null; requestedPorts: string[] }) => Promise<void>;
  approveGrant: (input: { packageName: string; orgId: string | null; approvedPorts: string[]; requestedPorts: string[]; approvedBy: string }) => Promise<void>;
  /** Persist the REAL provenance (sha512 integrity + content hash + the additive
   *  sha256 attestation) on the canonical row — LATE, just before finalize. */
  recordProvenance: (input: { packageName: string; orgId: string | null; version: string; registryUrl: string; integrity: string; contentHash: string; attestedSha256?: string; signature?: string | null }) => Promise<void>;

  // -- compensation (inverse-order rollback inverses) --------------------
  /** Inverse of WRITE 2/3/4 — archive the extension's dashboards (rows preserved). */
  archiveDashboards: (input: { packageName: string; orgId: string; userId: string }) => Promise<void>;
  /** Inverse of WRITE 1 — hard-delete the workflow_template (refuses an in-use one). */
  deleteWorkflowTemplate: (templateId: string) => Promise<{ deleted: boolean }>;
};

export type WorkflowInstallSagaResult = {
  status: "installed" | "already-finalized";
  /** The RESOLVED concrete version the install bound to (a dist-tag input resolved). */
  version?: string;
  templateId?: string;
  dashboardMaterialized: boolean;
};

function actorOrgGuard(actor: WorkflowInstallSagaInput["actor"]): { userId: string; orgId: string } {
  if (!actor.orgId || !actor.userId) {
    throw new WorkflowInstallPreflightError("MISSING_ORG_CONTEXT", "Missing organization context for the workflow install.");
  }
  return { userId: actor.userId, orgId: actor.orgId };
}

// ---------------------------------------------------------------------------
// The saga driver
// ---------------------------------------------------------------------------

/**
 * Drive the atomic workflow-extension install.
 *
 * Idempotent: a `finalized` journal op for (package, org) short-circuits to a
 * no-op; a `started`/`materialized`/`granted`/`preflighted` op re-converges (the
 * underlying writes are ON-CONFLICT idempotent). On any throw the saga runs the
 * inverse-order compensating rollback then marks the op `rolled_back` and
 * re-throws the ORIGINAL error.
 */
export async function installWorkflowExtensionSaga(
  input: WorkflowInstallSagaInput,
  deps: WorkflowInstallSagaDeps,
): Promise<WorkflowInstallSagaResult> {
  const { userId, orgId } = actorOrgGuard(input.actor);
  const { packageName } = input;
  const requestedVersion = input.version ?? "0.0.0";

  return deps.withInstallLock(packageName, async () => {
    // Resolve the artifact identity (a dist-tag → its concrete version, plus the
    // tarball integrity + signature) BEFORE journaling, so the install-op id, the
    // idempotency check, materialize, the signature verdict, AND provenance all
    // bind the RESOLVED version. Keying any of them on the caller's (possibly
    // dist-tag) input would let a re-pointed tag wrongly short-circuit idempotency
    // or verify a signature against the wrong version. A resolveIntegrity failure
    // throws here, before any journal row exists (nothing to compensate).
    const { integrity, registryUrl, sha256, signature, resolvedVersion: resolvedFromRegistry } =
      await deps.resolveIntegrity(packageName, requestedVersion);
    const version = resolvedFromRegistry ?? requestedVersion;

    const installOpId = `${packageName}@${version}:wf:${orgId}`;

    // Idempotent ONLY for the SAME artifact: a finalized op for THIS exact
    // (package, RESOLVED version, org) is a no-op; a finalized op for a DIFFERENT
    // resolved version must NOT short-circuit (a version update — including a
    // re-pointed dist-tag — has to re-materialize → preflight → write its new
    // template/dashboards), so we compare the install-op id.
    const existing = await deps.readInstallOp(packageName, orgId);
    if (existing?.phase === "finalized" && existing.installOpId === installOpId) {
      return { status: "already-finalized", version, dashboardMaterialized: false };
    }

    // Track what THIS attempt created so compensation never deletes a pre-existing
    // row on a re-install rollback. `enteredDashboardWrites` flips to true the
    // moment the dashboard-write region is reached — BEFORE the template write
    // can succeed — so a throw mid-region (a partial template/instance write) is
    // still archived on rollback (`archiveExtensionDashboards` is a safe no-op
    // when nothing was written).
    let createdTemplateId: string | null = null;
    let enteredDashboardWrites = false;

    // 1. MATERIALIZE — SRI-verify + unpack into the store (identity resolved
    // above). Runs BEFORE `beginInstallOp`: materialize writes only the package
    // store (no shared durable state — the same ordering the registry install
    // pipeline uses), which lets the HOST-COMPAT GATE below refuse an
    // incompatible package while the journal is still untouched. Without this
    // ordering, `beginInstallOp` would have already overwritten the single
    // (package, org) journal row, so a refused UPDATE would destroy the
    // previous install's `finalized` op (the trust anchor's requirement) even
    // though its template/dashboards/provenance were never touched.
    const mat = await deps.materialize({ packageName, version, expectedIntegrity: integrity, registryUrl });

    // 1.5 HOST-COMPAT GATE — the extension → host/SDK half of the
    // compatibility contract, at the EARLIEST point the verified manifest
    // exists (the same verdict both loaders gate activation on). A workflow
    // package whose declared `cinatra.sdkAbiRange` this host's frozen SDK ABI
    // does not satisfy is REFUSED here — BEFORE the journal begin, the grant
    // request, preflight, and any workflow_template/dashboard writes — so the
    // refusal is fully inert: a prior install's `finalized` journal op, grant,
    // provenance, template and dashboards are all untouched. The
    // just-materialized dir is GC'd (best-effort). It can never be the LIVE
    // install's dir: a finalized op at the SAME resolved version already
    // short-circuited above, so a refusal here is always a DIFFERENT version →
    // a different digest dir. Undeclared/"*" is unpinned → allowed;
    // malformed/unsatisfied fails closed.
    if (deps.readDeclaredCompat) {
      const declared = await deps.readDeclaredCompat(mat.storeDir);
      if (!evaluateHostSdkCompat(declared.sdkAbiRange).compatible) {
        if (deps.gcStoreDir) {
          try {
            await deps.gcStoreDir(mat.storeDir);
          } catch {
            /* best-effort GC — a leftover dir is recovered by a later retry. */
          }
        }
        throw new WorkflowInstallPreflightError(
          "HOST_SDK_INCOMPATIBLE",
          formatHostSdkCompatRefusal({
            op: existing?.phase === "finalized" ? "update" : "install",
            packageName,
            version,
            sdkAbiRange: declared.sdkAbiRange,
          }),
        );
      }
    }

    await deps.beginInstallOp({ installOpId, packageName, orgId });

    try {
      await deps.advanceInstallOpPhase({ installOpId, phase: "materialized", digest: mat.digest });

      // 2. TRUST GATE (incl signature) — classify ONCE. A workflow install
      // must REFUSE here, BEFORE preflight + any workflow_template/dashboard
      // writes, when the package is not trusted (e.g. unsigned / invalid
      // signature under CINATRA_EXTENSION_REQUIRE_SIGNATURES). Never write
      // artifacts or finalize for an untrusted package.
      const requestedPorts = await deps.readRequestedPorts(mat.storeDir);
      await deps.recordRequestedGrant({ packageName, orgId, requestedPorts });
      const verdict = classifyExtensionTrust({
        packageName,
        registryUrl,
        integrityVerified: true,
        persistedTrustDecision: true,
        signatureVerified: resolveSignatureVerdict({ packageName, version, integrity, signature }),
        trustedActivationHosts: trustedActivationHosts(),
        allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
      });
      if (!verdict.trusted) {
        throw new WorkflowInstallPreflightError(
          "UNTRUSTED",
          `${packageName}@${version}: refused by the trust/signature gate before any writes`,
        );
      }
      // Capability split: auto-approve the requested host-port grant
      // ONLY for a `trusted-signed` package. A `trusted-bootstrap` workflow package
      // still installs (import-trust lets its template/dashboards write), but its
      // requested ports stay PENDING for an admin — privileged capability is never
      // silently widened to a merely-bootstrap-trusted multi-vendor package.
      if (verdict.tier === "trusted-signed") {
        await deps.approveGrant({ packageName, orgId, approvedPorts: requestedPorts, requestedPorts, approvedBy: userId });
      }
      await deps.advanceInstallOpPhase({ installOpId, phase: "granted" });

      // 3. PREFLIGHT-ALL — against the integrity-verified storeDir, BEFORE writes.
      const preflight = await deps.preflightFromStore({ storeDir: mat.storeDir, packageName, version });
      await deps.advanceInstallOpPhase({ installOpId, phase: "preflighted" });

      // 4. WRITE 1 — workflow_template (track wasReinstall for the rollback guard).
      const tpl = await deps.installWorkflowTemplate({ manifest: preflight.manifest, orgId, userId, packageName });
      if (!tpl.wasReinstall) createdTemplateId = tpl.templateId;

      // 5. WRITE 2/3/4 — dashboard template + per-project instances + restore.
      let dashboardWritten = false;
      if (preflight.dashboardConfig != null) {
        // Flip BEFORE the first dashboard write so a throw mid-write still archives
        // any partial rows on rollback. Persist the `writing` phase too, so a
        // process killed from here on is recognized at boot as "may have written
        // dashboards" (boot-orphan cleanup archives ONLY for `writing`).
        enteredDashboardWrites = true;
        await deps.advanceInstallOpPhase({ installOpId, phase: "writing" });
        await deps.materializeDashboardTemplate({ packageName, orgId, userId, config: preflight.dashboardConfig });
        dashboardWritten = true;
        const projectIds = await deps.listOrgProjectIds(orgId);
        for (const projectId of projectIds) {
          await deps.materializeInstanceForProject({ packageName, orgId, userId, projectId });
        }
        await deps.restoreDashboards({ packageName, orgId, userId });
      }

      // 6. recordProvenance LATE + FINALIZE (the activatability transition).
      await deps.recordProvenance({
        packageName,
        orgId,
        version,
        registryUrl,
        integrity: mat.integrity,
        contentHash: mat.contentHash,
        ...(sha256 ? { attestedSha256: sha256 } : {}),
        ...(signature ? { signature } : {}),
      });
      await deps.finalizeInstallOp(installOpId);

      return { status: "installed", version, templateId: tpl.templateId, dashboardMaterialized: dashboardWritten };
    } catch (err) {
      // INVERSE-ORDER compensating rollback. Each step is best-effort
      // (log-and-continue) so a failed compensation never masks the ORIGINAL
      // error. Order is the inverse of the writes: undo dashboards → undo the
      // workflow_template (ONLY the one THIS attempt created).
      await compensate({ deps, packageName, orgId, userId, createdTemplateId, enteredDashboardWrites });
      try {
        await deps.failInstallOp(installOpId);
        await deps.advanceInstallOpPhase({ installOpId, phase: "rolled_back" });
      } catch (journalErr) {
        console.error(`[workflow-install-saga] journal unwind failed for ${packageName}:`, journalErr);
      }
      throw err;
    }
  });
}

/** Inverse-order compensation for a partially-applied workflow install. */
async function compensate(args: {
  deps: WorkflowInstallSagaDeps;
  packageName: string;
  orgId: string;
  userId: string;
  createdTemplateId: string | null;
  enteredDashboardWrites: boolean;
}): Promise<void> {
  const { deps, packageName, orgId, userId, createdTemplateId, enteredDashboardWrites } = args;

  // Inverse of WRITE 2/3/4 — archive the dashboards (rows preserved; safe no-op
  // when nothing was written). Attempted whenever the dashboard-write region was
  // ENTERED, so a throw mid-region (a partial template / instance fan-out) is
  // still rolled back.
  if (enteredDashboardWrites) {
    try {
      await deps.archiveDashboards({ packageName, orgId, userId });
    } catch (e) {
      console.error(`[workflow-install-saga] compensation (archiveDashboards) failed for ${packageName}:`, e);
    }
  }

  // Inverse of WRITE 1 — delete the workflow_template, but ONLY the one THIS
  // attempt created. A re-install's upsert "created" nothing new (wasReinstall),
  // so we never delete a pre-existing template. `deleteWorkflowTemplate` itself
  // also refuses an in-use template.
  if (createdTemplateId) {
    try {
      await deps.deleteWorkflowTemplate(createdTemplateId);
    } catch (e) {
      console.error(`[workflow-install-saga] compensation (deleteWorkflowTemplate) failed for ${packageName}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot-orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Compensate + roll back a single unfinalized install op (a process killed
 * mid-saga). Idempotent + best-effort. Dashboards are archived ONLY when the
 * crashed op reached the `writing` phase (it had ENTERED the dashboard-write
 * region) — an op that died at materialized/granted/preflighted never wrote
 * dashboards, so archiving package-wide would wrongly drop a PREVIOUS healthy
 * install's dashboards on a crashed re-install. The just-created template (if
 * any) is left for a future re-install's idempotent upsert to converge —
 * deleting an unknown template id at boot risks dropping a healthy one.
 */
export async function compensateOrphanInstallOp(
  op: { installOpId: string; packageName: string; orgId: string | null; phase?: string },
  deps: Pick<WorkflowInstallSagaDeps, "archiveDashboards" | "advanceInstallOpPhase" | "failInstallOp">,
): Promise<void> {
  if (op.orgId && op.phase === "writing") {
    try {
      await deps.archiveDashboards({ packageName: op.packageName, orgId: op.orgId, userId: "system:boot-cleanup" });
    } catch (e) {
      console.error(`[workflow-install-saga] boot-cleanup (archiveDashboards) failed for ${op.packageName}:`, e);
    }
  }
  try {
    await deps.failInstallOp(op.installOpId);
    await deps.advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
  } catch (e) {
    console.error(`[workflow-install-saga] boot-cleanup (journal unwind) failed for ${op.packageName}:`, e);
  }
}

// ---------------------------------------------------------------------------
// Default deps factory — wires the real host primitives.
// ---------------------------------------------------------------------------

/**
 * Wire the production saga defaults. The production caller IS wired — the host
 * injects the saga and the workflows extension-handler delegates installs to it.
 * This factory wires the DI defaults + keeps them unit-testable, and lets the host
 * inject the saga into the workflow handler's slot (`setWorkflowInstallSagaHook`).
 */
export async function makeDefaultWorkflowInstallSagaDeps(): Promise<WorkflowInstallSagaDeps> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  const {
    beginInstallOp,
    advanceInstallOpPhase,
    finalizeInstallOp,
    failInstallOp,
    readInstallOp,
  } = await import("@/lib/extension-install-ops");
  const { resolveExtensionDistIntegrity } = await import("@cinatra-ai/registries");
  const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
  const { materializePackageToStore } = await import("@/lib/extension-package-store");
  const { recordRequestedGrant, approveGrant } = await import("@/lib/extension-host-port-grants");
  const { readInstalledExtensionsByPackageName } = await import("@cinatra-ai/extensions/canonical-store");
  const { sourceSwitchExtension } = await import("@cinatra-ai/extensions/lifecycle-primitive");
  const { pickSingleActiveRow } = await import("@/lib/extension-install-anchor");
  const { parseWorkflowBpmnSidecar } = await import("@cinatra-ai/workflows/bpmn");
  const { installWorkflowTemplate } = await import("@cinatra-ai/workflows/extension-ops");
  const { deleteWorkflowTemplate, findWorkflowTemplate } = await import("@cinatra-ai/workflows/store");
  const {
    materializeExtensionTemplate,
    materializeExtensionInstanceForProject,
    archiveExtensionDashboards,
    restoreExtensionDashboards,
    validateDashboardConfigV12,
    validateExtensionCubeUsage,
    getPortletKindDescriptor,
    registerCorePortletKinds,
  } = await import("@cinatra-ai/dashboards/extension-materialization");
  const { listRegisteredCubeNames } = await import("@cinatra-ai/dashboards/cubes-platform");
  const { validateMigrationSpec } = await import("@/lib/extension-migration-dsl");

  type HostPortName = Parameters<typeof recordRequestedGrant>[0]["requestedPorts"][number];

  const dashboardActor = (userId: string, orgId: string) => ({
    userId,
    organizationId: orgId,
    teamIds: [] as string[],
    orgRole: "admin" as const,
    teamRoles: {},
  });

  async function readDashboardConfigFromStore(storeDir: string): Promise<unknown | null> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      return JSON.parse(await readFile(join(storeDir, "cinatra", "dashboard.json"), "utf8")) as unknown;
    } catch (e) {
      // ENOENT = the extension ships no dashboard (fine); any other read/parse
      // error fails the preflight closed.
      if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw new WorkflowInstallPreflightError("DASHBOARD_INVALID", `cinatra/dashboard.json could not be read/parsed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function readRequestedHostPortsFromStore(storeDir: string): Promise<string[]> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const manifest = JSON.parse(await readFile(join(storeDir, "package.json"), "utf8")) as { cinatra?: { requestedHostPorts?: unknown } };
      const ports = manifest.cinatra?.requestedHostPorts;
      return Array.isArray(ports) ? ports.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  return {
    withInstallLock,
    beginInstallOp: (b) => beginInstallOp(b).then(() => undefined),
    advanceInstallOpPhase: (a) => advanceInstallOpPhase(a).then(() => undefined),
    finalizeInstallOp: (id) => finalizeInstallOp(id).then(() => undefined),
    failInstallOp: (id) => failInstallOp(id).then(() => undefined),
    readInstallOp: (pkg, oid) => readInstallOp(pkg, oid),

    resolveIntegrity: async (packageName, version) => {
      const config = await loadVerdaccioConfigForServer();
      return resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
    },
    materialize: async (i) => {
      const mat = await materializePackageToStore({
        packageName: i.packageName,
        version: i.version,
        expectedIntegrity: i.expectedIntegrity,
        registryUrl: i.registryUrl,
      });
      return { storeDir: mat.storeDir, digest: mat.digest, integrity: mat.integrity, contentHash: mat.contentHash };
    },

    preflightFromStore: async ({ storeDir, packageName }) => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const pkg = JSON.parse(await readFile(join(storeDir, "package.json"), "utf8")) as { cinatra?: Record<string, unknown> };
      const pkgCinatra = (pkg.cinatra ?? {}) as Record<string, unknown>;

      // (a) BPMN compile (the sidecar parser also compiles via compileBpmnToWorkflowSpec).
      const sidecar = await parseWorkflowBpmnSidecar({ packageRoot: storeDir, pkgCinatra });
      if (!sidecar.ok) {
        throw new WorkflowInstallPreflightError("BPMN_INVALID", sidecar.errors.map((e) => `${e.code}: ${e.detail}`).join("; "));
      }

      // (b) dashboard v1.2 WITH the typed-portlet registry (kind/version BEFORE write).
      const dashboardConfig = await readDashboardConfigFromStore(storeDir);
      let parsedConfig: unknown | null = null;
      if (dashboardConfig != null) {
        registerCorePortletKinds();
        const v = validateDashboardConfigV12(dashboardConfig, { getPortletKind: getPortletKindDescriptor });
        if (!v.ok) throw new WorkflowInstallPreflightError("DASHBOARD_INVALID", v.errors.join("; "));
        parsedConfig = v.config;
      }

      // (c) cube guard — unknown cube ⇒ reject; declared contributions ⇒ requires-rebuild.
      const declaredCubeContributions = Array.isArray(pkgCinatra.dashboardCubes)
        ? (pkgCinatra.dashboardCubes as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;
      const cubeVerdict = validateExtensionCubeUsage(
        { dashboardConfig: parsedConfig as never, declaredCubeContributions },
        { knownCubes: listRegisteredCubeNames() },
      );
      if (cubeVerdict.verdict === "reject") {
        throw new WorkflowInstallPreflightError("CUBE_UNKNOWN", cubeVerdict.reason ?? "dashboard references an unregistered cube");
      }
      if (cubeVerdict.verdict === "requires-rebuild") {
        throw new WorkflowInstallRequiresRebuildError(cubeVerdict.reason ?? "extension requires a host rebuild to register cubes", cubeVerdict.offendingCubes ?? []);
      }

      // (d) migration-spec validate (validate-only; applying migrations is a
      // separate step). Dormant for the current cohort (no workflow extension
      // declares cinatra.migrations) — wired so a future one is gated.
      const migrations = Array.isArray(pkgCinatra.migrations) ? (pkgCinatra.migrations as Array<{ id?: unknown; path?: unknown }>) : [];
      for (const m of migrations) {
        if (typeof m?.path !== "string" || typeof m?.id !== "string") continue;
        const rel = m.path.replace(/^\.\//, "");
        if (rel.startsWith("/") || rel.split("/").some((seg) => seg === "..")) {
          throw new WorkflowInstallPreflightError("MIGRATION_INVALID", `unsafe migration path "${m.path}"`);
        }
        let parsed: { ops?: unknown };
        try {
          parsed = JSON.parse(await readFile(join(storeDir, rel), "utf8")) as { ops?: unknown };
        } catch {
          throw new WorkflowInstallPreflightError("MIGRATION_INVALID", `migration "${m.id}" is not valid JSON`);
        }
        if (!Array.isArray(parsed.ops)) {
          throw new WorkflowInstallPreflightError("MIGRATION_INVALID", `migration "${m.id}" has no ops[]`);
        }
        const result = validateMigrationSpec({ id: m.id, ops: parsed.ops as never }, packageName);
        if (!result.ok) throw new WorkflowInstallPreflightError("MIGRATION_INVALID", result.errors.join("; "));
      }

      return { manifest: sidecar.manifest, dashboardConfig: parsedConfig };
    },

    installWorkflowTemplate: async ({ manifest, orgId, userId, packageName }) => {
      const m = manifest as { key: string; version: number };
      const pre = await findWorkflowTemplate(orgId, m.key, m.version);
      const wasReinstall = pre != null;
      const installed = await installWorkflowTemplate(
        manifest as never,
        { orgId, createdBy: userId, sourcePackage: packageName, ownerLevel: "organization", ownerId: orgId },
      );
      if (!installed.ok) throw new WorkflowInstallPreflightError("TEMPLATE_INSTALL_FAILED", installed.errors.join("; "));
      return { templateId: installed.templateId, wasReinstall };
    },
    materializeDashboardTemplate: async ({ packageName, orgId, userId, config }) => {
      await materializeExtensionTemplate(undefined, {
        extensionId: packageName,
        organizationId: orgId,
        config,
        scope: { ownerLevel: "organization", ownerId: orgId },
        actor: dashboardActor(userId, orgId),
      });
    },
    listOrgProjectIds: async (orgId) => {
      // The per-project instance fan-out basis — derived HOST-side from the org's
      // own projects (`organization_id`), NEVER from package-supplied fields
      // (all scope/authz derive from session).
      const { projectsDb, projects } = await import("@/lib/projects-store");
      const { eq } = await import("drizzle-orm");
      const rows = await projectsDb.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, orgId));
      return rows.map((r) => r.id);
    },
    materializeInstanceForProject: async ({ packageName, orgId, userId, projectId }) => {
      await materializeExtensionInstanceForProject(undefined, {
        extensionId: packageName,
        organizationId: orgId,
        projectId,
        actor: dashboardActor(userId, orgId),
      });
    },
    restoreDashboards: async ({ packageName, orgId, userId }) => {
      await restoreExtensionDashboards(undefined, { extensionId: packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
    },

    readRequestedPorts: (storeDir) => readRequestedHostPortsFromStore(storeDir),
    // HOST-COMPAT GATE basis: the materialized manifest's `cinatra.sdkAbiRange`.
    readDeclaredCompat: async (storeDir) => {
      const { readDeclaredHostCompatFromStore } = await import("@/lib/extension-host-compat");
      return readDeclaredHostCompatFromStore(storeDir);
    },
    gcStoreDir: async (storeDir) => {
      const { rm } = await import("node:fs/promises");
      await rm(storeDir, { recursive: true, force: true });
      await rm(`${storeDir}.tgz`, { force: true }).catch(() => undefined);
    },
    recordRequestedGrant: (g) =>
      recordRequestedGrant({ packageName: g.packageName, orgId: g.orgId, requestedPorts: g.requestedPorts as readonly HostPortName[] }).then(() => undefined),
    approveGrant: (g) =>
      approveGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        approvedPorts: g.approvedPorts as readonly HostPortName[],
        requestedPorts: g.requestedPorts as readonly HostPortName[],
        approvedBy: g.approvedBy,
      }).then(() => undefined),
    recordProvenance: async (p) => {
      const rows = await readInstalledExtensionsByPackageName(p.packageName);
      const target = pickSingleActiveRow(rows, p.orgId);
      if (!target) {
        throw new Error(
          `recordProvenance: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      await sourceSwitchExtension(
        target.id,
        {
          type: "verdaccio",
          registryUrl: p.registryUrl,
          packageName: p.packageName,
          version: p.version,
          integrity: p.integrity,
          contentHash: p.contentHash,
          ...(p.attestedSha256 ? { attestedSha256: p.attestedSha256 } : {}),
          ...(p.signature ? { signature: p.signature } : {}),
        },
        { actor: { source: "runtime-installer" }, reason: `workflow runtime install provenance @ ${p.version}` },
      );
    },

    archiveDashboards: async ({ packageName, orgId, userId }) => {
      await archiveExtensionDashboards(undefined, { extensionId: packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
    },
    deleteWorkflowTemplate: (templateId) => deleteWorkflowTemplate(templateId),
  };
}
