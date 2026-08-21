import "server-only";

// Boot reconciliation for install rows that were stranded BEFORE the install
// pipeline learned to refuse them.
//
// The install path now refuses an untrusted or unactivatable package before it
// commits, so no new stranded row can appear. Rows created earlier are still out
// there: a live marketplace row for a package that also ships in the image,
// finalized journal, materialized digest, and no ability to serve. Source
// precedence makes the boot resolver pick that row instead of failing closed on
// the pair, so boot now actually attempts it. This module decides what happens
// when the attempt does not work.
//
// TRUST IS NOT THE SUCCESS CRITERION. Trust only admits an import. The override
// is effective only once `register`/`bootstrap` have completed with no failed
// result. Until then the implementation bundled in the image is what serves.
//
// FAILURE CLASS DECIDES THE REMEDY. This is the part that must not be collapsed:
//
//   - CONFIG class: the package may be perfectly good and the HOST is not
//     currently configured to admit it (its registry host is not allow-listed,
//     no signing key is trusted yet, bootstrap trust is switched off). That
//     configuration is mutable, and an operator fixing it should get their
//     install back. Archiving the row on boot would destroy an install because
//     of a setting, so a config-class failure NEVER writes a durable archive. The
//     row is left inactive and retryable with the precise reason recorded.
//
//   - BYTE class: the bytes themselves are wrong (integrity mismatch, digest
//     mismatch, a module that will not import or whose register threw). No host
//     setting will change that. The row is archived through the canonical
//     lifecycle primitive, and the store bytes are KEPT so the failure can still
//     be diagnosed.
//
// Nothing here deletes a row by hand, and nothing here relaxes a gate.

import type { ActivationResult } from "@cinatra-ai/sdk-extensions";
import type { ActivationFailureClass } from "@/lib/extension-activation-failure-class";
import { isMetadataOnlyStoreKind } from "@/lib/extension-package-store-core";

export type { ActivationFailureClass };

/** What reconciliation decided for one package. */
export type BootReconcileOutcome =
  | { kind: "activated"; packageName: string }
  | { kind: "skipped"; packageName: string; reason: string }
  | {
      kind: "retryable";
      packageName: string;
      rowId: string;
      reason: string;
      failureClass: "config";
      /** Did the implementation bundled in the image come back into service? */
      bundledRestored: boolean;
    }
  | {
      kind: "archived";
      packageName: string;
      rowId: string;
      reason: string;
      failureClass: "byte";
      /** Did the implementation bundled in the image come back into service? */
      bundledRestored: boolean;
    }
  | {
      kind: "recovery-required";
      packageName: string;
      rowId: string;
      reason: string;
    };

/** The row shape reconciliation addresses. */
export type ReconcilableRow = {
  id: string;
  packageName: string;
  organizationId: string | null;
  /** Present so supersession can tell a workspace anchor from an org row. */
  ownerLevel?: string;
  /** The store kind. AUTHORITATIVE for "can this package activate in-process at
   *  all" — a metadata-only kind never can, and never should be reconciled. */
  kind?: string;
  status: string;
  isDefault?: boolean;
  source?: { type?: string } | null;
};

export type BootReconcileDeps = {
  /** Every canonical row for the package. */
  readRows: (packageName: string) => Promise<readonly ReconcilableRow[]>;
  /** Did the package actually register in this process? */
  isServing: (packageName: string) => boolean;
  /** Attempt the override's in-process activation. Never throws. */
  activateOverride: (
    row: ReconcilableRow,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Put the image-bundled implementation back in service. Never throws. */
  restoreBundled: (
    packageName: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Archive a row through the canonical lifecycle primitive. */
  archiveRow: (rowId: string, reason: string) => Promise<void>;
  /** Record the reason on the row so the recovery surface can show it. */
  recordActivationFailure: (input: {
    rowId: string;
    packageName: string;
    reason: string;
    failureClass: ActivationFailureClass;
  }) => Promise<void>;
  /** Emit the operator audit event. Never throws. */
  emitAuditEvent: (input: {
    packageName: string;
    rowId: string;
    outcome: string;
    reason: string;
    failureClass: ActivationFailureClass;
  }) => void;
  /** Run under the package's install lock (the same lock every lifecycle path holds). */
  withInstallLock: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
  classifyFailure: (reason: string) => ActivationFailureClass;
};

/**
 * Reconcile ONE package.
 *
 * IDEMPOTENT: a package that is already serving returns `skipped` without
 * touching anything, so running this on every boot is safe.
 *
 * REFUSES TO GUESS: with more than one live marketplace default row there is no
 * single answer to "which install did the operator mean", so reconciliation
 * declines and leaves the decision to a human.
 */
export async function reconcileStrandedInstall(
  packageName: string,
  deps: BootReconcileDeps,
): Promise<BootReconcileOutcome> {
  return deps.withInstallLock(packageName, async () => {
    // Already serving: nothing was stranded, or a previous pass fixed it.
    if (deps.isServing(packageName)) {
      return { kind: "skipped" as const, packageName, reason: "already serving" };
    }

    const rows = await deps.readRows(packageName);
    const allLive = rows.filter((r) => r.status === "active" || r.status === "locked");
    // SUPERSESSION FIRST (cinatra#2698 S4): a live workspace install is the one
    // row in force, so its superseded organization rows are not candidates. The
    // install path archives them, but it skips a LOCKED one and it archives only
    // after the workspace install finalizes, so a live organization row can still
    // stand beside the workspace row. Without this filter reconciliation would
    // read that pair as two competing installs and skip the very row it exists to
    // activate, leaving the package stranded for good.
    const live = allLive.some(
      (r) => r.ownerLevel === "workspace" && (r.organizationId ?? null) === null,
    )
      ? allLive.filter((r) => (r.organizationId ?? null) === null)
      : allLive;
    const overrides = live.filter(
      (r) => r.isDefault !== false && r.source?.type === "verdaccio",
    );
    if (overrides.length === 0) {
      return {
        kind: "skipped" as const,
        packageName,
        reason: "no marketplace override row to reconcile",
      };
    }
    if (overrides.length > 1) {
      return {
        kind: "skipped" as const,
        packageName,
        reason:
          "more than one live marketplace install for this package; " +
          "reconciliation will not choose between them",
      };
    }

    const row = overrides[0]!;
    // The same kind exclusion the sweep applies, restated over the row this pass
    // actually resolved (cinatra#2762). The sweep filters on the rows
    // `listInstalledExtensions` returned; this is the row a fresh read under the
    // lock produced. A metadata-only package has no server module to activate, so
    // "did not activate in-process" is its healthy state and there is nothing
    // here to recover.
    if (isMetadataOnlyStoreKind(row.kind)) {
      return {
        kind: "skipped" as const,
        packageName,
        reason: "metadata-only kind: no server module to activate in-process",
      };
    }
    const attempt = await deps.activateOverride(row);
    // SUCCESS IS REGISTRATION, not trust. Re-read the serving registry rather
    // than believing the attempt's own report, so "effective" means the same
    // thing here as it does to a request.
    if (attempt.ok && deps.isServing(packageName)) {
      return { kind: "activated" as const, packageName };
    }
    const reason = attempt.ok
      ? "the package reported activation but registered nothing"
      : attempt.reason;
    const failureClass = deps.classifyFailure(reason);

    // ORDER: the bundled implementation is put back only once the override can
    // no longer take the package's identity. For a BYTE-class failure that means
    // after the archive below, never before it: registering the bundled module
    // underneath a still-live override would leave two registrations racing for
    // the same global names, which is the defect this whole change exists to
    // remove. For a CONFIG-class failure the row stays live by design, but it
    // registered nothing (that is why reconciliation ran), so there is no live
    // registration to race and the bundle is restored below.
    if (failureClass === "config") {
      const restored = await deps.restoreBundled(packageName);
      // Mutable host configuration. Leave the install alone: record why, emit
      // the audit event, and let an operator fix the setting and retry.
      await deps.recordActivationFailure({
        rowId: row.id,
        packageName,
        reason,
        failureClass,
      });
      deps.emitAuditEvent({
        packageName,
        rowId: row.id,
        outcome: restored.ok ? "retryable" : "retryable-bundle-unrestored",
        reason,
        failureClass,
      });
      return {
        kind: "retryable" as const,
        packageName,
        rowId: row.id,
        reason,
        failureClass: "config",
        bundledRestored: restored.ok,
      };
    }

    // Byte class: no configuration change will fix these bytes. Archive
    // canonically (restorable, never a delete) and KEEP the store bytes.
    // The bundle is restored AFTER the archive, so it never registers beneath a
    // live override.
    try {
      await deps.archiveRow(row.id, `boot reconciliation: ${reason}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.emitAuditEvent({
        packageName,
        rowId: row.id,
        outcome: "recovery-required",
        reason: `${reason}; archiving the row failed: ${detail}`,
        failureClass,
      });
      return {
        kind: "recovery-required" as const,
        packageName,
        rowId: row.id,
        reason: `${reason}; archiving the row failed: ${detail}`,
      };
    }
    const restored = await deps.restoreBundled(packageName);
    await deps.recordActivationFailure({
      rowId: row.id,
      packageName,
      reason,
      failureClass,
    });
    deps.emitAuditEvent({
      packageName,
      rowId: row.id,
      outcome: restored.ok ? "archived" : "archived-bundle-unrestored",
      reason,
      failureClass,
    });
    return {
      kind: "archived" as const,
      packageName,
      rowId: row.id,
      reason,
      failureClass: "byte",
      bundledRestored: restored.ok,
    };
  });
}

// ---------------------------------------------------------------------------
// THE REAL BOOT PASS.
//
// Everything above is pure and injected so it can be tested exhaustively. This
// is the production wiring: real canonical store, real in-process activator,
// real bundled-reactivation seam, real lifecycle primitive, real audit trail.
// ---------------------------------------------------------------------------

/** What the boot phase reports back, for the log line and for tests. */
export type BootReconcileSweep = {
  considered: number;
  outcomes: BootReconcileOutcome[];
};

/**
 * Build the production dependencies.
 *
 * `activatedThisBoot` is the set of package names the loaders already brought up
 * in this process. It is the honest starting point for "is this serving": it is
 * the loaders' own report, and every candidate is re-checked against it after an
 * activation attempt rather than trusting the attempt's return value.
 */
export async function makeDefaultBootReconcileDeps(
  activatedThisBoot: Set<string>,
): Promise<BootReconcileDeps> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { transitionExtensionLifecycle } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  const { activateInstalledPackageInProcess } = await import("@/lib/extension-runtime-activate");
  const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
  const { withInstallLock } = await import("@cinatra-ai/agents");
  const { classifyActivationFailure } = await import("@/lib/extension-activation-failure-class");

  return {
    readRows: async (packageName) =>
      (await readInstalledExtensionsByPackageName(packageName)) as unknown as ReconcilableRow[],
    isServing: (packageName) => activatedThisBoot.has(packageName),
    activateOverride: async (row) => {
      try {
        const results = await activateInstalledPackageInProcess(
          row.packageName,
          row.organizationId ?? null,
        );
        const ok = results.some(
          (r) => r.status === "registered" || r.status === "bootstrapped",
        );
        if (ok) {
          activatedThisBoot.add(row.packageName);
          return { ok: true };
        }
        return {
          ok: false,
          reason:
            results.find((r) => r.reason)?.reason ??
            results[0]?.status ??
            "the package did not register",
        };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    restoreBundled: async (packageName) => {
      try {
        return await reactivateBundledFallbackInProcess(packageName);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    archiveRow: async (rowId, reason) => {
      await transitionExtensionLifecycle(rowId, "archive", {
        actor: { source: "boot-reconcile" },
        reason,
      });
    },
    recordActivationFailure: async ({ rowId, packageName, reason, failureClass }) => {
      // PERSISTED, not merely logged. The lifecycle audit table is what an
      // operator reads to learn why an install is sitting inactive, and it is
      // the same table every other lifecycle decision writes to, so the record
      // survives the process that made it. The operation is `activate`, which is
      // the truth: an activation was attempted for this row and did not take;
      // the reason carries the failure class that decides whether retrying can
      // help. Best-effort by design, because a boot pass must never fail on its
      // own audit write.
      try {
        const { insertExtensionLifecycleAudit } = await import("@/lib/database");
        await insertExtensionLifecycleAudit({
          id: crypto.randomUUID(),
          actorId: "system:boot-reconcile",
          actorType: "system",
          orgId: null,
          operation: "activate",
          packageName,
          packageVersion: null,
          destroyedRowSnapshot: { resolvedRow: { id: rowId }, failureClass },
          danglingReferences: null,
          reason: `boot reconciliation: ${failureClass}-class activation failure: ${reason}`,
        });
      } catch (err) {
        console.warn(
          "[boot-reconcile] could not record the activation failure for %s: %s",
          packageName,
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    emitAuditEvent: ({ packageName, rowId, outcome, reason, failureClass }) => {
      // The structured operational line ops alerting keys on, matching the shape
      // the install pipeline already emits.
      console.error(
        `[operational-event] ${JSON.stringify({
          event: "extension_boot_reconcile",
          packageName,
          rowId,
          outcome,
          failureClass,
          reason,
        })}`,
      );
    },
    withInstallLock: (packageName, fn) => withInstallLock(packageName, fn),
    classifyFailure: classifyActivationFailure,
  };
}

/**
 * Reconcile every package that holds a live product install but did NOT come up
 * in this process.
 *
 * Runs after the loaders, so `activatedThisBoot` is complete, and before the
 * required-activation assertion, so a package this pass recovers is counted as
 * present rather than reported missing.
 */
export async function reconcileStrandedInstallsAtBoot(
  activatedThisBoot: Set<string>,
  deps?: BootReconcileDeps,
): Promise<BootReconcileSweep> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const rows = (await listInstalledExtensions({})) as unknown as ReconcilableRow[];
  // Candidates: a package with a LIVE product-installed row that is not serving.
  // A bundled-only package is never a candidate (it has no override to recover),
  // and neither is anything the loaders already brought up.
  //
  // METADATA-ONLY KINDS ARE EXCLUDED BY ROW KIND (cinatra#2762). `activatedThisBoot`
  // is built from the loaders' ActivationResults, and a skill, agent or artifact
  // NEVER enters it: it ships no server module, so `activate.ts` returns
  // `skipped/no-server-entry` for it — on a perfectly healthy install — and the
  // artifact bridge rescan that does project artifacts runs in a LATER phase than
  // this one. So absence from that set says nothing about a metadata-only
  // package's health, and treating it as evidence made this pass reconcile every
  // healthy metadata-only install on EVERY boot: a pointless activation attempt,
  // an audit INSERT, and an `[operational-event]` error per package per restart.
  //
  // The exclusion is BY KIND and nothing else. Widening the `/no server entry/i`
  // failure-class regex to match `no-server-entry` would have suppressed the same
  // log line by classifying these healthy installs as BYTE-class failures — which
  // archives them (`extension-activation-failure-class.ts:213-255`). The row kind
  // is the fact; the reason string is a symptom.
  const candidates = [
    ...new Set(
      rows
        .filter(
          (r) =>
            (r.status === "active" || r.status === "locked") &&
            r.isDefault !== false &&
            r.source?.type === "verdaccio" &&
            !isMetadataOnlyStoreKind(r.kind) &&
            !activatedThisBoot.has(r.packageName),
        )
        .map((r) => r.packageName),
    ),
  ];
  if (candidates.length === 0) return { considered: 0, outcomes: [] };

  const wired = deps ?? (await makeDefaultBootReconcileDeps(activatedThisBoot));
  const outcomes: BootReconcileOutcome[] = [];
  for (const packageName of candidates) {
    try {
      outcomes.push(await reconcileStrandedInstall(packageName, wired));
    } catch (err) {
      // A reconciliation that throws must not abort boot, and must not be
      // silent: the package stays as it was and the operator gets the reason.
      console.error(
        "[boot-reconcile] reconciliation threw for %s: %s",
        packageName,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { considered: candidates.length, outcomes };
}

/**
 * The sweep's outcomes as `ActivationResult`s, for `bootActivationResults`
 * (cinatra#2762).
 *
 * WHY THIS EXISTS. The boot phase runs this pass before
 * `assertRequiredExtensionActivations` precisely so a package it recovers
 * "counts as present" — but it pushed NOTHING into the results array the assert
 * reads. So a required package that reconciliation successfully activated was
 * still reported `missing`, and a PRODUCTION boot aborted on the very recovery
 * that had just fixed it. The phase's claim is now backed by a result.
 *
 * The mapping is exactly what is true in-process, never more:
 *   - `activated` → REGISTERED. The override registered, verified by re-reading
 *     the serving registry rather than by trusting the attempt's own report.
 *   - `retryable` / `archived` WITH the bundle restored → REGISTERED. This is the
 *     documented failure-class policy working: the override did not take and the
 *     implementation bundled in the image is serving in this process. The
 *     package is present — by the bundled version, which is the outcome #2762
 *     asks for — so a boot must not abort on it. The reason says which version
 *     is actually serving, so no operator reads this as a clean activation.
 *   - `retryable` / `archived` WITHOUT the bundle restored, and
 *     `recovery-required` → FAILED. Nothing is serving the package; the assert
 *     must still fail it, now carrying this pass's own diagnosis instead of a
 *     bare `missing`.
 *   - `skipped` → NO result. This pass did not act, so it has nothing to add:
 *     "already serving" is the loaders' result to report, and it already is.
 *
 * `reason` stays the loader's CLOSED machine-readable union — this pass has no
 * member that honestly describes a config-class refusal, and inventing one (or
 * borrowing `register-threw`) would put a false cause in front of an operator.
 * The human diagnosis travels in `error`, which is exactly the field for it, and
 * the audit row + the phase log line carry it too.
 */
export function activationResultsFromReconcileSweep(
  sweep: BootReconcileSweep,
): ActivationResult[] {
  const results: ActivationResult[] = [];
  for (const outcome of sweep.outcomes) {
    switch (outcome.kind) {
      case "activated":
        results.push({ packageName: outcome.packageName, status: "registered" });
        break;
      case "retryable":
      case "archived":
        results.push(
          outcome.bundledRestored
            ? {
                packageName: outcome.packageName,
                status: "registered",
                error:
                  `boot-reconcile: the install did not activate (${outcome.reason}); ` +
                  "the version bundled in the image is serving",
              }
            : {
                packageName: outcome.packageName,
                status: "failed",
                error:
                  `boot-reconcile: the install did not activate (${outcome.reason}) ` +
                  "and the bundled version could not be restored",
              },
        );
        break;
      case "recovery-required":
        results.push({
          packageName: outcome.packageName,
          status: "failed",
          error: `boot-reconcile: ${outcome.reason}`,
        });
        break;
      case "skipped":
        break;
    }
  }
  return results;
}
