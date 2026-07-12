// Canonical lifecycle primitive.
//
// `transitionExtensionLifecycle` is the ONLY function permitted to write
// `installed_extension.status`. Every code path — UI server actions, MCP
// handlers, CLI/install adapters, boot/reload, direct helpers — must call
// this primitive (or be routed through `enforceCanonicalManifest` first).
//
// The canonical-gate reach test enforces this by scanning for any direct
// .status write outside this module.
//
// Lifecycle invariants:
//   - locked rejects destructive removal paths
//   - primitive NEVER yanks/deletes from Verdaccio; only the local manifest
//     row changes. (Verdaccio yank is not a lifecycle op.)
import "server-only";

import {
  _internalDeleteInstalledExtension,
  _internalInsertInstalledExtension,
  _internalUpdateInstalledExtensionMetadata,
  _internalUpdateInstalledExtensionSource,
  _internalUpdateInstalledExtensionStatus,
  readInstalledExtensionById,
  readInstalledExtensionsByPackageName,
} from "./canonical-store";
import { deleteExtensionPermissions } from "./permissions-store";
import { isNonFinalizedLiveRowAware } from "./non-finalized-row";
import { isStaticBundleAnchorSource } from "./static-bundle-anchor";
import {
  DESTRUCTIVE_OPS,
  LOCKED_REJECTED_OPS,
  isResolvedConnectorAccessDeclaration,
  validateExtensionSource,
  type ExtensionDependency,
  type ExtensionLifecycleStatus,
  type ExtensionSource,
  type InstalledExtension,
  type LifecycleTransitionOp,
  type ResolvedConnectorAccessDeclaration,
} from "./canonical-types";
import { validateExtensionDependencyShape } from "./manifest-dependencies";

/**
 * Structured error returned when a lifecycle transition is refused.
 * Callers check `code` to decide whether to surface a UI message or
 * abort hard.
 */
export class LifecycleTransitionError extends Error {
  constructor(
    public readonly code:
      | "LOCKED_REJECTS_OP"
      | "ILLEGAL_TRANSITION"
      | "DEP_CLOSURE_BREAK"
      | "EXT_NOT_FOUND"
      | "INVALID_INPUT",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LifecycleTransitionError";
  }
}

export type TransitionOpts = {
  actor: { source: string; orgId?: string; userId?: string; roles?: string[] };
  reason: string;
  closureCheck?: boolean;
  /**
   * `unlock` is policy-gated. Callers MUST pass `allowUnlock: true` (along
   * with a platform_admin actor) to demote a locked row back to active. Lacking
   * this flag, `unlock` is refused to protect against accidental drift through
   * general transition call sites.
   */
  allowUnlock?: boolean;
};

/**
 * The canonical transition matrix. Returns the new status, or throws.
 *
 *  active   ↔ archived      (via archive / activate)
 *  archived → active        (via activate)
 *  *        → locked        (via lock)            — admin/required-in-prod only
 *  locked   → active        (via unlock)          — admin only
 *  locked   ⊘  destructive  (archive/uninstall/force_delete/purge/registry_remove)
 *  update preserves current status (lock survives update).
 */
function transitionMatrix(
  current: ExtensionLifecycleStatus,
  op: LifecycleTransitionOp,
): ExtensionLifecycleStatus {
  if (op === "update") return current;

  // Locked is unmovable for destructive paths.
  if (current === "locked" && LOCKED_REJECTED_OPS.has(op)) {
    throw new LifecycleTransitionError(
      "LOCKED_REJECTS_OP",
      `Cannot ${op} — extension is locked. Update is allowed; archive is not.`,
      { from: current, op },
    );
  }

  if (op === "install") {
    if (current !== "active") {
      throw new LifecycleTransitionError(
        "ILLEGAL_TRANSITION",
        `install op cannot be applied to an existing ${current} row; use activate/unlock/source_switch`,
        { from: current, op },
      );
    }
    return "active";
  }

  if (op === "archive") return "archived";
  // `activate` re-surfaces an archived row but must PRESERVE a `locked` row's
  // lock — only the admin-gated `unlock` op may demote locked→active. Without
  // this, a package-wide restore (which fires `activate` across same-package
  // rows) could silently unlock a required-in-prod locked row.
  if (op === "activate") return current === "locked" ? "locked" : "active";
  if (op === "lock") return "locked";
  if (op === "unlock") {
    // Unlock is platform-admin only. The matrix is invoked from
    // `transitionExtensionLifecycle` which gates on opts.allowUnlock + a
    // platform_admin role before reaching here.
    return current === "locked" ? "active" : current;
  }
  if (op === "source_switch") return current; // preserves status

  // Destructive ops on non-locked rows: row is removed from the manifest
  // (the caller is responsible for actually invoking per-kind cleanup).
  if (DESTRUCTIVE_OPS.has(op)) return "archived"; // sentinel — caller decides delete vs archive

  throw new LifecycleTransitionError(
    "ILLEGAL_TRANSITION",
    `unknown lifecycle op '${op}'`,
    { from: current, op },
  );
}

/**
 * Install — creates a new manifest row at `active` (or `locked`) status; a
 * static-bundle ANCHOR row may also start `archived` (tombstone seed — see the
 * inline note below).
 */
export async function installExtensionManifest(
  // version / isDefault are OPTIONAL (cinatra#1040 S1): the canonical store
  // derives version from the source and defaults isDefault to true, so existing
  // install-row writers need no change (the version-aware write path is a later
  // slice).
  row: Omit<InstalledExtension, "createdAt" | "updatedAt" | "status" | "version" | "isDefault"> & {
    status?: ExtensionLifecycleStatus;
    version?: string;
    isDefault?: boolean;
  },
  opts: TransitionOpts,
): Promise<InstalledExtension> {
  if (!row.id) throw new LifecycleTransitionError("INVALID_INPUT", "id is required");
  if (!row.packageName) {
    throw new LifecycleTransitionError("INVALID_INPUT", "packageName is required");
  }
  let initialStatus: ExtensionLifecycleStatus = row.status ?? "active";
  // A static-bundle ANCHOR row (bundled-in-image provenance) may start
  // `archived`: the boot seeder writes the tombstone DIRECTLY when it anchors a
  // package that was retired before it was anchor-tracked, so there is never a
  // live-row window (or a fallible install-then-archive two-step) that could
  // resurrect the retired state. Every other source keeps the strict
  // active|locked start contract.
  const archivedAnchorStart =
    initialStatus === "archived" && isStaticBundleAnchorSource(row.source as ExtensionSource);
  if (initialStatus !== "active" && initialStatus !== "locked" && !archivedAnchorStart) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `install row cannot start at '${initialStatus}'; only active or locked allowed`,
    );
  }
  // required-in-prod → locked at the lowest write point. In production an
  // active required-in-prod install is coerced to `locked` here (so the row can
  // never start unlocked under prod); in dev we leave the chosen status alone
  // but emit a one-line advisory that prod would lock it. No new top-level
  // imports — this module is dynamically imported + concurrency-sensitive re
  // permissions-store resolution, so we read process.env + console.warn inline.
  if (row.requiredInProd === true) {
    const isDev = process.env.CINATRA_RUNTIME_MODE === "development";
    if (!isDev) {
      if (initialStatus === "active") initialStatus = "locked";
    } else if (initialStatus !== "locked") {
      // eslint-disable-next-line no-console
      console.warn(
        `[extensions] ADVISORY: required-in-prod package ${row.packageName} installed unlocked in dev mode; in production this would be locked.`,
      );
    }
  }
  // Provenance is verified, not asserted. Reject an install whose source block
  // is missing required provenance fields.
  const sourceErrors = validateExtensionSource(row.source);
  if (sourceErrors.length > 0) {
    throw new LifecycleTransitionError(
      "INVALID_INPUT",
      `install refused — source provenance invalid/missing: ${sourceErrors.join(", ")}`,
      { sourceErrors },
    );
  }
  // Connector org-anchor invariant (cinatra#1125): connector installs are
  // organization-owned by invariant — the canonical connector resolver
  // (connector-access-resolver.ts / extension-resource-identity.ts) reads a
  // connector ONLY at owner_level='organization' with owner_id =
  // organization_id, so a connector row at any other anchor is resolver-
  // invisible. Reject it at the single install chokepoint. The one legitimate
  // non-org connector shape is a platform/workspace STATIC-BUNDLE anchor (the
  // boot seeder's bundled-provenance anchor/tombstone rows) — allowed through
  // ONLY when the source is actually a static-bundle anchor, so a non-bundled
  // platform/workspace connector (e.g. a verdaccio install) cannot slip past
  // as resolver-invisible. The M1 migration (core__0017) normalizes any
  // pre-existing stray rows; this guard keeps the invariant closed going forward.
  if (row.kind === "connector") {
    const isBundleAnchor =
      (row.ownerLevel === "platform" || row.ownerLevel === "workspace") &&
      isStaticBundleAnchorSource(row.source as ExtensionSource);
    const isOrgAnchor =
      row.ownerLevel === "organization" &&
      row.organizationId != null &&
      row.ownerId === row.organizationId;
    if (!isBundleAnchor && !isOrgAnchor) {
      throw new LifecycleTransitionError(
        "INVALID_INPUT",
        `connector install must be organization-anchored (owner_level='organization', ` +
          `owner_id = organization_id) or a static-bundle platform/workspace anchor; got ` +
          `owner_level='${row.ownerLevel}', owner_id='${row.ownerId}', ` +
          `organization_id='${row.organizationId ?? "null"}', source.type='${
            (row.source as { type?: string } | null)?.type ?? "null"
          }'`,
      );
    }
  }
  return _internalInsertInstalledExtension({ ...row, status: initialStatus });
}

/**
 * Generic status transition.
 *
 * The lifecycle primitive returns the new row; for `force_delete` / `purge`
 * / `registry_remove` / `uninstall` of a non-used non-locked row the row IS
 * removed and the function returns `null` — EXCEPT `uninstall` of a
 * static-bundle ANCHOR row (bundled-in-image provenance, see
 * static-bundle-anchor.ts), which writes an archived tombstone and returns the
 * archived row so the bundled package stays lifecycle-tracked. The primitive
 * never yanks/deletes from Verdaccio — only the local manifest row.
 */
export async function transitionExtensionLifecycle(
  id: string,
  op: LifecycleTransitionOp,
  opts: TransitionOpts,
): Promise<InstalledExtension | null> {
  const ext = await readInstalledExtensionById(id);
  if (!ext) {
    throw new LifecycleTransitionError(
      "EXT_NOT_FOUND",
      `installed_extension '${id}' not found`,
    );
  }

  // Unlock is platform-admin only. Without an explicit opts.allowUnlock +
  // platform_admin role, the op is refused so general-purpose call sites cannot
  // silently demote a lock.
  if (op === "unlock") {
    const isPlatformAdmin = (opts.actor.roles ?? []).includes("platform_admin");
    if (!opts.allowUnlock || !isPlatformAdmin) {
      throw new LifecycleTransitionError(
        "LOCKED_REJECTS_OP",
        "unlock requires opts.allowUnlock=true AND actor.roles must include 'platform_admin'",
        { from: ext.status, op, actorSource: opts.actor.source },
      );
    }
  }

  const newStatus = transitionMatrix(ext.status, op);

  // Hard-delete paths: remove the row from the manifest. Verdaccio is NOT
  // touched here.
  if (op === "uninstall" || op === "force_delete" || op === "purge" || op === "registry_remove") {
    if (ext.status === "locked") {
      // already thrown above, but defense-in-depth
      throw new LifecycleTransitionError("LOCKED_REJECTS_OP", `Cannot ${op} locked extension`);
    }
    // Static-bundle anchor TOMBSTONE: `uninstall` of the bundled lifecycle
    // anchor row (see static-bundle-anchor.ts) ARCHIVES it instead of deleting.
    // A bundled package's bytes ship in the image, so "uninstall" can only ever
    // mean "do not activate" — the archived tombstone makes that durable:
    // archive and uninstall converge on the same observable end-state, the
    // StaticBundleLoader's strict allow-list gate skips the package on the next
    // boot, and the boot seeder (which only creates an anchor when NONE exists)
    // can never resurrect the decision. Access-policy rows are preserved,
    // mirroring archive semantics. The deeper destructive ops
    // (`force_delete` / `purge` / `registry_remove`) intentionally KEEP
    // hard-delete semantics as the admin-grade factory reset: removing the
    // anchor row erases the lifecycle memory, so the next boot re-seeds the
    // package as live.
    if (op === "uninstall" && isStaticBundleAnchorSource(ext.source)) {
      if (ext.status === "archived") return ext; // idempotent re-uninstall
      return _internalUpdateInstalledExtensionStatus(id, "archived");
    }
    await _internalDeleteInstalledExtension(id);
    // Clean the polymorphic access rows for installed-extension-anchored
    // kinds (connector / artifact / workflow), whose resource_id IS this row's
    // id. agent / skill are NOT cleaned here — their permission resources are
    // keyed by agent_template / skill_package ids and are cleaned in their own
    // teardown paths (deleteAgentTemplate / uninstallSkillPackage); cleaning
    // here would be wrong-keyed. Best-effort: the row is already gone, so a
    // cleanup failure is logged, never thrown. Archive/restore (non-destructive)
    // intentionally PRESERVE access rows.
    if (ext.kind === "connector" || ext.kind === "artifact" || ext.kind === "workflow") {
      try {
        await deleteExtensionPermissions(ext.kind, id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[lifecycle] deleteExtensionPermissions failed for ${ext.kind}:${id} (row already removed):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return null;
  }

  if (newStatus === ext.status && op !== "update") return ext;
  return _internalUpdateInstalledExtensionStatus(id, newStatus);
}

/**
 * Rollback-only canonical delete of a NON-finalized install row.
 *
 * Used by the dispatcher's hot-install rollback to revert a placeholder /
 * half-install row that the SAME attempt just created and that the
 * real-integrity pipeline never finalized (never anchorable, never a healthy
 * install). It deliberately BYPASSES the lifecycle lock-via-transition matrix +
 * dependent-closure guards that `transitionExtensionLifecycle` applies to
 * destructive ops on HEALTHY rows — those guards protect live installs, and a
 * never-finalized placeholder is not a live install.
 *
 * The "non-finalized only" contract is SELF-ENFORCED here, not trusted from the
 * call site: this is a package-exported primitive, so any server-side workspace
 * code could import it. It therefore re-reads the row and refuses to delete
 * anything that is NOT genuinely non-finalized, where "non-finalized" is decided
 * SOLELY by the journal-aware signal (`isNonFinalizedLiveRowAware`) — the SAME
 * authoritative signal the dispatcher uses to pick rollbackable rows:
 *   - a missing row → no-op (idempotent; nothing to roll back);
 *   - an `archived` row → refused (the signal returns false — not a live
 *     placeholder the pipeline owns);
 *   - a finalized/healthy `active` row → refused (the signal returns false —
 *     deleting it would strand a real install; that is what the lifecycle
 *     lock/dependent guards exist to prevent);
 *   - a finalized/healthy `locked` row → refused (the signal returns false — a
 *     genuine admin/required-in-prod lock carrying real, finalized integrity is
 *     never a rollbackable placeholder).
 * Status is NOT a standalone discriminator here: `locked` is BOTH a legitimate
 * dispatcher placeholder state (a required-in-prod new install is created
 * `locked` while still carrying placeholder integrity — see
 * `syncCanonicalManifestInstall`) AND a healthy admin-lock state. Only the
 * journal-aware signal can tell the two apart, so a non-finalized `locked`
 * placeholder IS rollbackable (byte-equivalent to the pre-primitive caller, which
 * deleted any row this signal classed as non-finalized) while a finalized
 * `locked` row is protected. Refusals throw `LifecycleTransitionError`.
 *
 * CONCURRENCY CONTRACT: the read-guard-then-delete is NOT atomic on its own, so
 * the caller MUST hold the per-package install lock (`withInstallLock(packageName)`)
 * across the finalize/rollback decision — the dispatcher's `runHostInstall` does.
 * That lock serializes this rollback against the real-integrity pipeline's finalize
 * for the SAME package, so a row cannot be concurrently finalized between the guard
 * and the delete here (a concurrently-finalized row is NEVER dropped). The only
 * caller is that lock-held dispatcher path.
 *
 * Keeping the `_internal*` writer call inside the canonical primitive preserves
 * the drift-gate invariant (only this file + canonical-store touch the direct
 * writers).
 */
/**
 * Hard-delete a SIDE-BY-SIDE (non-default) version row (cinatra#1040 S3) — the
 * version-scoped teardown the dependency-batch compensation and the boot
 * sweeper use. NOT a general uninstall:
 *
 *  - refuses a DEFAULT row (`isDefault !== false`) — the package-scoped
 *    uninstall path owns those;
 *  - refuses a `locked` row (removal protection, as everywhere);
 *  - refuses when any OTHER row's persisted dependency edge still RESOLVES to
 *    this row (`resolvedInstallId`), REGARDLESS of that dependent's status —
 *    compensation runs in inverse install order, so dependents are gone
 *    first; a still-bound dependent (even an archived one, which a concurrent
 *    restore could re-activate) means this is NOT a safe teardown;
 *  - refuses when NO sibling live row of the same (package, scope) remains —
 *    a sole surviving row is not "side by side" (fail closed rather than
 *    orphaning the package's last install).
 *
 * The row's own edge rows cascade with the delete (FK); inbound resolved edges
 * are SET NULL by the FK (dependents, if any survived a partial compensation,
 * heal through the scoped name-lookup fallback). The content-store digest dir
 * is deliberately NOT touched — the store legitimately holds multiple digests
 * and the retention GC (#796) owns reaping. Callers MUST hold the per-package
 * install lock. Keeping the `_internal*` writer call inside the canonical
 * primitive preserves the single-writer rule the static reach checks enforce.
 */
export async function deleteSideBySideVersionRow(rowId: string): Promise<void> {
  const ext = await readInstalledExtensionById(rowId);
  if (!ext) return; // idempotent — already gone
  if (ext.isDefault !== false) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `deleteSideBySideVersionRow refused — extension '${rowId}' is the DEFAULT row for ` +
        `${ext.packageName}; route a default-row removal through transitionExtensionLifecycle`,
      { id: rowId, status: ext.status },
    );
  }
  if (ext.status === "locked") {
    throw new LifecycleTransitionError(
      "LOCKED_REJECTS_OP",
      `deleteSideBySideVersionRow refused — extension '${rowId}' is locked`,
      { id: rowId, status: ext.status },
    );
  }
  const siblings = await readInstalledExtensionsByPackageName(ext.packageName);
  const scopeOrg = ext.organizationId ?? null;
  const liveSiblings = siblings.filter(
    (r) =>
      r.id !== rowId &&
      (r.status === "active" || r.status === "locked") &&
      (r.organizationId ?? null) === scopeOrg,
  );
  if (liveSiblings.length === 0) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `deleteSideBySideVersionRow refused — '${rowId}' is the only live row for ` +
        `${ext.packageName} in its scope (not side-by-side); route through ` +
        `transitionExtensionLifecycle`,
      { id: rowId, status: ext.status },
    );
  }
  // Still-bound dependents: any row whose persisted edge resolves to this row
  // — REGARDLESS of its status (an archived dependent could be concurrently
  // restored; codex round-2) — refuses the teardown (fail closed —
  // inverse-order compensation should have removed them first). Check + delete
  // run ATOMICALLY in the guarded writer: the target row is locked FOR UPDATE
  // (conflicting with concurrent edge inserts' FK KEY SHARE locks), so a
  // dependent bound between check and delete is impossible (codex round-1).
  const { _internalDeleteSideBySideRowIfUnbound } = await import("./canonical-store");
  const result = await _internalDeleteSideBySideRowIfUnbound(rowId);
  if (!result.deleted && result.boundDependents.length > 0) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `deleteSideBySideVersionRow refused — live dependent(s) still resolve to '${rowId}': ` +
        result.boundDependents.join(", "),
      { id: rowId, status: ext.status },
    );
  }
}

/**
 * ROW-SCOPED canonical delete for batch compensation (cinatra#1042 slice-2).
 * Removes EXACTLY the given row — the freshly-installed (package, scope) row a
 * failed install batch must roll back — WITHOUT the package-global hard-delete
 * branch of `extensionRegistry.uninstall` (`handler.uninstall` by name +
 * `syncCanonicalPackageGlobalTransition` + package-global data teardown), which
 * would tear down same-package rows in OTHER scopes. UNLIKE
 * `deleteSideBySideVersionRow`, it accepts the DEFAULT / only-in-scope row —
 * compensation must remove the fresh default row. It uses the SAME atomic
 * unbound-checked writer (`_internalDeleteSideBySideRowIfUnbound`: locks the
 * target FOR UPDATE; a dependent bound between check and delete is impossible),
 * failing closed if a live dependent still resolves to the row (inverse-order
 * compensation removes dependents first, so this should not happen). The
 * polymorphic access rows keyed by THIS row id are cleaned (row-scoped, for the
 * installed-extension-anchored kinds); the package's by-name handler backing +
 * OTHER-scope rows are deliberately untouched — the whole point of the
 * row-scoped inverse. This is why an org-multi-tenant instance's rows are
 * provably safe and the auto-update loop can lift its org-rows fence.
 */
export async function deleteScopedCanonicalRow(rowId: string): Promise<void> {
  const ext = await readInstalledExtensionById(rowId);
  if (!ext) return; // idempotent — already gone
  if (ext.status === "locked") {
    throw new LifecycleTransitionError(
      "LOCKED_REJECTS_OP",
      `deleteScopedCanonicalRow refused — extension '${rowId}' is locked`,
      { id: rowId, status: ext.status },
    );
  }
  const { _internalDeleteSideBySideRowIfUnbound } = await import("./canonical-store");
  const result = await _internalDeleteSideBySideRowIfUnbound(rowId);
  if (!result.deleted && result.boundDependents.length > 0) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `deleteScopedCanonicalRow refused — live dependent(s) still resolve to '${rowId}': ` +
        result.boundDependents.join(", "),
      { id: rowId, status: ext.status },
    );
  }
  // Row-scoped access-row cleanup for the installed-extension-anchored kinds
  // (connector / artifact / workflow), whose `resource_id` IS this row id.
  // agent / skill permission resources are keyed by agent_template /
  // skill_package ids (package-global backing) and are NOT cleaned here — that
  // by-name teardown is exactly what the row-scoped inverse must avoid.
  // Best-effort: the row is already gone, so a cleanup failure is logged.
  if (ext.kind === "connector" || ext.kind === "artifact" || ext.kind === "workflow") {
    try {
      await deleteExtensionPermissions(ext.kind, rowId);
    } catch (err) {
      console.warn(
        `[lifecycle] deleteScopedCanonicalRow access-row cleanup failed for ${ext.kind}:${rowId} (row already removed):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function deleteNonFinalizedCanonicalRow(rowId: string): Promise<void> {
  const ext = await readInstalledExtensionById(rowId);
  // Missing row → nothing to roll back. Idempotent: a concurrent finalize/delete
  // may have already removed it.
  if (!ext) return;
  // Only a NON-finalized row may be hard-deleted by this rollback primitive. A
  // finalized/healthy live row (active OR a genuine admin/required-in-prod lock),
  // or an archived/restorable one, is protected by the ILLEGAL_TRANSITION refusal —
  // callers wanting to remove a healthy row MUST route through
  // `transitionExtensionLifecycle` (which applies the lock + dependent-closure
  // guards). The journal-aware signal is the SOLE discriminator: it already
  // distinguishes a non-finalized `locked` placeholder (rollbackable) from a
  // finalized `locked` admin-lock (protected), so a blanket status check here would
  // wrongly strand the former. Consults the SAME signal the dispatcher uses; the
  // `non-finalized-row` module is standalone (it never imports this file), so the
  // static import is cycle-free.
  const nonFinalized = await isNonFinalizedLiveRowAware({
    status: ext.status,
    source: ext.source,
    packageName: ext.packageName,
    organizationId: ext.organizationId,
  });
  if (!nonFinalized) {
    throw new LifecycleTransitionError(
      "ILLEGAL_TRANSITION",
      `deleteNonFinalizedCanonicalRow refused — extension '${rowId}' is not a non-finalized placeholder (status='${ext.status}'); route a healthy-row removal through transitionExtensionLifecycle`,
      { id: rowId, status: ext.status },
    );
  }
  await _internalDeleteInstalledExtension(rowId);
}

/**
 * Source-switch — explicit reinstall-with-provenance.
 * Identity (package name + scope) preserved; lifecycle status preserved;
 * provenance replaced.
 */
export async function sourceSwitchExtension(
  id: string,
  newSource: ExtensionSource,
  opts: TransitionOpts,
): Promise<InstalledExtension> {
  const ext = await readInstalledExtensionById(id);
  if (!ext) {
    throw new LifecycleTransitionError(
      "EXT_NOT_FOUND",
      `installed_extension '${id}' not found`,
    );
  }
  // Re-verify provenance on the NEW source before switching.
  const sourceErrors = validateExtensionSource(newSource);
  if (sourceErrors.length > 0) {
    throw new LifecycleTransitionError(
      "INVALID_INPUT",
      `source-switch refused — new source provenance invalid/missing: ${sourceErrors.join(", ")}`,
      { sourceErrors },
    );
  }
  // Connector org-anchor invariant (cinatra#1125) — enforced on source-switch
  // too, not just install. A source-switch preserves the row's ANCHOR
  // (owner_level / owner_id / organization_id) but REPLACES its provenance, so
  // switching an existing platform/workspace static-bundle connector to a
  // non-bundle source (verdaccio / local / github) would recreate exactly the
  // resolver-invisible non-bundled connector the install chokepoint rejects:
  // the canonical connector resolver (src/lib/connector-access-resolver.ts,
  // extension-resource-identity.ts) reads a connector ONLY at
  // owner_level='organization' with owner_id = organization_id. Evaluate the
  // SAME invariant against {existing anchor + NEW source}: the result must
  // remain either an organization anchor or a platform/workspace static-bundle
  // anchor. Legitimate connector switches pass — the boot seeder refreshes a
  // platform anchor to another bundled source (still a bundle anchor), and
  // recordProvenance / dev-recompile switch an ORG-anchored connector's
  // provenance (the org anchor is preserved). A bundled-connector→verdaccio/
  // local switch is the invariant break and is refused here.
  if (ext.kind === "connector") {
    const isBundleAnchor =
      (ext.ownerLevel === "platform" || ext.ownerLevel === "workspace") &&
      isStaticBundleAnchorSource(newSource);
    const isOrgAnchor =
      ext.ownerLevel === "organization" &&
      ext.organizationId != null &&
      ext.ownerId === ext.organizationId;
    if (!isBundleAnchor && !isOrgAnchor) {
      throw new LifecycleTransitionError(
        "INVALID_INPUT",
        `connector source-switch would break the org-anchor invariant — a connector must remain ` +
          `organization-anchored (owner_level='organization', owner_id = organization_id) or a ` +
          `static-bundle platform/workspace anchor; row is owner_level='${ext.ownerLevel}', ` +
          `owner_id='${ext.ownerId}', organization_id='${ext.organizationId ?? "null"}' and the new ` +
          `source.type='${
            (newSource as { type?: string } | null)?.type ?? "null"
          }' is not a static-bundle anchor`,
        {
          kind: ext.kind,
          ownerLevel: ext.ownerLevel,
          ownerId: ext.ownerId,
          organizationId: ext.organizationId,
          newSourceType: (newSource as { type?: string } | null)?.type ?? null,
        },
      );
    }
  }
  // status preserved (locked stays locked, archived stays archived).
  const updated = await _internalUpdateInstalledExtensionSource(id, newSource);
  return updated;
}

/**
 * Record the manifest-declared dependency edges on a canonical row — the
 * EDGE-PERSISTENCE writer (#180). The dispatcher's install seed is
 * deliberately `dependencies: []` (the manifest is not readable before
 * materialize), so every MATERIALIZING install path calls this at its
 * finalize seam with the edges the dual-read helper
 * (`manifest-dependencies.ts`) read from the verified manifest. Status /
 * provenance are untouched (this is a metadata write, not a lifecycle
 * transition); each entry is re-validated structurally so a malformed edge
 * can never reach the row, no matter the caller.
 */
export async function recordExtensionDependencies(
  id: string,
  dependencies: ExtensionDependency[],
  opts: TransitionOpts,
): Promise<InstalledExtension> {
  const ext = await readInstalledExtensionById(id);
  if (!ext) {
    throw new LifecycleTransitionError(
      "EXT_NOT_FOUND",
      `installed_extension '${id}' not found`,
    );
  }
  for (const dep of dependencies) {
    const problems = validateExtensionDependencyShape(dep, ext.packageName);
    if (problems.length > 0) {
      throw new LifecycleTransitionError(
        "INVALID_INPUT",
        `recordExtensionDependencies refused for ${ext.packageName} — malformed edge ` +
          `${JSON.stringify(dep)}: ${problems.join("; ")} (actor: ${opts.actor.source}, reason: ${opts.reason})`,
        { dep, problems },
      );
    }
  }
  return _internalUpdateInstalledExtensionMetadata(id, { dependencies });
}

/**
 * Record the RESOLVED connector access declaration on a canonical row — the
 * DECLARATION-PERSISTENCE writer (cinatra#951). The host config reader
 * validates `cinatra/config.json` (fail-closed) at registration/materialize
 * and calls this at the same finalize seam as `recordExtensionDependencies`,
 * so a finalized connector install implies a cached declaration. Status /
 * provenance are untouched (a metadata write, not a lifecycle transition);
 * the value is re-validated structurally so a malformed declaration can never
 * reach the row, no matter the caller. `null` explicitly clears the cache
 * (non-connector kinds never set it).
 */
export async function recordExtensionAccessDeclaration(
  id: string,
  declaration: ResolvedConnectorAccessDeclaration | null,
  opts: TransitionOpts,
): Promise<InstalledExtension> {
  const ext = await readInstalledExtensionById(id);
  if (!ext) {
    throw new LifecycleTransitionError(
      "EXT_NOT_FOUND",
      `installed_extension '${id}' not found`,
    );
  }
  if (declaration !== null && !isResolvedConnectorAccessDeclaration(declaration)) {
    throw new LifecycleTransitionError(
      "INVALID_INPUT",
      `recordExtensionAccessDeclaration refused for ${ext.packageName} — malformed ` +
        `declaration ${JSON.stringify(declaration)} (actor: ${opts.actor.source}, reason: ${opts.reason})`,
      { declaration },
    );
  }
  return _internalUpdateInstalledExtensionMetadata(id, { accessDeclaration: declaration });
}
