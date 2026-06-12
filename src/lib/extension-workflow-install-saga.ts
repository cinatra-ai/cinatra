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
// a distinct surfaced state, NOT a partial install), (d) migration preflight
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

import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

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
 *  cube reference, invalid migration declaration) — refused BEFORE any write. */
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
  /** Read the current op's phase + id (+ digest) for (package, org) — drives the
   *  idempotent short-circuit (a finalized op for the SAME artifact → no-op) AND
   *  the failed-UPDATE restore (re-`begin` the prior finalized op at its original
   *  id + digest — see the catch block). `digest` is optional so older unit-test
   *  fakes stay valid; the default factory's journal read always returns it. */
  readInstallOp: (packageName: string, orgId: string | null) => Promise<{ phase: string; installOpId: string; digest?: string | null } | null>;

  // -- materialize -------------------------------------------------------
  /** Resolve the tarball SRI + the registry it lives on (root of trust) + the optional signature. */
  resolveIntegrity: (packageName: string, version: string) => Promise<{ integrity: string; registryUrl: string; sha256?: string; signature?: string | null; resolvedVersion?: string }>;
  /** Materialize the SRI-verified tarball into the on-disk store. */
  materialize: (input: { packageName: string; version: string; expectedIntegrity: string; registryUrl: string }) => Promise<{ storeDir: string; digest: string; integrity: string; contentHash: string }>;

  // -- preflight (ALL read from the materialized storeDir) ---------------
  /** Read+compile the BPMN sidecar + dashboard.json from the storeDir, run the
   *  typed-portlet-registry version check + the cube guard + the migration
   *  preflight. Throws `WorkflowInstallPreflightError` /
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
  /** Read the materialized manifest's dependency edges (#180) — the DUAL-READ
   *  helper (`cinatra.dependencies` canonical-wins; legacy
   *  `cinatra.agentDependencies` projected; conflict/malformed = THROW,
   *  fail-loud). Runs with the host-compat gate (pre-journal) so a refused
   *  manifest is fully inert. Optional so existing unit tests can omit it;
   *  the default factory always wires it. */
  readDependencyEdges?: (storeDir: string) => Promise<ExtensionDependency[]>;
  /** Persist the manifest edges onto the canonical row at the saga's
   *  (package, org) scope — the FINALIZE-SEAM invariant write
   *  (#180): runs with `recordProvenance`, before `finalizeInstallOp`, so a
   *  `finalized` workflow install-op implies persisted edges. Optional for
   *  unit tests; the default factory wires the sanctioned canonical writer. */
  persistDependencyEdges?: (input: { packageName: string; orgId: string | null; dependencies: ExtensionDependency[] }) => Promise<void>;
  /** FORWARD install-closure gate (#180 item 5) for a FRESH install — refuses
   *  the finalize when an install-blocking edge's target is not installed
   *  (peer/optional edges never block). A throw routes into the saga's
   *  inverse-order compensation. Optional for unit tests; the default factory
   *  wires the shared closure gate. */
  assertForwardInstallClosure?: (input: { packageName: string; orgId: string | null }) => Promise<void>;
  /** Capture the CURRENT canonical verdaccio source for the (package, org)
   *  BEFORE the saga's `recordProvenance` overwrites it — on a failed UPDATE
   *  the catch block re-records it so the canonical row keeps pointing at the
   *  still-live OLD install. Optional (omitted → no provenance restore); the
   *  default factory wires the canonical-store read. */
  readCurrentSource?: (packageName: string, orgId: string | null) => Promise<{ registryUrl: string; version: string; integrity: string; contentHash?: string; attestedSha256?: string; signature?: string | null } | null>;
  /** Capture the CURRENT canonical row's persisted dependency edges (#180)
   *  BEFORE the finalize seam overwrites them — on a failed UPDATE the catch
   *  block re-persists them (closure gates must read the live OLD install's
   *  edges, never the failed version's). Optional; the default factory wires
   *  the canonical-store read. */
  readCurrentDependencies?: (packageName: string, orgId: string | null) => Promise<ExtensionDependency[] | null>;

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

    // 1.6 DEPENDENCY-EDGE READ (#180) — the dual-read helper over the
    // materialized (SRI-verified) manifest, with the SAME pre-journal
    // inertness contract as the host-compat gate above: a malformed
    // `cinatra.dependencies` entry or a canonical-vs-legacy conflict throws
    // HERE — before `beginInstallOp`, the grant request, preflight, and any
    // template/dashboard write — and the just-materialized dir is GC'd. The
    // edges are PERSISTED late, at the finalize seam (step 6).
    let dependencyEdges: ExtensionDependency[] | null = null;
    if (deps.readDependencyEdges) {
      try {
        dependencyEdges = await deps.readDependencyEdges(mat.storeDir);
      } catch (err) {
        if (deps.gcStoreDir) {
          try {
            await deps.gcStoreDir(mat.storeDir);
          } catch {
            /* best-effort GC — a leftover dir is recovered by a later retry. */
          }
        }
        throw err;
      }
    }

    // FAILED-UPDATE RESTORE CAPTURE (#180): `beginInstallOp` below overwrites
    // the single (package, org) journal row — on an UPDATE (a prior op is
    // `finalized` for a DIFFERENT artifact) that destroys the OLD install's
    // anchor, and the late writes (provenance → edges) overwrite the OLD
    // install's canonical source + dependency edges before `finalizeInstallOp`
    // commits the new attempt. Snapshot all three NOW so the catch block can
    // restore the previously-working install when this attempt fails.
    const isUpdate = existing?.phase === "finalized";
    const priorSource = isUpdate
      ? (await deps.readCurrentSource?.(packageName, orgId)) ?? null
      : null;
    const priorEdges = isUpdate
      ? (await deps.readCurrentDependencies?.(packageName, orgId)) ?? null
      : null;

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

      // 6.5 EDGE PERSISTENCE at the FINALIZE SEAM (#180): the
      // manifest edges (read at 1.6, fail-loud) land on the canonical row
      // with the provenance, BEFORE `finalizeInstallOp` — a `finalized`
      // workflow install-op implies persisted edges. Then the FORWARD gate
      // (item 5) refuses a FRESH install whose install-blocking edges are
      // unsatisfied (peer/optional never block); the throw routes into the
      // saga's inverse-order compensation below. An UPDATE (a prior finalized
      // op exists) refreshes edges but is not forward-gated here — update
      // constraint evaluation is the version-aware stage of #180.
      if (dependencyEdges !== null && deps.persistDependencyEdges) {
        await deps.persistDependencyEdges({ packageName, orgId, dependencies: dependencyEdges });
      }
      if (!isUpdate && deps.assertForwardInstallClosure) {
        await deps.assertForwardInstallClosure({ packageName, orgId });
      }

      await deps.finalizeInstallOp(installOpId);

      return { status: "installed", version, templateId: tpl.templateId, dashboardMaterialized: dashboardWritten };
    } catch (err) {
      // INVERSE-ORDER compensating rollback. Each step is best-effort
      // (log-and-continue) so a failed compensation never masks the ORIGINAL
      // error. Order is the inverse of the writes: undo dashboards → undo the
      // workflow_template (ONLY the one THIS attempt created).
      await compensate({ deps, packageName, orgId, userId, createdTemplateId, enteredDashboardWrites });
      if (isUpdate && existing) {
        // FAILED UPDATE (#180): `beginInstallOp` above overwrote the OLD
        // install's `finalized` journal op, and the late writes may have
        // overwritten its canonical source and/or dependency edges. RESTORE
        // all three — re-`begin` the prior op at its ORIGINAL id + digest and
        // re-advance it to `finalized` (the trust anchor requires `finalized`,
        // so without this the previously-working workflow install would stop
        // boot-anchoring), then re-record the captured source + edges
        // (idempotent same-value rewrites when the corresponding write never
        // ran). Each step is best-effort + isolated; the ORIGINAL error is
        // always rethrown. The failed attempt's op intentionally vanishes
        // from the one-row-per-(package, org) journal — exactly the runtime
        // pipeline's failed-update semantics.
        try {
          await deps.beginInstallOp({
            installOpId: existing.installOpId,
            packageName,
            orgId,
            digest: existing.digest ?? null,
          });
          await deps.advanceInstallOpPhase({ installOpId: existing.installOpId, phase: "finalized" });
        } catch (restoreErr) {
          console.error(
            `[workflow-install-saga] failed to restore prior finalized install-op ${existing.installOpId} for ${packageName} after a failed update — the previous install may not boot-anchor until a successful re-install:`,
            restoreErr,
          );
        }
        if (priorSource) {
          try {
            await deps.recordProvenance({
              packageName,
              orgId,
              version: priorSource.version,
              registryUrl: priorSource.registryUrl,
              integrity: priorSource.integrity,
              contentHash: priorSource.contentHash ?? "",
              ...(priorSource.attestedSha256 ? { attestedSha256: priorSource.attestedSha256 } : {}),
              ...(priorSource.signature ? { signature: priorSource.signature } : {}),
            });
          } catch (restoreErr) {
            console.error(
              `[workflow-install-saga] failed to restore prior provenance for ${packageName} after a failed update:`,
              restoreErr,
            );
          }
        }
        if (priorEdges !== null && deps.persistDependencyEdges) {
          try {
            await deps.persistDependencyEdges({ packageName, orgId, dependencies: priorEdges });
          } catch (restoreErr) {
            console.error(
              `[workflow-install-saga] failed to restore prior dependency edges for ${packageName} after a failed update — closure gates may read the failed version's edges until a successful re-install:`,
              restoreErr,
            );
          }
        }
      } else {
        try {
          await deps.failInstallOp(installOpId);
          await deps.advanceInstallOpPhase({ installOpId, phase: "rolled_back" });
        } catch (journalErr) {
          console.error(`[workflow-install-saga] journal unwind failed for ${packageName}:`, journalErr);
        }
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
  const { preflightExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");

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

    // GATEKEPT-AWARE reads (#180): when the master flag is ON, packument +
    // tarball reads route through the broker via resolveGatekeptInstallConfig
    // — which, inside a dependency batch, DERIVES from the ROOT grant (no
    // per-member authorize). Provenance/trust still see the FINAL registry
    // identity, never the broker URL (the same rule the runtime pipeline
    // factory enforces). Flag OFF: the legacy server-config path, unchanged.
    resolveIntegrity: async (packageName, version) => {
      const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig } = await import(
        "@/lib/gatekept-install"
      );
      if (isGatekeptInstallEnabled()) {
        const { loadDeploymentRegistryConfig } = await import("@/lib/deployment-registry-config");
        const finalRegistryUrl = loadDeploymentRegistryConfig().publicRegistryUrl;
        const { config } = await resolveGatekeptInstallConfig(packageName, version);
        const resolved = await resolveExtensionDistIntegrity(
          { packageName, packageVersion: version },
          config,
        );
        return { ...resolved, registryUrl: finalRegistryUrl };
      }
      const config = await loadVerdaccioConfigForServer();
      return resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
    },
    materialize: async (i) => {
      const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig } = await import(
        "@/lib/gatekept-install"
      );
      let fetchTarball: import("@/lib/extension-package-store").FetchTarball | undefined;
      let persistRegistryUrl = i.registryUrl;
      if (isGatekeptInstallEnabled()) {
        const { config } = await resolveGatekeptInstallConfig(i.packageName, i.version);
        const { fetchExtensionTarballBytes } = await import("@cinatra-ai/registries");
        const { loadDeploymentRegistryConfig } = await import("@/lib/deployment-registry-config");
        fetchTarball = (input) =>
          fetchExtensionTarballBytes(
            {
              packageName: input.packageName,
              packageVersion: input.packageVersion,
              expectedIntegrity: input.expectedIntegrity,
            },
            config,
          );
        persistRegistryUrl = loadDeploymentRegistryConfig().publicRegistryUrl;
      }
      const mat = await materializePackageToStore(
        {
          packageName: i.packageName,
          version: i.version,
          expectedIntegrity: i.expectedIntegrity,
          registryUrl: persistRegistryUrl,
        },
        fetchTarball ? { fetchTarball } : {},
      );
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

      // (d) migration preflight (#118): the WORKFLOW install path has no
      // host-migration APPLY step (declarative BPMN packages run no server
      // code that needs host tables), so ANY host-migration declaration —
      // the new `cinatra.migrationsDir` OR the RETIRED legacy
      // `cinatra.migrations` JSON-DSL field — is REFUSED fail-closed here:
      // finalizing an install whose declared DDL never runs would be a trap.
      // A package needing host migrations must ship a serverEntry and ride
      // the runtime install path (extension-install-pipeline), where the
      // trusted-signed apply step exists. The check is fs-only (path
      // containment + the `ext_<scope>_<pkg>__NNNN_<desc>.mjs` filename/seq
      // contract) and never imports a migration module. Dormant for the
      // current cohort (no workflow extension declares migrations).
      let migrationPreflight: Awaited<ReturnType<typeof preflightExtensionMigrationsFromStore>>;
      try {
        migrationPreflight = await preflightExtensionMigrationsFromStore({ storeDir, packageName });
      } catch (e) {
        throw new WorkflowInstallPreflightError("MIGRATION_INVALID", e instanceof Error ? e.message : String(e));
      }
      if (migrationPreflight !== null) {
        throw new WorkflowInstallPreflightError(
          "MIGRATION_UNSUPPORTED",
          `${packageName} declares host migrations (cinatra.migrationsDir) but the workflow install path has no ` +
            `migration apply step — ship a serverEntry and install through the runtime path instead (#118)`,
        );
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
    // DEPENDENCY EDGES (#180): dual-read over the materialized manifest
    // (fail-loud on conflict/malformed — see manifest-dependencies.ts).
    readDependencyEdges: async (storeDir) => {
      const { readManifestDependencyEdgesFromStore } = await import(
        "@cinatra-ai/extensions/manifest-dependencies"
      );
      const { edges } = await readManifestDependencyEdgesFromStore(storeDir);
      return edges;
    },
    // EDGE PERSISTENCE at the finalize seam: the sanctioned canonical writer,
    // bound to the SAME single (package, org) row recordProvenance resolved.
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
        reason: `manifest dependency edges @ workflow install`,
      });
    },
    // FORWARD INSTALL GATE (#180 item 5): edgeType-aware closure check over the
    // canonical snapshot, scoped to the saga's org.
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
    // FAILED-UPDATE RESTORE CAPTURES (#180): the prior canonical verdaccio
    // source + persisted dependency edges for the saga's (package, org) scope —
    // snapshotted before the late writes overwrite them.
    readCurrentSource: async (packageName, orgId) => {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const target = pickSingleActiveRow(rows, orgId);
      const src = target?.source;
      if (!src || (src as { type?: string }).type !== "verdaccio") return null;
      const v = src as { registryUrl: string; version: string; integrity: string; contentHash?: string; attestedSha256?: string; signature?: string };
      return {
        registryUrl: v.registryUrl,
        version: v.version,
        integrity: v.integrity,
        ...(v.contentHash ? { contentHash: v.contentHash } : {}),
        ...(v.attestedSha256 ? { attestedSha256: v.attestedSha256 } : {}),
        ...(v.signature ? { signature: v.signature } : {}),
      };
    },
    readCurrentDependencies: async (packageName, orgId) => {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const target = pickSingleActiveRow(rows, orgId);
      return target ? target.dependencies : null;
    },

    archiveDashboards: async ({ packageName, orgId, userId }) => {
      await archiveExtensionDashboards(undefined, { extensionId: packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
    },
    deleteWorkflowTemplate: (templateId) => deleteWorkflowTemplate(templateId),
  };
}
