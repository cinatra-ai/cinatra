import "server-only";

// Installed-extension READ-MODEL (cinatra#657, Phase-A keystone).
//
// The issue enumerates per-record metadata an installed extension should expose:
// actor visibility, trust/signature verdict, source package-store record,
// activation generation, and teardown state. These are DERIVED / COMPUTED at
// query time — NOT new `installed_extension` columns and NOT a schema migration.
// This module assembles them on demand by JOINING the canonical row + the live
// trust verdict + the package-store record + the process control-plane generation.
//
// LIFECYCLE VOCABULARY (no schema change; the live model keeps the 3 statuses
// `[active, archived, locked]` — `packages/extensions/src/canonical-types.ts`).
// The issue's 5-state vocabulary is reconciled to the 3-status model + "no row":
//   - active   : a live, addressable row (running).
//   - locked   : a platform-required, host-trusted row (a system extension).
//   - archived ≈ disabled-but-recoverable : an addressable row whose status is
//                archived (the surface is hidden but the row + its data persist,
//                so a restore reactivates it). We DO NOT add a `disabled` status.
//   - absent   ≈ uninstalled : NO addressable row for this actor (never installed,
//                or hard-uninstalled — the canonical row is gone for this scope).
//
// CROSS-WORKER PROPAGATION — DECISION (cinatra#657): the activation generation +
// in-process capability teardown are PROCESS-LOCAL by design
// (`extension-activation-generation.ts`). This read-model surfaces this process's
// `activationGeneration` truthfully (a per-worker value), and the canonical
// row/status/trust fields are GLOBAL (read from the shared DB + package store) so
// the source-of-truth READ is correct on every web/worker/route handler NOW.
// Cross-worker LIVE-UNINSTALL propagation (an in-process teardown on worker A
// invalidating an already-warm in-process cache on worker B) is DEFERRED to a
// named follow-up — it spans Phase B/F (a DB-backed generation the per-request
// path compares against + lazy per-worker re-sync, OR a pub/sub teardown signal).
// PR-2 delivers the per-process runtime-sourced predicate + this read-model ONLY;
// it does NOT attempt cross-worker live-uninstall.
//
// SUPERSESSION (cinatra#2848). The row this model reports is the package's
// EFFECTIVE row: a live workspace-anchored install supersedes every organization
// row of the same package, and a superseded row is not a candidate for anything.
// The read model applies that rule FIRST, from the same helper the lifecycle
// target resolver applies (`effectiveInstallRows`), so a row the write-side
// seams refuse to address can never be the row a read-model-driven surface
// reports. There is no unfiltered consumer: every caller of
// `buildInstalledExtensionReadModel` asks "which row is in force for this actor",
// and the archived/restore surfaces that legitimately need a superseded row read
// the canonical store directly, not this model.
//
// ONE ROW, ONE VERDICT (cinatra#2848). The row pick above and the trust verdict
// below are TWO resolutions, and a record that mixes them describes no install
// that exists: the status/kind/ownerScope fields would come from the effective
// row while `trust`/`signatureVerified` came from another. The CG-5 serve gate
// consumes `status` and `trust` TOGETHER as one effective install, so a split
// record can authorize serving on a row the actor does not run. Two mechanisms
// keep the two resolutions on the SAME row:
//   1. TARGETED — the default anchor resolution is built for the PICKED ROW's
//      scope (`row.organizationId`, `org-then-workspace`), not the actor's, so
//      it lands on the row the read model reports rather than on a superseded
//      organization row of the same package.
//   2. PROVEN — the resolved anchor must carry the picked row's canonical id
//      (`anchor.installId === row.id`). Any disagreement, and any anchor that
//      cannot prove its identity at all, degrades `trust`/`signatureVerified`
//      to null. Fail-safe doctrine: a failure degrades the FIELD, never the
//      record — and `trust: null` is a DENY at the serve gate, never a pass.
// (1) is the correctness win; (2) is the backstop that holds even if the
// resolver's selection semantics ever drift from the effective-row rule.
//
// AUDIENCE (cinatra#2850). Addressability is not admission. The picked row is
// the package's effective row for the actor's SCOPE, but the row's own access
// policy — the audience the install was made FOR — decides whether this actor
// is part of it. The two workspace targets prove the gap: "Workspace: All" and
// "Workspace: Admins only" persist the SAME canonical row (the workspace
// anchor — `accessTargetToRowOwnership`, `install-access-target.ts`), and the
// audience that tells them apart lives ONLY in the access policy
// (`runListVisibility: ["workspace"] | ["admin"]`, `accessTargetToInstallPolicy`).
// Neither the addressability predicate (`isInstallRowAddressableByActor` — an
// org-NULL row is addressable by every authenticated actor, by design) nor the
// CG-5 serve gate (`decideRuntimeCubeServe`, which reads only `actorVisible` /
// `status` / `trust`) reads that policy. Without a gate HERE an ordinary member
// of any organization reads an ADMINS-ONLY workspace install as their own live,
// trusted install — and serves its runtime cubes.
//
// The gate CONSUMES the platform's own evaluator — `canExtensionAccess`
// (`enforce-extension-access.ts`), the same entry the install / render /
// dispatch / MCP-use paths call — with `op:"use"` (the data tier the serve gate
// authorizes; the dashboards catalog reader `installed-catalog-read.ts` admits
// on the same op for the same reason). The audience check is NOT restated here:
// co-owners, the installer pointer, the owner-aware `admin` tier and the
// no-policy-row default all come from that ONE evaluator, so this model can be
// neither more nor less permissive than the platform's own access decision.
//
// A row whose audience does not admit the actor is reported as `absent` — the
// established meaning of "no row is in force for this actor", the same answer
// another organization's row already gives. Fail-safe: a policy read that
// THROWS is not an admission; it degrades to `absent`, the same direction the
// canonical-store outage already takes. The gate runs BEFORE the anchor
// resolution above, so the `org-then-workspace` arm is reached only by an actor
// the row's audience admits.
//
// SCOPED TO THE KINDS THAT HAVE ONE. The canonical row's `kind` vocabulary
// (`agent | connector | artifact | skill | workflow`) is NOT the permissions
// resource-kind vocabulary, so the row kind is narrowed through
// `installRowResourceKind` (`permissions-kind-hooks.ts`) — the kinds whose
// polymorphic `resource_id` IS the `installed_extension.id`, which are exactly
// the kinds whose install persists an audience. For anything else the access
// resource lives in its own identity table (the skills catalog, `agent_runs`,
// `nango_connection`), so keying a policy read on an install row id there would
// authorize against a DIFFERENT resource — a lookup in the wrong identity
// space, not a stricter one. Such a row carries no install-row audience and is
// reported exactly as before. The CG-5 serve gate's source packages are
// connector rows, so the blocker's surface is fully covered.

import {
  readInstalledExtensionsByPackageName,
} from "@cinatra-ai/extensions/canonical-store";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
// THE supersession rule, expressed once (cinatra#2698 S4). This module CONSUMES
// it; it never re-derives it. See `pickAddressableRowForActor` below.
import { effectiveInstallRows } from "@cinatra-ai/extensions/lifecycle-target-resolver";
// THE install-row source-precedence policy, expressed once (cinatra#2774). Same
// contract as the line above: CONSUMED here, never re-derived. It is the step
// between supersession and the single-default rule in `pickAddressableRowForActor`.
import { applyInstallRowPrecedence } from "@cinatra-ai/extensions/static-bundle-anchor";
import {
  type PackageStoreFs,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  isInstallRowAddressableByActor,
  buildActorScopeForPick,
  type ActorScopeForPick,
} from "@/lib/extension-install-resolution";
import {
  verifyMaterializedPackageIntegrity,
  type InstallTrustAnchor,
} from "@/lib/extension-package-store";
import type {
  ExtensionAccessDecision,
  ExtensionAccessResource,
} from "@cinatra-ai/extensions/enforce-extension-access";
// Narrows a CANONICAL row kind to the permissions resource kind that addresses
// that ROW — null when the row is not itself the access resource.
import { installRowResourceKind } from "@cinatra-ai/extensions/permissions-kind-hooks";
import { classifyExtensionTrust, type TrustVerdict } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import { getActivationGeneration } from "@/lib/extension-activation-generation";

/**
 * The actor-scoped lifecycle status of an installed extension, reconciled to the
 * 3-status canonical model + "no row" (see the module docstring).
 *   - `active` | `locked` : a live, addressable row (running).
 *   - `archived`          : an addressable row, archived (hidden-but-recoverable).
 *   - `absent`            : no row is IN FORCE for this actor — never installed,
 *                           hard-uninstalled, out of the actor's scope, or (since
 *                           cinatra#2850) a row whose AUDIENCE does not admit
 *                           them (an admins-only install read by a member).
 */
export type ReadModelStatus = "active" | "locked" | "archived" | "absent";

/**
 * The teardown state of the extension's in-process capability registrations, as
 * known to THIS process. Process-local (see the cross-worker decision above):
 *   - `live`     : an addressable live row exists (the surface is active here).
 *   - `torn-down`: no addressable live row (archived/absent) — the in-process
 *                  capability-teardown hook removes its registrations on
 *                  archive/uninstall, so a non-live row means torn down here.
 */
export type ReadModelTeardownState = "live" | "torn-down";

/** The query-time per-record read-model the issue enumerates (cinatra#657). */
export type InstalledExtensionReadModel = {
  packageName: string;
  /**
   * Whether a row for this package is in force for the actor (live or archived):
   * addressable in their scope AND admitted by that row's access policy
   * (cinatra#2850). False is reported as `status: "absent"`.
   */
  actorVisible: boolean;
  /** Actor-scoped lifecycle status (3-status model + absent). */
  status: ReadModelStatus;
  /** The package KIND from the addressable row, or null when absent. */
  kind: InstalledExtension["kind"] | null;
  /** The owner scope of the addressable row, or null when absent. */
  ownerScope: {
    ownerLevel: InstalledExtension["ownerLevel"];
    ownerId: string | null;
    organizationId: string | null;
  } | null;
  /** The in-process import-trust verdict (anchor → integrity → signature → classify), or null when not resolvable. */
  trust: TrustVerdict | null;
  /** Whether a cryptographic signature verified against a host-trusted key (derived; null when unknown). */
  signatureVerified: boolean | null;
  /** Whether a materialized package-store record is present for this package. */
  sourcePackageStoreRecordPresent: boolean;
  /** This PROCESS's control-plane (activation) generation at read time. */
  activationGeneration: number;
  /** Process-local teardown state of the extension's in-process registrations. */
  teardownState: ReadModelTeardownState;
};

/** Real filesystem surface for store discovery (mirrors the runtime loader's). */
const realStoreFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
};

/**
 * The identity of the row the read model PICKED — the package's effective row
 * for this actor. Handed to the trust-anchor resolution so the verdict targets
 * (and is checked against) THAT row rather than the actor's own org scope
 * (cinatra#2848; see "ONE ROW, ONE VERDICT" in the module header).
 */
export type ReadModelAnchorTarget = {
  /** The picked row's canonical `installed_extension` id. */
  readonly installId: string | null;
  /** The picked row's OWN org scope — null for a workspace/platform anchor. */
  readonly organizationId: string | null;
};

export type InstalledExtensionReadModelDeps = {
  /** Read all canonical rows for a package (override for tests). */
  readRows?: (packageName: string) => Promise<InstalledExtension[]>;
  /** Discover store records (override for tests); defaults to the real `/data` store. */
  discoverRecords?: (storeRoot: string) => Promise<readonly PackageStoreRecord[]>;
  /**
   * Resolve the trusted install anchor (override for tests); null when no
   * real-pipeline install. Receives the PICKED ROW's identity so an injected
   * resolver can answer for the same row the model reports — the default
   * resolver is built for that row's scope, and the identity is re-checked
   * against `anchor.installId` either way.
   */
  resolveTrustAnchor?: (
    packageName: string,
    target: ReadModelAnchorTarget,
  ) => Promise<InstallTrustAnchor | null>;
  /** Re-verify the materialized package against the anchor (override for tests). */
  verifyIntegrity?: (
    record: PackageStoreRecord,
    anchor: InstallTrustAnchor,
  ) => Promise<boolean>;
  /** Classify trust (override for tests); defaults to the host classifier. */
  classifyTrust?: typeof classifyExtensionTrust;
  /** Package store root (override for tests). */
  storeRoot?: string;
  /** Read this process's control-plane generation (override for tests). */
  getActivationGeneration?: () => number;
  /**
   * Decide whether the actor is admitted by the PICKED row's ACCESS POLICY
   * (override for tests); defaults to the platform's own `canExtensionAccess`.
   * Injected rather than imported at module scope for the same reason the store
   * / anchor deps are: the extensions access modules reach the permissions store
   * and its Postgres connection, and nothing pays for that until a row actually
   * needs authorizing (cinatra#2850).
   */
  canAccessInstallRow?: (
    resource: ExtensionAccessResource,
    actor: ActorContext,
    op: "use",
  ) => Promise<ExtensionAccessDecision>;
};

const defaultVerifyIntegrity = (
  record: PackageStoreRecord,
  anchor: InstallTrustAnchor,
): Promise<boolean> =>
  verifyMaterializedPackageIntegrity(record, {
    trustedIntegrity: anchor.integrity,
    trustedContentHash: anchor.contentHash,
  });

function actorScopeForPick(actor: ActorContext): ActorScopeForPick {
  // Delegates to the shared builder so the admin-standing role fields
  // (platformRole/orgRole) are threaded — an admin resolves the read-model of a
  // row they do not personally own.
  return buildActorScopeForPick(actor);
}

/**
 * Pick the most-relevant addressable row for the actor: prefer a LIVE row
 * (active|locked) over an archived one (a live install wins the actor-visible
 * status), and within live prefer `active` over `locked`. Returns null when NO
 * row is addressable for the actor (status `absent`).
 *
 * SUPERSESSION FIRST (cinatra#2698 S4 / cinatra#2848) — the same order the
 * write-side seams apply, and the same order `addressableLifecycleRows` already
 * applies for lifecycle dispatch. A live WORKSPACE-anchored install is the
 * package's EFFECTIVE row and supersedes every organization row of that package,
 * so the superseded rows drop out BEFORE the scope filter and before the status
 * ranking. Order matters: supersession keys on the workspace row, which sits at
 * a DIFFERENT scope than the org rows it supersedes, so a scope filter applied
 * first can never see the pair — the superseded org row would simply be the only
 * candidate left and would be reported as the package's row.
 *
 * Without this the read model reported a row the write side had already refused
 * to address: a superseded organization row surfaced as the actor's `active`
 * install (kind, owner scope, teardown state and all), and every read-model-driven
 * surface — the CG-5 runtime-cube serve gate, `src/lib/dashboards/runtime-cube-serve-host.ts`
 * — decided from it.
 *
 * The rule is CONSUMED, not re-derived: {@link effectiveInstallRows} is the one
 * place supersession is written down. `rows` is always ONE package's rows here
 * (`readInstalledExtensionsByPackageName`), which is exactly the per-package row
 * set that helper is defined over. With no live workspace row it returns `rows`
 * unchanged, so every pre-S4 pick is byte-identical.
 *
 * THEN SOURCE PRECEDENCE, then the single-default rule, then the status ranking.
 * The full order is: supersession -> precedence -> single-default -> status
 * (cinatra#2850). The `[precedence]` slot this comment reserved is now FILLED by
 * the real policy {@link applyInstallRowPrecedence}, which landed on main with
 * cinatra#2774 — CONSUMED exactly like {@link effectiveInstallRows} above, never
 * re-derived. See the step itself in the body for what it does and does not move.
 */
function pickAddressableRowForActor(
  rows: readonly InstalledExtension[],
  scope: ActorScopeForPick,
): InstalledExtension | null {
  const addressable = effectiveInstallRows(rows).filter((r) =>
    isInstallRowAddressableByActor(r, scope),
  );
  if (addressable.length === 0) return null;
  // Cross-org rows (addressable only because a platform_admin sees every org)
  // rank AFTER the actor's own-org / workspace rows, so an admin's read-model
  // metadata comes from their active org rather than an arbitrary other org that
  // merely carries a better lifecycle status. Mirrors pickActiveInstallId's
  // same-org preference. For a non-admin every addressable row is already
  // same-org/workspace, so this key is uniform and status still decides.
  const isCrossOrg = (r: InstalledExtension): boolean =>
    r.organizationId !== null &&
    scope.organizationId !== null &&
    r.organizationId !== scope.organizationId;
  // SOURCE PRECEDENCE (cinatra#2774), the step BETWEEN supersession and the
  // single-default rule. A package that ships in the image AND has a marketplace
  // install holds two live default rows at once; the marketplace row is the
  // OVERRIDE and the bundled row is the fallback that stays underneath it. The
  // policy is written down once, in `applyInstallRowPrecedence`, and this module
  // CONSUMES it so the read model can never disagree with the anchor resolver and
  // the write-side seams about which row IS the package.
  //
  // OVER THE LIVE OWN-SCOPE ROWS, for two reasons the helper's own contract states.
  // (1) LIVE: it is defined over live candidates ("the caller filters to live rows
  // first"), and its override test does not read `status` — handed an archived
  // marketplace default beside a live bundled row it would select the ARCHIVED
  // one, inverting the status ranking below. Non-live rows therefore bypass this
  // step entirely and stay in the candidate set, ranked last by `statusRank` as
  // before. (2) OWN-SCOPE: precedence ranks provenance WITHIN a scope, the way
  // `pickExactOrgActiveRow` applies it after its own org filter. Run across orgs
  // it would let a platform admin's read come from another org's default row —
  // exactly what the same-org preference above exists to stop.
  const isLive = (r: InstalledExtension): boolean =>
    r.status === "active" || r.status === "locked";
  const ownScopeLive = addressable.filter((r) => !isCrossOrg(r) && isLive(r));
  const ranked = applyInstallRowPrecedence(ownScopeLive);
  // The helper's AMBIGUITY arm (more than one live marketplace default) returns
  // `[]` and delegates the fail-closed to "the caller's own rule". The seams that
  // BIND a row have an exactly-one rule, so `[]` correctly resolves to null there.
  // This caller's rule is a RANKING that always yields a row, and the read model
  // is DESCRIPTIVE: reporting `absent` — the model's word for uninstalled — while
  // two installs stand live would be an untruth, not a safe default. The safety
  // is already carried one layer down and unchanged: the anchor resolver applies
  // the SAME precedence, so on ambiguity it returns no anchor, the identity
  // backstop in `buildInstalledExtensionReadModel` nulls `trust`, and the CG-5
  // serve gate denies. So ambiguity falls through to the pre-#2774 ranking
  // BYTE-IDENTICALLY: this step only ever changes the pick when precedence
  // actually RESOLVES a bundled-versus-marketplace pair.
  const candidates =
    ranked.length === 0
      ? addressable
      : addressable.filter((r) => !ownScopeLive.includes(r) || ranked.includes(r));
  // SINGLE-DEFAULT RULE (cinatra#1040 S1), ranked BEFORE the status ranking.
  // Exactly one row per (org, owner, package) owns the package's unversioned
  // global name — `isDefault`, DB-enforced by a partial-unique index. A
  // side-by-side version install (`extension-side-by-side-install.ts`) creates
  // an explicitly NON-default row that stands LIVE beside that default, so a
  // package can legitimately present two `active` rows in ONE scope.
  //
  // The canonical read has no ORDER BY (`readInstalledExtensionsByPackageName`,
  // canonical-store.ts), so for such a pair the status ranking below is a TIE
  // and ARRAY ORDER decided the pick: the sibling could be reported as the
  // package's row. That is not merely arbitrary metadata — the default install
  // anchor resolver selects the exactly-one-DEFAULT row, so the identity
  // backstop in `buildInstalledExtensionReadModel` then found
  // `anchor.installId !== row.id`, nulled `trust`, and the CG-5 serve gate
  // DENIED a cube it had served before.
  //
  // Only an EXPLICIT `isDefault === false` is demoted — the same "drop a row
  // ONLY when it is explicitly non-default" reading the two DB-query projection
  // seams apply (canonical-types.ts) — so a legacy row or a fixture that never
  // set the flag still counts as the default and every pre-#1040 pick is
  // unchanged.
  const isNonDefault = (r: InstalledExtension): boolean => r.isDefault === false;
  const statusRank = (s: InstalledExtension["status"]): number =>
    s === "active" ? 0 : s === "locked" ? 1 : 2; // archived last
  return [...candidates].sort((a, b) => {
    // Cross-org stays the FIRST key, ahead of single-default: the one-default
    // invariant is per (org, owner, package), so "the default row" is only
    // meaningful WITHIN a scope. Ranking it above the scope key would let an
    // admin's read-model metadata come from another org's default row instead
    // of their own org's — exactly what the same-org preference exists to stop.
    const orgDelta = Number(isCrossOrg(a)) - Number(isCrossOrg(b));
    if (orgDelta !== 0) return orgDelta;
    const defaultDelta = Number(isNonDefault(a)) - Number(isNonDefault(b));
    if (defaultDelta !== 0) return defaultDelta;
    return statusRank(a.status) - statusRank(b.status);
  })[0];
}

/**
 * Assemble the query-time read-model for `packageName` + `actor`. All fields are
 * DERIVED — no new DB columns. Fail-safe: a store/anchor/trust read that throws
 * degrades that FIELD to null (the canonical status fields stay authoritative);
 * a null actor yields an `absent`, not-visible record.
 *
 * NOTE: the trust verdict here is DESCRIPTIVE (a read-model field for operators/
 * UIs). It is NOT a render/execute authorization — rendering a runtime
 * schema-config surface still passes the live trust gate in
 * `resolveRuntimeConnectorUiRecord`, and action endpoints keep their own gates.
 * It is, however, read TOGETHER with `status` by the CG-5 serve gate, so it
 * describes the PICKED row or is null — never another row of the package
 * (cinatra#2848; see "ONE ROW, ONE VERDICT" in the module header).
 */
export async function buildInstalledExtensionReadModel(
  packageName: string,
  actor: ActorContext | undefined | null,
  deps: InstalledExtensionReadModelDeps = {},
): Promise<InstalledExtensionReadModel> {
  const readActivationGeneration = deps.getActivationGeneration ?? getActivationGeneration;
  const activationGeneration = readActivationGeneration();

  const absent: InstalledExtensionReadModel = {
    packageName,
    actorVisible: false,
    status: "absent",
    kind: null,
    ownerScope: null,
    trust: null,
    signatureVerified: null,
    sourcePackageStoreRecordPresent: false,
    activationGeneration,
    teardownState: "torn-down",
  };

  if (!actor) return absent;

  const readRows = deps.readRows ?? readInstalledExtensionsByPackageName;
  let rows: InstalledExtension[];
  try {
    rows = await readRows(packageName);
  } catch {
    // Canonical-store outage: we cannot prove visibility — fail safe to absent
    // (never fabricate a row). This mirrors the predicate's outage handling.
    return absent;
  }

  const scope = actorScopeForPick(actor);
  const row = pickAddressableRowForActor(rows, scope);
  if (!row) return absent;

  // AUDIENCE GATE (cinatra#2850) — see "AUDIENCE" in the module header.
  // Addressability placed the row in the actor's SCOPE; the row's own access
  // policy decides whether the actor is in its AUDIENCE. Runs BEFORE the anchor
  // resolution below, so the `org-then-workspace` arm — which resolves a
  // workspace anchor for an org-scoped actor and is what flips this record from
  // no-trust to trusted — is reached only by an admitted actor.
  //
  // The decision is the platform's own `canExtensionAccess`, never a
  // restatement of it. `op:"use"` is the data tier: this record is consumed by
  // the CG-5 serve gate to authorize SERVING a runtime cube's data, so the
  // audience that governs data consumption is the one that must admit. (Every
  // policy this codebase writes — `accessTargetToInstallPolicy` and
  // `DEFAULT_EXTENSION_ACCESS_POLICY` — sets all three visibility fields to the
  // same token set, so list/read/use coincide today; `use` is the tier that
  // matches the consumer if they ever diverge.)
  //
  // The evaluator is imported HERE rather than at module scope: the extensions
  // access modules reach the permissions store and its Postgres connection, and
  // nothing pays for that until a row actually needs authorizing — the same
  // rationale `installed-catalog-read.ts` records for its own deferred import.
  const resourceKind = installRowResourceKind(row.kind);
  if (resourceKind) {
    let audience: ExtensionAccessDecision;
    try {
      const canAccessInstallRow =
        deps.canAccessInstallRow ??
        (await import("@cinatra-ai/extensions/enforce-extension-access")).canExtensionAccess;
      audience = await canAccessInstallRow(
        {
          kind: resourceKind,
          resourceId: row.id,
          owner: {
            ownerLevel: row.ownerLevel,
            ownerId: row.ownerId,
            organizationId: row.organizationId,
          },
        },
        actor,
        "use",
      );
    } catch {
      // Policy-store outage: we cannot PROVE admission, and an unprovable
      // audience is not an admission. Fail safe to absent — the same direction
      // the canonical-store outage above takes, and the same direction
      // `trust: null` takes at the serve gate.
      audience = { allowed: false, reason: "not_visible" };
    }
    if (!audience.allowed) return absent;
  }

  const isLive = row.status === "active" || row.status === "locked";
  const status: ReadModelStatus = row.status; // active | locked | archived (addressable)

  // Source package-store record presence + the trust verdict are best-effort
  // descriptive fields — a failure degrades the field, never the whole record.
  let sourcePackageStoreRecordPresent = false;
  let trust: TrustVerdict | null = null;
  let signatureVerified: boolean | null = null;
  try {
    const storeRoot =
      deps.storeRoot ?? (await import("@/lib/extension-data-root")).resolveExtensionDataRoot();
    const discover =
      deps.discoverRecords ??
      (async (root: string) => (await import("@/lib/extension-store-io")).discoverStoreRecordsV2(root, realStoreFs));
    const records = await discover(storeRoot);
    const candidates = records.filter((r) => r.packageName === packageName);
    sourcePackageStoreRecordPresent = candidates.length > 0;

    // cinatra#2848 — resolve the anchor for the PICKED ROW, not for the actor.
    // The row above is the package's EFFECTIVE row (supersession applied), which
    // for a superseded pair sits at a DIFFERENT scope than the actor: resolving
    // at `actor.organizationId` would answer for the superseded organization row
    // while every other field of this record describes the workspace row.
    // `org-then-workspace` is the supersession-aligned arm already on main (the
    // owner ruling of 2026-08-16, the same arm `resolveRuntimeConnectorUiRecord`
    // uses): with a live workspace row it resolves THAT anchor (reading its
    // grant/journal at its own org-NULL scope), and with none it resolves the
    // row's own org exactly as before. Supersession is NOT re-derived here — the
    // scope is simply pointed at the row the effective-row rule already chose.
    const anchorTarget: ReadModelAnchorTarget = {
      installId: row.id ?? null,
      organizationId: row.organizationId ?? null,
    };
    const resolveTrustAnchor =
      deps.resolveTrustAnchor ??
      (await (async () => {
        const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
        return makeDefaultInstallAnchorResolver(anchorTarget.organizationId, "org-then-workspace");
      })());
    const resolved = await resolveTrustAnchor(packageName, anchorTarget);

    // IDENTITY BACKSTOP. The trust verdict may describe THE PICKED ROW or
    // nothing — never another row. A resolver's row selection is its own
    // (and a legacy/injected one need not be supersession-aware at all), so the
    // agreement is PROVEN here from the anchor's canonical row id rather than
    // assumed from the scope we asked at.
    //
    // An anchor that carries NO `installId` is refused too: an identity-less
    // anchor cannot prove it describes the picked INSTALL row, and this model's
    // rows always carry a canonical id, so "unknown identity" is treated as
    // disagreement (fail-safe). Only legacy row views / pure unit fixtures
    // produce one — the default resolver always stamps the row's id.
    const anchor =
      resolved && anchorTarget.installId !== null && (resolved.installId ?? null) === anchorTarget.installId
        ? resolved
        : null;

    // cinatra#792: with multi-digest retention (#796) several digests of one
    // package may legitimately be on disk — evaluate the trust verdict against
    // the ANCHOR-BOUND record (the digest the DB pins), never an arbitrary
    // first match; this verdict feeds runtime gates (cube serving), not just
    // display. Same rules as the boot loader: the canonical row's kind (riding
    // the anchor) must agree with a record's PATH-derived kind (unbound when
    // either side carries no kind — legacy resolvers / injected test deps); a
    // digest-BOUND anchor selects exactly its record; a digest-UNBOUND anchor
    // proceeds only when the on-disk record is unambiguous (>1 = no verdict,
    // fail closed).
    const kindBound =
      anchor?.kind != null
        ? candidates.filter((r) => {
            const recKind = (r as { kind?: string }).kind;
            return recKind === undefined || recKind === anchor.kind;
          })
        : candidates;
    const record = anchor?.digest
      ? (kindBound.find((r) => r.declaredDigest === anchor.digest) ?? null)
      : kindBound.length === 1
        ? kindBound[0]
        : null;

    if (record && anchor) {
      const verifyIntegrity = deps.verifyIntegrity ?? defaultVerifyIntegrity;
      const classifyTrust = deps.classifyTrust ?? classifyExtensionTrust;
      const integrityVerified = await verifyIntegrity(record, anchor);
      const sigVerdict = resolveSignatureVerdict({
        packageName,
        version: anchor.version ?? "",
        integrity: anchor.integrity,
        signature: anchor.signature,
        closureHash: anchor.closureHash ?? null,
      });
      // `resolveSignatureVerdict` returns `undefined` when no signature is present
      // / no signing is configured — normalize that to `null` (unknown) so the
      // read-model field stays `boolean | null`.
      signatureVerified = sigVerdict ?? null;
      trust = classifyTrust({
        packageName,
        registryUrl: anchor.registryUrl,
        integrityVerified,
        persistedTrustDecision: anchor.trustDecision,
        signatureVerified: sigVerdict,
        trustedActivationHosts: trustedActivationHosts(),
        allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
      });
    }
  } catch {
    // Best-effort: leave trust/signature/store-presence at their safe defaults.
  }

  return {
    packageName,
    actorVisible: true,
    status,
    kind: row.kind,
    ownerScope: {
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
    },
    trust,
    signatureVerified,
    sourcePackageStoreRecordPresent,
    activationGeneration,
    teardownState: isLive ? "live" : "torn-down",
  };
}
