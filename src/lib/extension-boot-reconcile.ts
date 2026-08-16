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

import type { ActivationFailureClass } from "@/lib/extension-activation-failure-class";

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
    }
  | {
      kind: "archived";
      packageName: string;
      rowId: string;
      reason: string;
      failureClass: "byte";
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

    // The override did not take, so the bundled implementation must be serving
    // before anything else is decided.
    const restored = await deps.restoreBundled(packageName);

    if (failureClass === "config") {
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
      };
    }

    // Byte class: no configuration change will fix these bytes. Archive
    // canonically (restorable, never a delete) and KEEP the store bytes.
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
    };
  });
}
