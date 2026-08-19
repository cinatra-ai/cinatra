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
// NULL-org fallback for an ORG-SCOPED actor), with TWO additions in
// cinatra#2698:
//
//   a. THE EFFECTIVE ROW comes FIRST. A live workspace-anchored row supersedes
//      every organization-anchored row of the same package: it reaches every
//      organization already, so an organization row beside it is redundant. The
//      superseded rows are removed from the candidate set BEFORE any scope
//      arithmetic runs, so the workspace row is the SOLE lifecycle target while
//      it lives. This is the owner ruling of 2026-08-16: one effective row, no
//      two-row screens, no coexistence to choose between.
//   b. A PLATFORM ADMIN whose own scope holds no row falls back to the org-NULL
//      rows, so the app-wide workspace row a platform admin installs is also a
//      row a platform admin can manage.
//
// The explicit `LifecycleRowSelector` (an `owner_level` tier) survives as
// MACHINERY ONLY, for the one genuine same-scope identity ambiguity the store
// still permits — a product-installed WORKSPACE row and a bundled PLATFORM
// anchor both sitting at the org-NULL scope. It is not a user-facing model and
// no screen offers it: nothing on any client can name a row, and no selector
// ever arrives as action INPUT from a browser. Since cinatra#2762 round 5 two
// server actions do TAKE one — the recovery pair (`retryExtensionActivation`,
// `rollBackExtensionToBundled`) — but it is minted SERVER-SIDE by the settings
// loader from the row it just resolved and closed over in the action, so it
// binds the action to the row the page described rather than letting it
// re-resolve from a package name. That is the opposite of a user-facing picker,
// and it can never widen reach: the resolver recomputes the addressable set from
// the ACTOR and only then filters it by the named tier. Where the effective rule
// still leaves two candidates and no selector is supplied, the resolver REFUSES
// `ambiguous_target` rather than guessing by package name. The standing check is
// a defense-in-depth safety net UNDER the resolver — the resolver is the primary
// bound.
// ---------------------------------------------------------------------------

import type { Actor } from "@cinatra-ai/extension-types";
import {
  EXTENSION_OWNER_LEVELS,
  isWorkspaceAnchoredRow,
  organizationRowAnchor,
  policyWidensToWorkspaceAnchor,
  WORKSPACE_ANCHOR_ROW_OWNERSHIP,
} from "./canonical-types";
import type {
  ExtensionOwnerLevel,
  InstallRowOwnership,
  InstalledExtension,
} from "./canonical-types";
import {
  applyInstallRowPrecedence,
  isStaticBundleAnchorSource,
} from "./static-bundle-anchor";


// ---------------------------------------------------------------------------
// THE §V RE-ANCHOR DESTINATION (cinatra#2694 / S5 #2802).
//
// The picker yields an AUDIENCE, not an anchor. This is the rule that turns one
// into the other, and it is the whole of change 2's narrowing arithmetic:
//
//   - a selection containing `workspace` or `admin` WIDENS — the destination is
//     the app-wide workspace anchor, whatever loci sit beside it (an org-anchored
//     row can never deliver those audiences: the cross-org guard fences it);
//   - otherwise the selection NARROWS to exactly ONE organization, resolved from
//     the selected organization / team / project loci. An owner-only selection
//     has no locus of its own, so it uses the platform admin's ACTIVE
//     organization;
//   - a missing, foreign or multi-organization destination is refused
//     `invalid_locus`, and the refusal writes nothing.
//
// The team→organization and project→organization walks are injected
// (`ReanchorLocusLookups`) so the rule stays testable without a database and so
// this module gains no store edge. The caller passes the actor's OWN
// organizations, which is what makes a foreign locus unresolvable: a locus that
// does not land inside one of them is refused rather than silently honoured.
// ---------------------------------------------------------------------------

/** Parent-organization walks for the collective loci a selection can name. */
export type ReanchorLocusLookups = {
  /** The organization a team belongs to, or null when it is not resolvable. */
  teamOrganization: (teamId: string) => Promise<string | null>;
  /** The organization a project belongs to, or null when it is not resolvable. */
  projectOrganization: (projectId: string) => Promise<string | null>;
};

export type ReanchorDestinationResolution =
  | { ok: true; anchor: InstallRowOwnership }
  | { ok: false; code: "invalid_locus" };

/**
 * Resolve the anchor a saved audience selection re-anchors the row to.
 *
 * `actorOrganizationIds` is the set of organizations the saving actor actually
 * holds — the same set the §V picker was built from. Every named locus must land
 * inside it; the legacy bare `org` token and any unknown token shape are refused
 * fail-closed rather than guessed at.
 */
export async function resolveReanchorDestination(
  tokens: readonly string[],
  ctx: {
    actorOrganizationIds: readonly string[];
    actorActiveOrganizationId: string | null;
    lookups: ReanchorLocusLookups;
  },
): Promise<ReanchorDestinationResolution> {
  if (policyWidensToWorkspaceAnchor(tokens)) {
    return { ok: true, anchor: WORKSPACE_ANCHOR_ROW_OWNERSHIP };
  }

  const held = new Set(ctx.actorOrganizationIds);
  const destinations = new Set<string>();
  for (const token of tokens) {
    if (token === "owner") continue; // carries no locus of its own
    let orgId: string | null = null;
    if (token.startsWith("org:")) {
      orgId = token.slice("org:".length);
    } else if (token.startsWith("team:")) {
      orgId = await ctx.lookups.teamOrganization(token.slice("team:".length));
    } else if (token.startsWith("project:")) {
      orgId = await ctx.lookups.projectOrganization(token.slice("project:".length));
    } else {
      // Bare legacy "org" is not a concrete locus, and an unknown token shape is
      // never guessed at.
      return { ok: false, code: "invalid_locus" };
    }
    if (orgId === null || orgId === "" || !held.has(orgId)) {
      return { ok: false, code: "invalid_locus" };
    }
    destinations.add(orgId);
  }

  if (destinations.size > 1) return { ok: false, code: "invalid_locus" };
  const orgId =
    destinations.size === 1
      ? [...destinations][0]!
      : (ctx.actorActiveOrganizationId ?? null);
  if (orgId === null || orgId === "" || !held.has(orgId)) {
    return { ok: false, code: "invalid_locus" };
  }
  return { ok: true, anchor: organizationRowAnchor(orgId) };
}

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
    /** The ATTRIBUTABLE reason, where the ambiguity has a named recovery
     *  (cinatra#2856). Optional and appended, so the message every existing
     *  ambiguity throws is unchanged. */
    public readonly reason?: string,
  ) {
    super(
      `Ambiguous lifecycle target for "${packageName}" in scope ${scope}: ${count} rows match a scope the org-anchor invariant guarantees is unique — refusing (data-integrity fault).` +
        (reason ? ` ${reason}` : ""),
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

// ---------------------------------------------------------------------------
// THE EFFECTIVE ROW (cinatra#2694 / S4 #2698, change 1) — owner ruling
// 2026-08-16: "Workspace: All" supersedes.
//
// A "Workspace: All" / "Workspace: Admins only" install writes ONE
// workspace-anchored row that reaches every organization by the same mechanism
// the bundled extensions use. An organization-anchored row of the SAME package
// beside it is therefore redundant, and presenting both would invent a two-row
// screen the design spec does not draw. So while a LIVE workspace row exists it
// is the package's EFFECTIVE row: every organization row is superseded, and a
// superseded row is never a candidate for anything — not the lifecycle target,
// not connector/runtime/dependency resolution, not an install preflight, not a
// settings/action dispatch.
//
// Supersession is expressed here ONCE, as a pure filter over an already-read row
// set, and every consumer reads THIS function. Two properties matter:
//
//  - It is keyed on the workspace row being LIVE (`active` / `locked`). Remove
//    the workspace install and the organization rows stop being superseded —
//    they do NOT come back to life (an archived row stays archived; change 4),
//    but they become addressable again, which is exactly what makes the ordinary
//    guarded restore path work for an authorized admin.
//  - It supersedes organization-ANCHORED rows only. A bundled `platform` anchor
//    at the org-NULL scope is a different tier serving a different purpose, and
//    the store permits it beside a workspace row; that is the one genuine
//    same-scope identity ambiguity the selector machinery below still exists for.
// ---------------------------------------------------------------------------

/** Live = the statuses that make a row the one in force (`archived` is not). */
function isLiveRow(row: InstalledExtension): boolean {
  return row.status === "active" || row.status === "locked";
}

/**
 * The LIVE workspace-anchored row for this package, or null.
 *
 * This single row IS the supersession rule: while it exists, every organization
 * row of the package is superseded. Narrow on purpose — a bundled `platform`
 * anchor at the same org-NULL scope is NOT this row (see
 * {@link isWorkspaceAnchoredRow}); it supersedes nothing.
 *
 * More than one live workspace row cannot exist (the org-NULL identity index
 * keys on `owner_level`), but if the store ever presented two, taking the first
 * would still be correct for the supersession question — "is a workspace install
 * in force?" — which is all this answers.
 */
export function findLiveWorkspaceRow(
  rows: readonly InstalledExtension[],
): InstalledExtension | null {
  return rows.find((r) => isLiveRow(r) && isWorkspaceAnchoredRow(r)) ?? null;
}

/**
 * The package's EFFECTIVE candidate rows: `rows` with every superseded
 * organization row removed.
 *
 * With a live workspace row present this returns the org-NULL rows only, so
 * every downstream question — which row does this actor address, which row does
 * a lifecycle op target, which row does a card render — resolves to the ONE row
 * in force. With no live workspace row it returns `rows` unchanged, so every
 * pre-S4 path is byte-identical.
 */
export function effectiveInstallRows(
  rows: readonly InstalledExtension[],
): readonly InstalledExtension[] {
  if (findLiveWorkspaceRow(rows) === null) return rows;
  return rows.filter((r) => (r.organizationId ?? null) === null);
}

/**
 * Was this row SUPERSEDED by a live workspace install of the same package?
 *
 * The read-side companion of {@link effectiveInstallRows}: an organization row
 * standing beside a live workspace row. Screens use it to keep a superseded row
 * out of the card/settings model without re-deriving the rule.
 */
export function isSupersededRow(
  row: InstalledExtension,
  rows: readonly InstalledExtension[],
): boolean {
  return (
    (row.organizationId ?? null) !== null && findLiveWorkspaceRow(rows) !== null
  );
}

/**
 * The AUDIENCE a live workspace install reaches.
 *
 * The two workspace targets persist an explicit audience token
 * (`accessTargetToInstallPolicy`): `workspace` → every workspace member,
 * `admin` → the owner-aware admin tier. The marketplace states the reach on the
 * card's existing disabled "Installed" pill — no new UI element. The LABEL
 * itself lives with the card copy (`screens/marketplace-card-model.ts`), which
 * is client-safe; this module is server-only.
 */
export type WorkspaceReachAudience = "workspace" | "admin";

/**
 * REVERSE INSTALL REFUSED (cinatra#2698, change 3).
 *
 * While a live workspace row exists the package IS installed for every
 * organization, so creating — or re-activating — an organization row for it is
 * not a narrower install, it is a second copy of something already in force.
 * The server install boundary refuses it with this typed error; the marketplace
 * never offers the action in the first place (the card reads "Installed
 * (Workspace: All)" / "Installed (Workspace: Admins only)"), so a caller that
 * reaches here bypassed the screen.
 */
export class WorkspaceInstallSupersedesError extends Error {
  /** Stable, transport-independent discriminant (see NoAddressableRowError). */
  public readonly code = "WORKSPACE_INSTALL_SUPERSEDES";
  constructor(public readonly packageName: string) {
    super(
      `"${packageName}" is already installed for the whole workspace — refusing to ` +
        `install it for a single organization (the workspace install already reaches ` +
        `every organization; remove it first if an organization-only install is wanted).`,
    );
    this.name = "WorkspaceInstallSupersedesError";
  }
}

/**
 * The install boundary's supersession guard: refuse an ORGANIZATION-anchored
 * install of a package that already carries a live workspace row.
 *
 * Called with the rows the dispatcher already read and the anchor the install
 * resolved, so it costs no extra query and cannot disagree with the row the
 * install would write. A workspace/platform-anchored install passes through
 * untouched — this is only about the reverse direction.
 */
export function assertNoWorkspaceSupersession(
  packageName: string,
  rows: readonly InstalledExtension[],
  anchor: { ownerLevel: string; organizationId: string | null },
): void {
  if ((anchor.organizationId ?? null) === null) return;
  if (findLiveWorkspaceRow(rows) === null) return;
  throw new WorkspaceInstallSupersedesError(packageName);
}

/**
 * The ROW SELECTOR (cinatra#2694 / S4 #2698) — MACHINERY, not a user-facing
 * model.
 *
 * The effective-row rule above answers "which row?" for every ordinary case, so
 * no screen renders a row picker. What survives is the internal ability to
 * re-address a row by its anchor TIER, for the one genuine identity ambiguity
 * the store still permits at a single scope — a product-installed WORKSPACE row
 * and a bundled PLATFORM anchor, both org-NULL, for one package. Its internal
 * users are the reinstall's second leg (which must land on the SAME row its
 * first leg removed), the update path's anchor read, and — since cinatra#2762
 * round 5 — the settings loader, which mints one from the row it resolved and
 * closes it over the recovery actions so they act on THAT row.
 *
 * WHAT ACTUALLY BOUNDS IT (cinatra#2762 round-5 convergence). The settings
 * mint is the only LEGITIMATE producer, but it is not the enforced boundary:
 * two of its consumers — `retryExtensionActivationFormAction` and
 * `rollBackExtensionToBundledFormAction` — are exported from a `"use server"`
 * module, so the selector is part of a client-invokable RPC payload and a
 * direct invocation can supply any value for it. The bound is therefore NOT the
 * secrecy of the parameter. It is, in order:
 *
 *   1. the caller must hold an ADMIN session (`requireAdminSession`);
 *   2. {@link validateLifecycleRowSelectorInput} refuses anything that is not
 *      exactly `{ ownerLevel: <one of EXTENSION_OWNER_LEVELS> }`, so the shape
 *      an annotation only DECLARES is actually checked at the wire;
 *   3. the resolver recomputes the addressable set from the ACTOR server-side
 *      and only THEN filters it by the named tier — so a forged but well-formed
 *      selector can only NARROW among rows that actor already addresses, never
 *      widen to one it does not;
 *   4. {@link assertActorWriteStandingOverRow} re-gates the row that survives.
 *
 * It names a TIER, never an id, which is what makes (3) a narrowing filter
 * rather than a lookup key.
 *
 * ABSENT selector = the effective rule alone: the actor's own scope resolves,
 * and a residual multi-row scope refuses `ambiguous_target` rather than guessing.
 * "Nothing is guessed by package name" is enforced by that refusal.
 */
export type LifecycleRowSelector = {
  /** The target row's own anchor tier (`organization` / `workspace` /
   *  `platform` / …) — see {@link LifecycleRowSelector}. */
  ownerLevel: ExtensionOwnerLevel;
};

/**
 * The outcome of RPC-boundary validation — a refusal carries an operator-facing
 * reason so the caller can attribute it instead of failing anonymously.
 */
export type LifecycleRowSelectorValidation =
  | { ok: true; selector: LifecycleRowSelector | null }
  | { ok: false; reason: string };

/**
 * VALIDATE a selector that arrived over the RPC boundary (cinatra#2762 round-5
 * convergence).
 *
 * A `rowSelector` parameter on an exported `"use server"` function is
 * deserialized from a client-controlled payload. A TypeScript annotation
 * declares its shape; it does not CHECK it — at runtime the parameter can be a
 * string, an array, an object with extra fields, or an `ownerLevel` outside the
 * enum. None of those can widen reach (the resolver filters the actor's own
 * addressable set), but an unchecked value is an unchecked value: an unknown
 * `ownerLevel` silently matches nothing and surfaces as `no_addressable_row`,
 * which reads to an operator as "you may not do this" rather than "you sent
 * nonsense", and extra fields are a shape this module never agreed to carry.
 *
 * So this is strict and total: absent/null is the legitimate "no selector"
 * case, and anything else must be EXACTLY `{ ownerLevel }` with `ownerLevel`
 * one of {@link EXTENSION_OWNER_LEVELS}. Everything else is refused with a
 * reason. Returns the NARROWED value so callers pass the validated selector
 * onward rather than the raw input.
 */
export function validateLifecycleRowSelectorInput(
  value: unknown,
): LifecycleRowSelectorValidation {
  if (value === undefined || value === null) return { ok: true, selector: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `the row selector must be an object, received ${Array.isArray(value) ? "an array" : typeof value}`,
    };
  }
  // Own enumerable keys only — the serialization boundary produces plain
  // objects, so an unexpected key is a payload this module did not agree to.
  const unknownKeys = Object.keys(value as Record<string, unknown>).filter(
    (key) => key !== "ownerLevel",
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      reason: `the row selector carries unknown field(s): ${unknownKeys.join(", ")}`,
    };
  }
  const { ownerLevel } = value as { ownerLevel?: unknown };
  if (
    typeof ownerLevel !== "string" ||
    !(EXTENSION_OWNER_LEVELS as readonly string[]).includes(ownerLevel)
  ) {
    return {
      ok: false,
      reason:
        `the row selector's ownerLevel must be one of ${EXTENSION_OWNER_LEVELS.join(", ")}, ` +
        `received ${JSON.stringify(ownerLevel)}`,
    };
  }
  return { ok: true, selector: { ownerLevel: ownerLevel as ExtensionOwnerLevel } };
}

/**
 * The ADDRESSABLE SET — every canonical row `actor` may operate a lifecycle op
 * on, split into its two arms (cinatra#2694 / S4 #2698).
 *
 * THE EFFECTIVE ROW COMES FIRST (cinatra#2698 change 1): the candidate set is
 * {@link effectiveInstallRows}`(rows)`, never `rows`. While a live workspace row
 * exists the package's organization rows are superseded and drop out BEFORE any
 * scope arithmetic — so a platform admin with an active organization resolves
 * the workspace row without naming anything, and an organization admin resolves
 * NOTHING (the workspace row serves their organization, but acting on it would
 * reach into every other one; they are told a platform administrator owns it).
 *
 * Two arms over that effective set, and the split between them is load-bearing:
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
  // Supersession BEFORE scope: a superseded organization row is not a candidate
  // for anyone, so it can never be resolved, greyed-in, or acted on.
  const effective = effectiveInstallRows(rows);
  const own = effective.filter((r) => (r.organizationId ?? null) === actorOrgId);
  // A NULL-org session's own scope IS the org-NULL rows, so the fallback is
  // empty there — otherwise `all` would carry each row twice and an explicit
  // selector would read the duplicate as an ambiguity.
  const platformFallback =
    actorOrgId !== null && isPlatformAdminActor(actor)
      ? effective.filter((r) => (r.organizationId ?? null) === null)
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
 * The candidate set is {@link addressableLifecycleRows} — the EFFECTIVE rows
 * (superseded organization rows already removed), narrowed by org-equality, plus
 * the platform-admin org-NULL fallback when the actor's own scope is empty. An
 * internal {@link LifecycleRowSelector} may then narrow that set to ONE ANCHOR
 * TIER, which is what tells a product-installed workspace row apart from a
 * bundled platform anchor at the same org-NULL scope (cinatra#2694 / S4 #2698).
 *
 * Zero matches → `no_addressable_row`; more than one → `ambiguous_target` (F6),
 * the deliberate refusal that keeps the system from guessing a row from the
 * package name. Pure + DB-free.
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
      /**
       * An ATTRIBUTABLE refusal message for the one ambiguity that has a named
       * recovery (cinatra#2856). Absent on every other ambiguity, which keeps
       * the generic copy it always had. The CODE is unchanged either way, so a
       * consumer that switches on `code` behaves exactly as before.
       */
      reason?: string;
    };

/**
 * Apply the SHARED source-precedence policy to an already-scoped candidate set
 * (cinatra#2762): a live marketplace install OVERRIDES the bundled fallback the
 * image always provides, and the bundled row stays the fallback underneath it.
 *
 * WHY IT BELONGS HERE. Supersession ({@link effectiveInstallRows}) drops only
 * superseded ORGANIZATION rows. The bundled anchor and a marketplace install of
 * the same package both sit at org-NULL, so both survive it and both reach the
 * count below — and a successful install therefore made every lifecycle op on
 * the package report `ambiguous_target`. That was visible in the product:
 * Archive, Activate and Reinstall rendered DISABLED with "More than one install
 * matches your scope" right after the install that created the pair, and Retry
 * activation / Roll back to bundled threw {@link AmbiguousLifecycleTargetError}
 * from {@link resolveLifecycleTargetRow}. Every row-picking seam already applies
 * this policy (`pickSingleActiveRow`, `pickSingleLiveRowAcrossOrgs`,
 * `pickActiveInstall`, the installed-rows model, the provider-connection
 * writer); the lifecycle resolver was the one that did not, so it disagreed with
 * all of them about which row is the package.
 *
 * DELIBERATELY NARROW — it only ever WIDENS two exact shapes, and every other
 * case keeps its old outcome byte-for-byte:
 *
 *   a. ALL-LIVE (the post-install pair). The shared policy is consulted only
 *      when every candidate is LIVE, because that is the set the policy speaks
 *      about — every other seam filters to live before calling it. The
 *      narrowing is taken only when it resolves to EXACTLY ONE row: the
 *      policy's other outcomes — two competing overrides (`[]`) and "leave the
 *      set alone" (a legacy/unknown provenance, bundled-only) — fall back to
 *      the original set, so two operator installs still refuse as
 *      `ambiguous_target` rather than turning into `no_addressable_row`.
 *
 *   b. THE POST-ROLLBACK PAIR (cinatra#2762 round 5). "Roll back to bundled"
 *      leaves {bundled row LIVE, install row ARCHIVED} — by construction, since
 *      the rollback archives the override and reactivates the bundle. Arm (a)
 *      bails on that set (it is not all-live), so the pair counted as two and
 *      the NEXT visit to the settings page answered `ambiguous_target` for every
 *      op: Activate greyed as "More than one install matches your scope",
 *      Retry / Roll back hidden. Rollback was a ONE-WAY DOOR — the recovery
 *      #2762 item 2 asks for could be taken once and never undone.
 *      {@link narrowByArchivedInstallPrecedence} resolves it to the ARCHIVED
 *      INSTALL, which is the row every op on that pair means:
 *        - `activate` (the settings Activate button / the marketplace Restore)
 *          addresses an ARCHIVED row by definition — this is the way back
 *          through the door, and it is the ONLY op that can reopen it;
 *        - `archive` then reads "Already archived" and Retry / Roll back hide
 *          on `lifecycleIsArchived`, which is the truth about that row;
 *        - `reinstall` targets the install, as it did before the rollback.
 *      Resolving to the LIVE BUNDLED row instead would say "Already active" and
 *      leave the archived install permanently unreachable — the one-way door
 *      with better copy.
 *      Arm (b) reaches that pair only where it is the WHOLE candidate set. The
 *      ORG-SIBLING variant — the same pair sitting in the platform-admin
 *      fallback arm, hidden by an organization row supersession just released —
 *      is {@link strandedOrgSiblingWayBackRow} (cinatra#2856).
 *
 * It selects a candidate and nothing else: standing is still gated over the
 * resolved row by the caller, and no trust, integrity or journal gate moves.
 */
function narrowByInstallSourcePrecedence(
  candidates: readonly InstalledExtension[],
): readonly InstalledExtension[] {
  if (candidates.length < 2) return candidates;
  if (!candidates.every(isLiveRow)) return narrowByArchivedInstallPrecedence(candidates);
  const ranked = applyInstallRowPrecedence(candidates);
  return ranked.length === 1 ? ranked : candidates;
}

/** A DEFAULT marketplace install row — the override half of the shared source
 *  policy, restated here because {@link applyInstallRowPrecedence} takes LIVE
 *  rows by contract and this arm is about a row that is deliberately not. */
function isMarketplaceDefaultRow(row: InstalledExtension): boolean {
  return row.isDefault !== false && row.source?.type === "verdaccio";
}

/**
 * Arm (b) of {@link narrowByInstallSourcePrecedence}: the {live bundled,
 * archived install} pair a completed rollback leaves behind.
 *
 * Every clause is a REFUSAL to widen anything else:
 *   - EXACTLY ONE archived default marketplace install. Two archived installs
 *     have no single answer to "which one did the operator mean", and that is
 *     precisely the guess this resolver exists not to make;
 *   - every OTHER candidate is a LIVE BUNDLED fallback row. A second live
 *     marketplace install beside an archived one is a genuine ambiguity (the
 *     live one is serving and the archived one is restorable — both are real
 *     targets); a row of any other provenance means the ranking is unknown;
 *   - at least one such live bundled row must be present, so this can never
 *     turn a single-archived-row set into anything but itself.
 * Anything else returns the input unchanged and keeps its pre-existing verdict.
 */
function narrowByArchivedInstallPrecedence(
  candidates: readonly InstalledExtension[],
): readonly InstalledExtension[] {
  const archivedInstalls = candidates.filter(
    (r) => !isLiveRow(r) && isMarketplaceDefaultRow(r),
  );
  if (archivedInstalls.length !== 1) return candidates;
  const target = archivedInstalls[0];
  const rest = candidates.filter((r) => r !== target);
  if (rest.length === 0) return candidates;
  const everyOtherIsLiveBundled = rest.every(
    (r) => isLiveRow(r) && isStaticBundleAnchorSource(r.source),
  );
  return everyOtherIsLiveBundled ? archivedInstalls : candidates;
}

/**
 * The ORG-SIBLING variant of the way back (cinatra#2856), the one shape
 * {@link narrowByArchivedInstallPrecedence} cannot reach.
 *
 * THE DEFECT (groganz, cinatra#2762 round 6). Arm (b) above reopens the
 * rollback door only where the post-rollback pair is the WHOLE candidate set —
 * the org-NULL scope on its own. It never sees the pair when an ORGANIZATION
 * sibling exists, and the reason is the two-arm gate in
 * {@link resolveLifecycleScope}: the org-NULL rows reach a platform admin's
 * org-scoped session through arm 2 ({@link addressableLifecycleRows}
 * `platformFallback`), which is consulted ONLY while arm 1 is empty.
 *
 * That gate is exactly what a rollback flips:
 *   - BEFORE, the workspace install is LIVE, so supersession
 *     ({@link effectiveInstallRows}) removes the organization sibling, arm 1 is
 *     empty, arm 2 runs and the platform admin resolves — and operates — the
 *     app-wide install from their org-scoped session;
 *   - "Roll back to bundled" archives it. Supersession LIFTS, the organization
 *     sibling returns to arm 1, and arm 2 goes dark WITH the archived install
 *     inside it. The page silently retargets to the organization's own row and
 *     the app-wide install has no affordance at all in that session.
 * Same one-way door #2774 closed, surviving in the org-sibling variant.
 *
 * WHY THIS REFUSES RATHER THAN REOPENING. Arm (b) could resolve its pair
 * because every op on it meant the same row. Here the two candidates are both
 * real and mean different rows: the organization's own LIVE install, and the
 * archived app-wide install that is still restorable. Reopening would have to
 * pick, and picking the archived org-NULL row over a live own-scope row would
 * silently retarget an administrator's destructive ops across tiers — breaking
 * arm 2's standing invariant that it "only ever converts a REFUSAL into a
 * resolution", never replaces a row the actor resolves today. This module's
 * doctrine for exactly that state is already written down: where the effective
 * rule leaves two candidates and no selector is supplied, REFUSE rather than
 * guess. So the arm does not invent a verdict — it stops HIDING the second
 * candidate, and the one-way door becomes an ambiguity the operator can
 * attribute and act on ({@link REASON_ORG_SIBLING_WAYBACK} names the recovery,
 * which is the half a bare `ambiguous_target` never had).
 *
 * DELIBERATELY NARROW, mirroring arm (b) clause for clause — it changes the
 * verdict for ONE shape and every other case keeps its outcome byte-for-byte:
 *   - NO SELECTOR. A named tier already reaches the archived install from this
 *     very session (`addressable.all` is arm 1 PLUS arm 2, filtered by tier), so
 *     the selector path is not stranded and must not move;
 *   - arm 1 is NON-EMPTY — that, and only that, is what makes arm 2 invisible;
 *     an empty arm 1 already runs arm 2 and lands on arm (b). The clause below
 *     restates what arm 1 already guarantees whenever arm 2 is populated (every
 *     own-scope row is anchored to the actor's organization), so the arm can
 *     never be inherited by some future arm-1 content. It keys on the ARM, not
 *     on the sibling's TIER: a `user`- or `team`-anchored row inside the same
 *     organization strands the install identically, and a tier check there
 *     would fix the reviewer's example while leaving its twin silent;
 *   - arm 2 holds the POST-ROLLBACK PAIR and nothing else: at least two rows
 *     that {@link narrowByArchivedInstallPrecedence} — the SAME predicate arm
 *     (b) uses, not a second copy of the rule — narrows to exactly one row,
 *     and that row is an archived default marketplace install at the WORKSPACE
 *     anchor. A lone archived row, two archived installs, an archived bundle,
 *     a non-default install or an unknown provenance is not this shape and is
 *     left alone;
 *   - arm 2 is non-empty only for a PLATFORM ADMIN in an org-scoped session, so
 *     no other principal can reach this arm at all.
 *
 * Returns the stranded row so the refusal can name it in the resolver's own
 * terms; it selects nothing and no gate moves.
 */
function strandedOrgSiblingWayBackRow(addressable: {
  own: readonly InstalledExtension[];
  platformFallback: readonly InstalledExtension[];
}): InstalledExtension | null {
  const { own, platformFallback } = addressable;
  if (own.length === 0) return null;
  if (!own.every((r) => (r.organizationId ?? null) !== null)) return null;
  // The PAIR, not merely "a narrowing result": a single-row fallback narrows to
  // itself, which is not the state a rollback leaves.
  if (platformFallback.length < 2) return null;
  const narrowed = narrowByArchivedInstallPrecedence(platformFallback);
  if (narrowed.length !== 1) return null;
  const stranded = narrowed[0];
  return !isLiveRow(stranded) &&
    isMarketplaceDefaultRow(stranded) &&
    isWorkspaceAnchoredRow(stranded)
    ? stranded
    : null;
}

/**
 * The copy for {@link strandedOrgSiblingWayBackRow}'s refusal. It lives here
 * rather than with the capability strings below because the RESOLVER produces
 * it — the capability layer only forwards it — and because it is the one
 * ambiguity message that must stay glued to the arm that can emit it.
 *
 * Scope-shaped like the rest of the copy: no row id, no organization id. It
 * deliberately DOES name "no active organization", the clause cinatra#2698
 * removed from the standing copy — there it sent an administrator to clear
 * their active organization for no reason, because a platform admin addresses
 * an org-NULL row from any session; HERE it is the literal recovery, since a
 * platform-scoped session is the session in which arm (b) resolves the archived
 * install and Activate is the way back through the door.
 */
const REASON_ORG_SIBLING_WAYBACK =
  "Two installs match your scope: this organization's own install, and the " +
  "archived app-wide install. Clear your active organization to restore the " +
  "app-wide install.";

export function resolveLifecycleScope(
  rows: readonly InstalledExtension[],
  actor: Actor,
  selector?: LifecycleRowSelector | null,
): LifecycleScopeResolution {
  const addressable = addressableLifecycleRows(rows, actor);
  const scoped = selector
    ? // NAMED TIER → THE ACTOR'S OWN ADDRESSABLE SET, filtered to it. The filter
      // is applied to `addressable.all`, which was just recomputed from the
      // ACTOR — so this narrows, and can never reach a row the actor does not
      // already address, whoever produced the selector.
      addressable.all.filter((r) => r.ownerLevel === selector.ownerLevel)
    : // NO SELECTOR — the ordinary path, and the ONLY path any screen or action
      // takes: the actor's own scope, and only if it is empty the platform-admin
      // org-NULL fallback. With the effective-row filter above, a platform admin
      // whose organization row was superseded lands on the workspace row here.
      addressable.own.length > 0
      ? addressable.own
      : addressable.platformFallback;
  const candidates = narrowByInstallSourcePrecedence(scoped);
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
  // cinatra#2856 — the ORG-SIBLING way back. Only where arm 1 resolved cleanly
  // and arm 2 is therefore dark: the arm speaks about the candidate the gate
  // above HID, so it is consulted after the ordinary verdicts, never instead of
  // them. An already-ambiguous set keeps the generic refusal it always had.
  if (!selector) {
    const stranded = strandedOrgSiblingWayBackRow(addressable);
    if (stranded !== null) {
      return {
        ok: false,
        code: "ambiguous_target",
        packageName: candidates[0].packageName,
        scope: scopeLabel(actor),
        count: candidates.length + 1,
        reason: REASON_ORG_SIBLING_WAYBACK,
      };
    }
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
    resolution.reason,
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

// cinatra#2698 (rework): `normalizeLifecycleRowSelector` is GONE — it had grown
// into a user-facing "pick a row" model. cinatra#2762 round 5 then gave the two
// recovery actions a `rowSelector` parameter, and round-5 convergence corrected
// the claim that went with it: those actions are exported from a `"use server"`
// module, so their parameter IS reachable from the wire even though the product
// only ever feeds it from the server-side mint
// ({@link lifecycleRowSelectorFor}). The successor is therefore
// {@link validateLifecycleRowSelectorInput} — a strict shape check at that
// boundary, NOT a normalizer that coerces a client hint into a target. The
// selector still cannot widen reach; validation is what makes the refusal
// attributable instead of anonymous.

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
      : // cinatra#2856: the resolver attributes the one ambiguity that has a
        // named recovery; every other one keeps the generic copy verbatim.
        deny(op, "ambiguous_target", resolution.reason ?? REASON_AMBIGUOUS);
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
