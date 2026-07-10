import "server-only";

// ---------------------------------------------------------------------------
// Row-scoped lifecycle target resolver (admin-parity P5, cinatra#1130).
//
// Lifecycle dispatch used to be package-scoped and identity-agnostic:
// `syncCanonicalManifestTransition(packageName, ...)` looped EVERY canonical
// `installed_extension` row for the package name — one per org that installed
// it plus the platform NULL-org row. That was safe only while the entry gate
// was platform-admin-only. The epic (#1124) widens standing to org owner/admin,
// so an unscoped fan-out would let ONE org admin's archive / uninstall /
// force_delete destroy every OTHER org's row and the platform row — a cross-org
// privilege-escalation destructive-auth breach.
//
// This module is the load-bearing fix: it resolves a destructive lifecycle op
// to EXACTLY ONE row — the actor-org's row — fail-closed, and provides the
// write-standing predicate that keys the platform NULL-org row to platform-admin
// standing only (closing the P3 read predicate's "NULL-org row is addressable by
// any authenticated actor" branch for WRITES; reads are unchanged).
//
// The resolution is org-equality ONLY (no fallthrough to another org's row and
// no NULL-org fallback for an org actor). The standing check is a defense-in-
// depth safety net UNDER the resolver — the resolver is the primary bound.
// ---------------------------------------------------------------------------

import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "./canonical-types";

// ---------------------------------------------------------------------------
// Errors — all fail-closed refusals. The dispatcher lets them propagate as the
// structured refusal (never a silent no-op, never a fallthrough).
// ---------------------------------------------------------------------------

/** No canonical row is addressable in the actor's resolved scope — the actor's
 *  org never installed the package (org actor), or there is no platform NULL-org
 *  row (platform-admin, no org context). NEVER falls through to another org's
 *  row or the platform row (F1 / F5 / F7). */
export class NoAddressableRowError extends Error {
  constructor(
    public readonly packageName: string,
    public readonly scope: string,
  ) {
    super(
      `No addressable installed_extension row for "${packageName}" in scope ${scope} — refusing (the actor's scope has no row to act on).`,
    );
    this.name = "NoAddressableRowError";
  }
}

/** More than one row matches the actor's resolved scope — a data-integrity
 *  fault (the org-anchor invariant guarantees ≤1 row per (package, org)). Fail
 *  closed rather than pick an arbitrary row (F6). */
export class AmbiguousLifecycleTargetError extends Error {
  constructor(
    public readonly packageName: string,
    public readonly scope: string,
    public readonly count: number,
  ) {
    super(
      `Ambiguous lifecycle target for "${packageName}" in scope ${scope}: ${count} rows match a scope the org-anchor invariant guarantees is unique — refusing (data-integrity fault).`,
    );
    this.name = "AmbiguousLifecycleTargetError";
  }
}

/** The actor does not hold destructive-write standing over the resolved row —
 *  defense in depth under the resolver (should be impossible for an org actor by
 *  the org-equality resolution; the safety net for a NULL-org row an org actor
 *  must never write, F2). */
export class LifecycleStandingError extends Error {
  constructor(
    public readonly packageName: string,
    public readonly rowId: string,
  ) {
    super(
      `Actor lacks destructive-write standing over installed_extension "${rowId}" (${packageName}) — refusing.`,
    );
    this.name = "LifecycleStandingError";
  }
}

/** The op is platform-admin-only (hard-delete uninstall + force_delete, whose
 *  handler/teardown/run-row side effects are package-global). An org admin is
 *  refused with ZERO row changes (F8). */
export class PlatformAdminRequiredError extends Error {
  constructor(public readonly op: string) {
    super(
      `${op} is platform-admin-only in P5 (its handler / data-teardown / run-row side effects are package-global) — refusing.`,
    );
    this.name = "PlatformAdminRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Standing primitives (pure)
// ---------------------------------------------------------------------------

/** A platform admin — retains instance-wide reach (but the op is still
 *  row-targeted, never package-fanned). */
export function isPlatformAdminActor(actor: Actor): boolean {
  return actor.platformRole === "platform_admin";
}

/**
 * Does the actor hold DESTRUCTIVE-WRITE standing over a row anchored to
 * `rowOrgId`? Mirrors P3's `actorHasAdminStandingOverRow` with the NULL-org
 * branch CLOSED to platform-admin:
 *   - a platform_admin holds standing over every row (including NULL-org);
 *   - an org_owner/org_admin holds standing over rows anchored to THEIR active
 *     org (a non-null org id equal to the actor's `orgId`).
 * A NULL-org row (platform-scoped install) yields standing ONLY for a platform
 * admin — this is the P3-read-vs-P5-write divergence the keystone gap requires.
 * Keyed on the ROW's own org (cross-org safe): an admin of org A never gains
 * standing over an org-B or platform row.
 */
export function actorHasWriteStandingOverRow(
  actor: Actor,
  rowOrgId: string | null,
): boolean {
  if (isPlatformAdminActor(actor)) return true;
  return (
    rowOrgId != null &&
    actor.orgId != null &&
    rowOrgId === actor.orgId &&
    (actor.orgRole === "org_owner" || actor.orgRole === "org_admin")
  );
}

/** The standing role that grants the actor authority over the resolved row, or
 *  null if none — recorded on the audit reason so an audit reader sees which
 *  role authorized the transition. */
export function actorStandingRole(
  actor: Actor,
  rowOrgId: string | null,
): "platform_admin" | "org_owner" | "org_admin" | null {
  if (isPlatformAdminActor(actor)) return "platform_admin";
  if (
    rowOrgId != null &&
    actor.orgId != null &&
    rowOrgId === actor.orgId &&
    (actor.orgRole === "org_owner" || actor.orgRole === "org_admin")
  ) {
    return actor.orgRole;
  }
  return null;
}

/** Human-readable scope descriptor for error/audit messages. */
function scopeLabel(actor: Actor): string {
  const org = actor.orgId ?? null;
  return org == null ? "platform (NULL-org)" : `org ${org}`;
}

// ---------------------------------------------------------------------------
// Pure resolution — org-equality ONLY
// ---------------------------------------------------------------------------

/**
 * From all canonical rows for a package name, pick the SINGLE row in the actor's
 * resolved scope. `actorOrgId = actor.orgId ?? null`; the target is the row
 * whose `organizationId === actorOrgId`:
 *   - a NULL active-org selects ONLY NULL-org (platform) rows — never falls
 *     through to an org row (F7);
 *   - a non-null org selects ONLY that org's row — never another org's or the
 *     platform row (F1 / F5).
 * Zero matches → {@link NoAddressableRowError}; more than one →
 * {@link AmbiguousLifecycleTargetError} (F6). Pure + DB-free (unit-testable).
 *
 * This does NOT check standing — resolve first, then gate on standing over the
 * resolved row (the dispatcher order; standing is the safety net, resolution is
 * the primary bound).
 */
export function pickLifecycleTargetRow(
  rows: readonly InstalledExtension[],
  actor: Actor,
): InstalledExtension {
  const actorOrgId = actor.orgId ?? null;
  const candidates = rows.filter(
    (r) => (r.organizationId ?? null) === actorOrgId,
  );
  if (candidates.length === 0) {
    throw new NoAddressableRowError(
      rows[0]?.packageName ?? "<unknown>",
      scopeLabel(actor),
    );
  }
  if (candidates.length > 1) {
    throw new AmbiguousLifecycleTargetError(
      candidates[0].packageName,
      scopeLabel(actor),
      candidates.length,
    );
  }
  return candidates[0];
}

/** Assert the actor holds destructive-write standing over `row`, else throw
 *  {@link LifecycleStandingError}. Defense in depth under the resolver. */
export function assertActorWriteStandingOverRow(
  actor: Actor,
  row: InstalledExtension,
): void {
  if (!actorHasWriteStandingOverRow(actor, row.organizationId)) {
    throw new LifecycleStandingError(row.packageName, row.id);
  }
}

// ---------------------------------------------------------------------------
// IO wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve the SINGLE lifecycle target row for `(packageName, actor)`:
 *   1. read the package's canonical rows (fail-closed: a read failure PROPAGATES
 *      — the destructive op refuses, never fans out — F3);
 *   2. pick the row in the actor's scope (org-equality, {@link pickLifecycleTargetRow});
 *   3. gate on destructive-write standing over that row
 *      ({@link assertActorWriteStandingOverRow}).
 * Returns the resolved {@link InstalledExtension} (never null; refusals throw).
 */
export async function resolveLifecycleTargetRow(
  packageName: string,
  actor: Actor,
): Promise<InstalledExtension> {
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const row = pickLifecycleTargetRow(rows, actor);
  assertActorWriteStandingOverRow(actor, row);
  return row;
}

/** Compact identity of the resolved row for audit provenance — the
 *  escalation-detection signal (an org-A admin audit row must never carry an
 *  org-B / NULL-org row id). */
export type ResolvedRowIdentity = {
  id: string;
  organizationId: string | null;
  ownerLevel: string;
  ownerId: string | null;
};

export function resolvedRowIdentity(row: InstalledExtension): ResolvedRowIdentity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
  };
}

/** The transition-reason / audit label carrying the actor standing + resolved
 *  scope, e.g. `org_admin archive of org acme row iext_ab12`. */
export function lifecycleTransitionLabel(
  actor: Actor,
  op: string,
  row: InstalledExtension,
): string {
  const role = actorStandingRole(actor, row.organizationId) ?? "unknown-standing";
  const scope = row.organizationId == null ? "platform (NULL-org)" : `org ${row.organizationId}`;
  return `${role} ${op} of ${scope} row ${row.id}`;
}
