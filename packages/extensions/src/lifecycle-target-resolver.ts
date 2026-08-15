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
// The resolution is org-equality (no fallthrough to another org's row and no
// NULL-org fallback for an ORG-SCOPED actor), with ONE addition in cinatra#2698:
// a PLATFORM ADMIN whose own scope holds no row falls back to the org-NULL rows,
// so the app-wide workspace-anchored row a platform admin installs is also a row
// a platform admin can manage. Where more than one row is addressable, the
// operator's explicit `LifecycleRowSelector` (an `owner_level` tier — the full
// row identity's discriminator) picks one; without it the resolver REFUSES
// `ambiguous_target` rather than guessing by package name. The standing check is
// a defense-in-depth safety net UNDER the resolver — the resolver is the primary
// bound.
// ---------------------------------------------------------------------------

import type { Actor } from "@cinatra-ai/extension-types";
import { EXTENSION_OWNER_LEVELS } from "./canonical-types";
import type { ExtensionOwnerLevel, InstalledExtension } from "./canonical-types";

// ---------------------------------------------------------------------------
// Errors — all fail-closed refusals. The dispatcher lets them propagate as the
// structured refusal (never a silent no-op, never a fallthrough).
// ---------------------------------------------------------------------------

/** No canonical row is addressable in the actor's resolved scope — the actor's
 *  org never installed the package (org actor), or there is no platform NULL-org
 *  row (platform-admin, no org context). NEVER falls through to another org's
 *  row or the platform row (F1 / F5 / F7). */
export class NoAddressableRowError extends Error {
  /** Stable, transport-independent discriminant (cinatra#2416). Duck-typed by
   *  callers across the dynamic-import boundary, where `instanceof` is unsafe. */
  public readonly code = "NO_ADDRESSABLE_ROW";
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
  /** Stable discriminant (cinatra#2416) — see NoAddressableRowError. */
  public readonly code = "AMBIGUOUS_LIFECYCLE_TARGET";
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
  /** Stable discriminant (cinatra#2416) — see NoAddressableRowError. */
  public readonly code = "NO_LIFECYCLE_WRITE_STANDING";
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
  /** Stable discriminant (cinatra#2416) — see NoAddressableRowError. */
  public readonly code = "PLATFORM_ADMIN_REQUIRED";
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
 * The ROW SELECTOR (cinatra#2694 / S4 #2698) — the operator's explicit choice of
 * WHICH canonical row a lifecycle operation targets, where more than one is
 * addressable.
 *
 * Under S1 one package may carry BOTH an org-anchored row and an org-NULL
 * WORKSPACE-anchored row (and, for a bundled package, an org-NULL PLATFORM
 * anchor as well) — the DB's org-NULL identity index keys on `owner_level`, so
 * that coexistence is a shape the store permits. `owner_level` is therefore the
 * discriminator, and it is the WHOLE selector: it names a TIER, never an id, so
 * the value is safe to round-trip through a client surface and safe to log. It
 * is also never TRUSTED input — the resolver recomputes the addressable set from
 * the actor server-side and then filters it by this tier, so a forged selector
 * can only ever narrow an actor to a row they could already address, never widen
 * them to one they could not.
 *
 * ABSENT selector = today's behaviour exactly: the actor's own scope resolves,
 * and a genuine multi-row scope refuses `ambiguous_target` rather than guessing.
 * "Nothing is guessed by package name" is enforced by that refusal.
 */
export type LifecycleRowSelector = {
  /** The target row's own anchor tier (`organization` / `workspace` /
   *  `platform` / …) — see {@link LifecycleRowSelector}. */
  ownerLevel: ExtensionOwnerLevel;
};

/**
 * The ADDRESSABLE SET — every canonical row `actor` may operate a lifecycle op
 * on, split into its two arms (cinatra#2694 / S4 #2698).
 *
 * Two arms, and the split between them is load-bearing:
 *
 *  1. OWN SCOPE — rows whose `organizationId` equals `actor.orgId ?? null`.
 *     This is the pre-S4 rule, untouched: an org actor sees exactly their org's
 *     rows (never another org's, never a platform row — F1 / F5), a NULL-org
 *     actor sees exactly the org-NULL rows (never an org row — F7).
 *
 *  2. ORG-NULL FALLBACK, PLATFORM ADMIN ONLY — the org-NULL rows, for an actor
 *     whose own scope holds NONE. This is the slice's widening, and it is
 *     exactly the epic's sentence "platform admins can address org-NULL rows;
 *     org-scoped actors keep exactly their org rows": a platform admin with an
 *     ACTIVE ORGANIZATION could not previously address the app-wide
 *     workspace-anchored row at all (`no_addressable_row`), which left such a
 *     row lifecycle-UNMANAGEABLE for the very principal who installed it — a
 *     "Workspace: All" install is platform-admin-only. An ORG-SCOPED actor is
 *     NOT given this arm: the workspace row serves every organization, so
 *     archiving/updating it from one org would reach into every other one — the
 *     cross-org destructive-auth breach this module exists to prevent.
 *
 * WITHOUT an explicit selector, arm 2 is consulted ONLY when arm 1 is empty, so
 * it can never REPLACE a row the actor resolves today: every actor whose own
 * scope holds a row resolves that row, byte-identically to before this slice,
 * and arm 2 only ever converts a REFUSAL into a resolution — for a platform
 * admin only.
 *
 * WITH a selector the two arms are ONE set: the operator has named a tier, and
 * the whole point of naming it is to reach the app-wide row from a session whose
 * own organization ALSO holds a row for the package. That is the coexistence
 * case this slice exists for, so a preference order there would defeat it.
 */
export function addressableLifecycleRows(
  rows: readonly InstalledExtension[],
  actor: Actor,
): {
  /** The actor's OWN scope — the pre-S4 candidate set, arm 1. */
  own: readonly InstalledExtension[];
  /** Arm 2, PLATFORM ADMIN ONLY and org-scoped sessions only: the org-NULL rows
   *  the actor's own scope does not already contain. Empty for everyone else. */
  platformFallback: readonly InstalledExtension[];
  /** Everything addressable, own-scope first and duplicate-free. */
  all: readonly InstalledExtension[];
} {
  const actorOrgId = actor.orgId ?? null;
  const own = rows.filter((r) => (r.organizationId ?? null) === actorOrgId);
  // A NULL-org session's own scope IS the org-NULL rows, so the fallback is
  // empty there — otherwise `all` would carry each row twice and an explicit
  // selector would read the duplicate as an ambiguity.
  const platformFallback =
    actorOrgId !== null && isPlatformAdminActor(actor)
      ? rows.filter((r) => (r.organizationId ?? null) === null)
      : [];
  return { own, platformFallback, all: [...own, ...platformFallback] };
}

/**
 * The addressing rule, expressed ONCE as a total (non-throwing) verdict
 * (cinatra#2416). Both consumers read this SAME function:
 *   • the ENFORCEMENT path — {@link pickLifecycleTargetRow}, a thin throwing
 *     wrapper (error classes, messages and package-name selection unchanged);
 *   • the UI CAPABILITY path — {@link evaluateLifecycleCapability}, so the
 *     settings page's enabled/disabled state cannot drift from the refusal.
 * There is deliberately no second implementation of "which row may this actor
 * address" anywhere in the codebase, and none on the client at all.
 *
 * The candidate set is {@link addressableLifecycleRows} (org-equality, plus the
 * platform-admin org-NULL fallback when the actor's own scope is empty). An
 * explicit {@link LifecycleRowSelector} then narrows that set to ONE ANCHOR
 * TIER — the FULL row identity, `owner_level` included, which is what tells a
 * product-installed workspace row apart from a bundled platform anchor at the
 * same org-NULL scope (cinatra#2694 / S4 #2698).
 *
 * Zero matches → `no_addressable_row`; more than one → `ambiguous_target` (F6),
 * which is the deliberate refusal that makes the operator pick a row instead of
 * the system guessing one from the package name. Pure + DB-free.
 *
 * This does NOT check standing — resolve first, then gate on standing over the
 * resolved row (the dispatcher order; standing is the safety net, resolution is
 * the primary bound).
 */
export type LifecycleScopeResolution =
  | { ok: true; row: InstalledExtension }
  | { ok: false; code: "no_addressable_row"; packageName: string; scope: string }
  | {
      ok: false;
      code: "ambiguous_target";
      packageName: string;
      scope: string;
      count: number;
    };

export function resolveLifecycleScope(
  rows: readonly InstalledExtension[],
  actor: Actor,
  selector?: LifecycleRowSelector | null,
): LifecycleScopeResolution {
  const addressable = addressableLifecycleRows(rows, actor);
  const candidates = selector
    ? // NAMED TIER → the whole addressable set, filtered to it. This is how an
      // operator reaches the app-wide workspace row from a session whose own
      // organization also holds a row for the package.
      addressable.all.filter((r) => r.ownerLevel === selector.ownerLevel)
    : // NO SELECTOR → the actor's own scope, and only if it is empty the
      // platform-admin org-NULL fallback. Byte-identical to the pre-S4 rule
      // wherever the actor's own scope holds a row.
      addressable.own.length > 0
      ? addressable.own
      : addressable.platformFallback;
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no_addressable_row",
      // Unchanged selection: with NO candidate there is no candidate name to
      // use, so the message falls back to the first row's package name (or
      // "<unknown>" when the package has no rows at all).
      packageName: rows[0]?.packageName ?? "<unknown>",
      scope: scopeLabel(actor),
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: "ambiguous_target",
      packageName: candidates[0].packageName,
      scope: scopeLabel(actor),
      count: candidates.length,
    };
  }
  return { ok: true, row: candidates[0] };
}

/**
 * Throwing form of {@link resolveLifecycleScope} — THE enforcement entry point.
 * Zero matches → {@link NoAddressableRowError}; more than one →
 * {@link AmbiguousLifecycleTargetError} (F6).
 */
export function pickLifecycleTargetRow(
  rows: readonly InstalledExtension[],
  actor: Actor,
  selector?: LifecycleRowSelector | null,
): InstalledExtension {
  const resolution = resolveLifecycleScope(rows, actor, selector);
  if (resolution.ok) return resolution.row;
  if (resolution.code === "no_addressable_row") {
    throw new NoAddressableRowError(resolution.packageName, resolution.scope);
  }
  throw new AmbiguousLifecycleTargetError(
    resolution.packageName,
    resolution.scope,
    resolution.count,
  );
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
  selector?: LifecycleRowSelector | null,
): Promise<InstalledExtension> {
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const row = pickLifecycleTargetRow(rows, actor, selector);
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

/**
 * The resolved row's OWN ANCHOR as the install-write tuple (cinatra#2698).
 *
 * This is the "recreate preserves the row's own anchor" primitive: the update
 * and reinstall paths used to hand the dispatcher the ACTOR's scope, so an
 * update of a workspace-anchored row would have written its new version against
 * an org-anchored row (a silent re-anchor that would have FORKED the app-wide
 * install into one organization's). Feeding the row's own tuple back in keeps
 * the identity — `(organization_id, owner_level, owner_id)` — exactly where it
 * was.
 */
export function lifecycleRowAnchor(row: InstalledExtension): {
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
} {
  return {
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
  };
}

/**
 * Normalize an UNTRUSTED selector (a server-action argument, an MCP input) to
 * either a valid selector or null.
 *
 * The selector cannot widen anyone's reach — the addressable set is recomputed
 * from the actor server-side and the selector only filters it — but a "use
 * server" export takes its arguments from the client, so the SHAPE is checked
 * here rather than trusted from a TypeScript annotation that does not exist at
 * runtime. An unrecognized tier yields null, which means "no selector": the
 * addressing rule then resolves the actor's single row, or refuses.
 */
export function normalizeLifecycleRowSelector(
  input: unknown,
): LifecycleRowSelector | null {
  if (input == null || typeof input !== "object") return null;
  const level = (input as { ownerLevel?: unknown }).ownerLevel;
  return typeof level === "string" &&
    (EXTENSION_OWNER_LEVELS as readonly string[]).includes(level)
    ? { ownerLevel: level as ExtensionOwnerLevel }
    : null;
}

/** The row's own {@link LifecycleRowSelector} — so a multi-step operation
 *  (reinstall = uninstall THEN install) re-addresses the SAME row on its second
 *  leg instead of re-resolving from scratch and possibly landing elsewhere. */
export function lifecycleRowSelectorFor(row: InstalledExtension): LifecycleRowSelector {
  return { ownerLevel: row.ownerLevel };
}

// ---------------------------------------------------------------------------
// Per-affordance CAPABILITY (cinatra#2416).
//
// The settings page used to render every lifecycle affordance enabled and let
// the server refuse — the enabled-but-always-refused defect class #2400 fixed
// for role data, here for ROW SCOPE. The fix is NOT a client-side copy of the
// addressing rule: this module — the one that ENFORCES — also answers "may this
// actor run this op?", and the page renders that answer. Same functions, same
// order, same inputs as the dispatcher:
//
//   archive / activate / uninstall → resolveLifecycleScope (the addressing
//       rule) THEN actorHasWriteStandingOverRow over the resolved row, exactly
//       as `resolveLifecycleTargetRow` does before every one of those ops.
//   force_delete                   → isPlatformAdminActor ONLY. `forceDelete`
//       is PACKAGE-GLOBAL and takes NO row resolver (index.ts), so row scope is
//       irrelevant to it: a platform admin WITH an active org legitimately
//       force-deletes a platform-anchored row (proven live in #2400). Marking
//       it unavailable on scope would mint a NEW UI/dispatcher disagreement —
//       the very defect this issue is about, inverted.
//
// The verdict is a CLOSED, serializable value: no row identity, no actor scope
// and no org ids cross to the client, so nothing here can become trusted action
// input. `reason` is resolved server-side because `no_addressable_row` has three
// fact-dependent messages; the client only renders a string.
//
// NOT an operation-will-succeed oracle — this is the ADDRESSABILITY/STANDING
// gate only. `allowed: true` still faces the closure gate, the locked-row guard,
// the system-extension guard and (for reinstall) the registry/install legs.
// ---------------------------------------------------------------------------

export type LifecycleCapabilityOp =
  | "archive"
  | "activate"
  | "uninstall"
  | "force_delete";

export const LIFECYCLE_CAPABILITY_OPS: readonly LifecycleCapabilityOp[] = [
  "archive",
  "activate",
  "uninstall",
  "force_delete",
];

export type LifecycleCapabilityDenialCode =
  | "no_addressable_row"
  | "ambiguous_target"
  | "no_write_standing"
  | "platform_admin_required"
  /** The canonical read the addressing rule needs FAILED. Fail-CLOSED: the
   *  dispatcher would propagate that same read failure and refuse, so offering
   *  a live control would recreate the defect. */
  | "indeterminate";

/** Discriminated so `allowed: false` always carries copy and `allowed: true`
 *  never does — an "enabled with a reason" state is unrepresentable. */
export type LifecycleCapability =
  | { op: LifecycleCapabilityOp; allowed: true; code: "ok"; reason: null }
  | {
      op: LifecycleCapabilityOp;
      allowed: false;
      code: LifecycleCapabilityDenialCode;
      reason: string;
    };

export type LifecycleCapabilityMap = Record<
  LifecycleCapabilityOp,
  LifecycleCapability
>;

export type LifecycleCapabilityDescription = {
  /** SERVER-ONLY. The row the dispatcher will target — used by the settings
   *  loader to describe the row the action actually acts on (not the collapsed
   *  card row). Never serialized to the client. */
  resolution: LifecycleScopeResolution;
  /**
   * SERVER-ONLY. A locked canonical row for this package IN ANY SCOPE, or null.
   *
   * The lock is a PACKAGE-WIDE refusal, not a row-scoped one:
   * `assertNoLockedCanonicalRow` refuses archive / uninstall / force_delete when
   * ANY canonical row for the package is locked, whatever scope it is anchored
   * to. So a UI that described the lock from the TARGET row alone would render
   * an affordance live while a locked sibling deterministically refuses it —
   * the same enabled-but-refused defect this issue fixes. The settings loader
   * takes its locked/system reason from THIS row (codex-found, cinatra#2416).
   */
  lockedRow: InstalledExtension | null;
  byOp: LifecycleCapabilityMap;
};

// Copy. Deliberately non-technical and scope-shaped (never a row id, never an
// org id) — it is read by an administrator, not an operator. "Requires platform
// admin." is the app's EXISTING standing-refusal string (install-targets.ts /
// the design spec's §V Permissions rows), reused verbatim so the settings page
// speaks the same language as the access picker.
//
// A platform-anchored (NULL-org) row can refuse a caller for TWO
// separate reasons: the row is out of the caller's ADDRESSABLE scope (their
// active org does not match), or the row IS addressable but the caller lacks
// WRITE STANDING over it (not a platform admin). The old copy named only the
// first refusal ("an organization-scoped session can't act on it"), which
// reads as though clearing the active organization is sufficient — it is not:
// a platform-scoped, non-platform-admin caller is refused identically. Both
// refusals now share ONE reason naming the actual discriminator: the principal
// who CAN act, not the session shape that gets refused.
//
// cinatra#2698: the "with no active organization" clause is GONE. It described
// the pre-S4 addressing rule, where an org-NULL row was addressable only from a
// NULL-org session; a platform admin now addresses an org-NULL row from ANY
// session (addressableLifecycleRows arm 2), so the clause would send an
// administrator to clear their active organization for no reason. The principal
// named is unchanged: a platform administrator.
const REASON_PLATFORM_ROW_REQUIRES_PLATFORM_ADMIN =
  "Installed for the whole platform. Only a platform administrator can act on it.";
const REASON_ORG_ROW_FROM_PLATFORM_SESSION =
  "Installed by an organization — a platform-scoped session can't act on it.";
const REASON_NOT_IN_SCOPE = "Not installed in your current scope.";
const REASON_AMBIGUOUS =
  "More than one install matches your scope — contact an administrator.";
const REASON_NO_WRITE_STANDING =
  "Requires organization owner or admin role.";
const REASON_PLATFORM_ADMIN = "Requires platform admin.";
const REASON_INDETERMINATE =
  "Couldn't check this extension's install scope. Try again.";

/** Which "no addressable row" this is, in the administrator's terms. Reads the
 *  SAME rows the resolution read — it explains the verdict, it never re-decides
 *  it. */
function noAddressableRowReason(
  rows: readonly InstalledExtension[],
  actor: Actor,
): string {
  const actorOrgId = actor.orgId ?? null;
  const hasPlatformRow = rows.some((r) => (r.organizationId ?? null) === null);
  const hasOrgRow = rows.some((r) => (r.organizationId ?? null) !== null);
  if (actorOrgId !== null && hasPlatformRow) {
    return REASON_PLATFORM_ROW_REQUIRES_PLATFORM_ADMIN;
  }
  if (actorOrgId === null && hasOrgRow) {
    return REASON_ORG_ROW_FROM_PLATFORM_SESSION;
  }
  return REASON_NOT_IN_SCOPE;
}

function allow(op: LifecycleCapabilityOp): LifecycleCapability {
  return { op, allowed: true, code: "ok", reason: null };
}

function deny(
  op: LifecycleCapabilityOp,
  code: LifecycleCapabilityDenialCode,
  reason: string,
): LifecycleCapability {
  return { op, allowed: false, code, reason };
}

/**
 * The per-affordance verdict for ONE op, from the package's canonical rows +
 * the actor. Pure + DB-free. See the header for why force_delete diverges.
 */
export function evaluateLifecycleCapability(
  rows: readonly InstalledExtension[],
  actor: Actor,
  op: LifecycleCapabilityOp,
  selector?: LifecycleRowSelector | null,
): LifecycleCapability {
  if (op === "force_delete") {
    return isPlatformAdminActor(actor)
      ? allow(op)
      : deny(op, "platform_admin_required", REASON_PLATFORM_ADMIN);
  }
  const resolution = resolveLifecycleScope(rows, actor, selector);
  if (!resolution.ok) {
    return resolution.code === "no_addressable_row"
      ? deny(op, "no_addressable_row", noAddressableRowReason(rows, actor))
      : deny(op, "ambiguous_target", REASON_AMBIGUOUS);
  }
  if (actorHasWriteStandingOverRow(actor, resolution.row.organizationId)) {
    return allow(op);
  }
  // The row IS in the actor's scope here (a platform-scoped actor
  // facing a platform row, or an org actor facing their own org's row), so
  // this is the STANDING refusal, not the scope one. A NULL-org row's standing
  // requirement is platform-admin ONLY (actorHasWriteStandingOverRow never
  // grants it on org role); naming "organization owner or admin role" there
  // would describe a role that can never satisfy this row.
  const standingReason =
    resolution.row.organizationId === null
      ? REASON_PLATFORM_ROW_REQUIRES_PLATFORM_ADMIN
      : REASON_NO_WRITE_STANDING;
  return deny(op, "no_write_standing", standingReason);
}

/** Every op's verdict from one already-read row set (pure). */
export function evaluateLifecycleCapabilities(
  rows: readonly InstalledExtension[],
  actor: Actor,
  selector?: LifecycleRowSelector | null,
): LifecycleCapabilityMap {
  return {
    archive: evaluateLifecycleCapability(rows, actor, "archive", selector),
    activate: evaluateLifecycleCapability(rows, actor, "activate", selector),
    uninstall: evaluateLifecycleCapability(rows, actor, "uninstall", selector),
    force_delete: evaluateLifecycleCapability(rows, actor, "force_delete", selector),
  };
}

/**
 * IO wrapper — reads the package's canonical rows through the SAME store
 * function {@link resolveLifecycleTargetRow} reads, then evaluates.
 *
 * FAIL-CLOSED, narrowly: ONLY the canonical read is guarded. A read failure
 * marks the three row-scoped ops `indeterminate` (the dispatcher would refuse on
 * that same failure) while force_delete keeps its role-derived verdict — it
 * never consulted the row scope, so reporting "couldn't check the install scope"
 * for it would be a lie. Evaluation itself runs OUTSIDE the guard so a
 * programming defect surfaces instead of masquerading as `indeterminate`.
 */
export async function describeLifecycleCapabilities(
  packageName: string,
  actor: Actor,
  selector?: LifecycleRowSelector | null,
): Promise<LifecycleCapabilityDescription> {
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  let rows: InstalledExtension[] | null = null;
  try {
    rows = await readInstalledExtensionsByPackageName(packageName);
  } catch (err) {
    console.warn(
      "[lifecycle-capability] canonical read failed for %s — the row-scoped affordances fail CLOSED:",
      packageName,
      err instanceof Error ? err.message : err,
    );
  }
  if (rows === null) {
    const indeterminate = (op: LifecycleCapabilityOp) =>
      deny(op, "indeterminate", REASON_INDETERMINATE);
    return {
      resolution: {
        ok: false,
        code: "no_addressable_row",
        packageName,
        scope: scopeLabel(actor),
      },
      // Unknown — the caller falls back to whatever row it already holds.
      lockedRow: null,
      byOp: {
        archive: indeterminate("archive"),
        activate: indeterminate("activate"),
        uninstall: indeterminate("uninstall"),
        // Row scope was never an input to force_delete — keep the honest,
        // role-derived verdict rather than an invented scope failure.
        force_delete: evaluateLifecycleCapability([], actor, "force_delete"),
      },
    };
  }
  return {
    resolution: resolveLifecycleScope(rows, actor, selector),
    // Scope-blind ON PURPOSE — mirrors assertNoLockedCanonicalRow.
    lockedRow: rows.find((r) => r.status === "locked") ?? null,
    byOp: evaluateLifecycleCapabilities(rows, actor, selector),
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
