import "server-only";

// Dependency-BATCH install saga (#180 PR-2, items 1/2/3/7).
//
// The single entry the install surfaces call for a FRESH extension install:
//
//   1. AUTHORIZE ONCE (gatekept): resolve the root grant + exact-pinned
//      closure via `resolveGatekeptInstallConfig`, then run EVERYTHING below
//      inside the install-grant context — every member read derives from the
//      ROOT grant; per-member authorize is structurally impossible
//      (test-asserted). Dev/non-gatekept: same flow, no grant.
//   2. PLAN under the GLOBAL extension lifecycle lock: the manifest-edge walk
//      filtered by `isAutoInstallableEdge` (peer/optional NEVER auto-install),
//      closure-membership + range cross-checks, installed-version conflicts,
//      topo order dependencies-first/root-last (extension-dependency-plan.ts).
//      Per-member PRE-STATE (present-before-batch?) is captured here, under
//      the same lock — the compensation discriminator.
//   3. INSTALL members in topo order through the REAL dispatcher
//      (`extensionRegistry.install`) — every member gets the full pipeline
//      (materialize → gates → journal → finalize → edges, #161/#180-PR-1
//      included). The root installs LAST. Ledger states advance per member.
//      Each member is installed AT ITS PLANNED ROW ANCHOR (cinatra#2696): the
//      per-member `rowOwnership` the ledger already recorded is now the LIVE
//      anchor — forwarded to the dispatcher, and the scope every pre-state
//      read, provenance capture, journal read and compensation addresses.
//      Absent a threaded install-access target the anchor is the batch's own
//      org, so every pre-#2696 batch behaves identically.
//   4. MEMBER FAILURE (anywhere — incl. the built-artifacts serverEntry gate
//      or a migration preflight inside the member's own pipeline): abort the
//      queue, COMPENSATE the rows THIS batch provably created (pre-existing
//      rows — same org and every other org — untouched) in INVERSE install
//      order, ledger → compensated, original error rethrown. Targets come from
//      the ledger's durable per-member provenance and the teardown is always
//      the ROW-SCOPED inverse — see THE COMPENSATION INVARIANT below
//      (cinatra#2415).
//   5. GRANT TTL (P2-5): before each member the root grant's expiry is
//      checked; near-expiry triggers the injectable REFRESH seam (closure
//      must be unchanged). Refresh unavailable/failed → abort + compensate —
//      a batch NEVER proceeds (or resumes) under an expired grant.
//
// BOOT RECOVERY: `sweepStaleInstallBatches` compensates stale ACTIVE batches
// from the LEDGER (the per-op orphan cleanup cannot see them — a crashed
// batch's already-installed members have FINALIZED ops). It runs BEFORE the
// per-op cleanup at boot; the per-op cleanup SKIPS ops owned by still-active
// batches (`collectActiveBatchMemberKeys`). There is no grant at boot, so
// recovery is always compensate-never-resume.
//
// PRECONDITION: callers run where the extension handlers are bootstrapped
// (the actions / MCP dispatch surfaces import handler-bootstrap before
// dispatching here) — the default installer resolves `extensionRegistry`.

import { randomUUID } from "node:crypto";
import type { Actor } from "@cinatra-ai/extension-types";
import type {
  GatekeptInstallResolution,
  GatekeptGrantRefresh,
} from "@/lib/gatekept-install";
import type {
  DependencyInstallPlan,
  DependencyPlanDeps,
  RowOwnership,
} from "@/lib/extension-dependency-plan";
import type {
  InstallBatch,
  InstallBatchMember,
  InstallBatchOpsDeps,
  SideBySideGrantCapsule,
} from "@/lib/extension-install-batch-ops";

export type BatchInstallResult = {
  rootPackage: string;
  rootVersion: string;
  /** Members THIS call installed FRESH (dependencies first; the root is last). */
  installed: { packageName: string; version: string }[];
  /**
   * Shared dependencies THIS call UPGRADED in place (#1039 Option B dedupe-
   * upward `action:"update"` members) — a committed, provably-non-breaking
   * upgrade that stays even if a later member fails. Empty on the gatekept path
   * (which keeps the hard refusal).
   */
  updated: { packageName: string; version: string }[];
  /**
   * Shared dependencies THIS call installed SIDE BY SIDE as non-default
   * version rows (cinatra#1040 S3 `action:"install-side-by-side"` members —
   * the disjoint-dependents class on the non-gatekept path). STORAGE-LEVEL
   * installs: resolved edges bind the new dependents, but versioned RUNTIME
   * activation is deferred to the S4 loader slice — until then the DEFAULT
   * version keeps serving every runtime surface. `evidence` names the live
   * dependents whose constraints forced the split. Rolled back (version-
   * scoped teardown) if a later member fails. Always empty on the gatekept
   * path (hard refusal preserved).
   */
  installedSideBySide: { packageName: string; version: string; evidence?: string }[];
  /** Closure members that were already present at the pin and were skipped. */
  alreadyInstalled: string[];
  batchId: string | null; // null = root-only fast path (no ledger row)
};

export class BatchMemberInstallError extends Error {
  constructor(
    message: string,
    public readonly member: string,
    public readonly compensated: string[],
    public readonly compensationFailures: string[],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BatchMemberInstallError";
  }
}

/** Refresh when the grant expires within this margin (P2-5 short-TTL grants). */
const GRANT_REFRESH_MARGIN_MS = 60_000;

export type InstallBatchSagaDeps = {
  /** Gatekept master switch (per call, like the resolver seam). */
  isGatekeptInstallEnabled: () => boolean;
  /** AUTHORIZE the root — called EXACTLY ONCE per batch (test-asserted). */
  authorizeRoot: (
    packageName: string,
    version?: string,
  ) => Promise<GatekeptInstallResolution>;
  /** The P2-5 grant-refresh seam. The default is the LIVE wired
   *  `refreshGatekeptInstallGrant` (it calls the marketplace
   *  `extension_install_grant_refresh` ability with the current opaque grant and
   *  enforces the closure-hash binding); tests inject a stub or wrap the real
   *  function with a mock client. */
  refreshGrant: GatekeptGrantRefresh;
  /** Run `fn` inside the install-grant context (root grant + member kinds). */
  withGrantContext: <T>(
    ctx: {
      rootPackageName: string;
      resolution: GatekeptInstallResolution;
      memberKinds: Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">;
    },
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** The ACTIVE grant context, if a caller (e.g. the MCP install surface)
   *  already authorized this root and entered the context — the batch ADOPTS
   *  it instead of authorizing a second time (authorize-once spans the WHOLE
   *  install surface, not just the batch body). */
  getActiveGrantContext: () => {
    rootPackageName: string;
    resolution: GatekeptInstallResolution;
    memberKinds: Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">;
  } | null;
  /** Global lifecycle lock for the PLANNING + ledger-begin phase. */
  withGlobalLifecycleLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The planner (defaults wire the real seams). */
  plan: (input: {
    root: { packageName: string; version: string };
    orgId: string | null;
    /** cinatra#1039 decision 1+4: the root's derived-default rowOwnership tuple,
     *  forced onto every member. */
    rowOwnership?: RowOwnership;
    closure: GatekeptInstallResolution["authorize"]["closure"] | null;
    /** #1039 Option B (update-time): the root is a committed in-place update
     *  (dev/non-gatekept path) rather than a fresh install. */
    rootAction?: "install" | "update";
  }) => Promise<DependencyInstallPlan>;
  /**
   * Run `fn` with the SAGA-OWNED-FAN-OUT context active (#157). The agent
   * extension handler, dispatched per-member by `installMember` inside this
   * scope, installs ONLY the root package it is handed (it does NOT re-run the
   * @cinatra-ai/registries dep-resolver) — the saga owns the dependency
   * fan-out. Defaults to the real `withSagaOwnedFanout` from @cinatra-ai/agents.
   */
  withSagaOwnedFanout: <T>(rootPackageName: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Install ONE package through the real dispatcher.
   *
   * `member.rowOwnership` (cinatra#2696) is the PLANNED canonical row anchor for
   * this member — the tuple the target→ownership contract resolved, threaded
   * from the install action through the planner to here. The default impl
   * forwards it to `extensionRegistry.install`, which writes the row AT that
   * anchor instead of re-deriving one from the actor's organization. Absent (a
   * legacy/injected plan) → the dispatcher's actor-derived default, unchanged.
   */
  installMember: (
    member: {
      typeId: string;
      packageName: string;
      version: string;
      rowOwnership?: RowOwnership;
    },
    actor: Actor,
  ) => Promise<void>;
  /**
   * Upgrade ONE already-installed shared dependency in place through the real
   * dispatcher's durable UPDATE pipeline (#1039 Option B `action:"update"`
   * member). Distinct from `installMember` because the member is already
   * present at an OLDER version — the update pipeline atomically re-materializes
   * it at the new pin (its own durable rollback covers the single update). This
   * is a COMMITTED upgrade: the compensation inverse never touches it (it is a
   * pre-existing member — `preState.present` — so the newly-installed-only
   * compensation loop and the boot sweeper both skip it), so no cross-batch
   * durable-restore is required (that is the deferred Option A subsystem).
   */
  updateMemberPackage: (
    member: { typeId: string; packageName: string; version: string },
    actor: Actor,
    /**
     * #1042 slice-1 CAS: forwarded to `extensionRegistry.update` as
     * `expectedInstalledVersion` for the ROOT update member ONLY (the batch
     * passes it only when `member.packageName === input.packageName`). A drift
     * at the mutation boundary refuses the update before any mutation — the
     * caller's stale target never overwrites a concurrent winner. Omitted for
     * every non-root dedupe-upward member and every manual caller.
     */
    expectedInstalledVersion?: string,
  ) => Promise<void>;
  /**
   * DECLARATION-DRIVEN PROTECTION (cinatra#1927) — does this member's own
   * `cinatra/config.json` declare `protected: true`? Consulted BEFORE every
   * compensation teardown so the saga never removes a protected extension:
   *
   *  - `uninstallMember` routes through `extensionRegistry.uninstall`, whose
   *    `assertNoLockedCanonicalRow` backstop now REFUSES a protected package —
   *    without this check the member would deterministically land in
   *    `compensationFailures` instead of being honestly recorded as protected;
   *  - `uninstallMemberRowScoped` reaches `deleteScopedCanonicalRow` directly and
   *    BYPASSES the dispatcher entirely — this check is the only thing standing
   *    between a row-scoped compensation and a protected extension's row.
   *
   * A protected member is SKIPPED (ledger detail `protected-declaration`), not
   * failed: "this extension is never removed" is the declared contract, and a
   * failed batch that had just installed it converges by leaving it installed.
   * Default: the shared `resolveDeclaredProtection` resolver — the SAME verdict
   * both removal gates refuse on. Fail-closed: a reader throw (a present but
   * unreadable declaration) is treated as PROTECTED (skip), never as removable.
   */
  isMemberProtected: (packageName: string) => Promise<boolean>;
  /**
   * ROW-SCOPED compensation inverse — the ONLY inverse the abort path uses for
   * a non-side-by-side member (cinatra#2415; introduced as the opt-in #1042
   * slice-2 path). Removes ONLY the canonical rows this batch PROVABLY created
   * at the member's own scope — never the package-global hard-delete branch of
   * `extensionRegistry.uninstall` (which would tear down same-package OTHER-org
   * rows, the boundary PR #2410 pinned).
   *
   * TARGETING IS LEDGER-DERIVED, NOT ACTOR-DERIVED (cinatra#2415): `scopeOrgId`
   * is the batch's own planned scope read from the ledger and `createdRowIds`
   * is the member's durable creation provenance. `actor` contributes the AUDIT
   * envelope only. Fail-closed when `createdRowIds` is absent.
   */
  uninstallMemberRowScoped: (
    member: {
      typeId: string;
      packageName: string;
      version: string;
      /** The batch/member scope the row was created at (ledger, never the actor). */
      scopeOrgId: string | null;
      /** cinatra#2415: the rows this member provably created (`[]` = none). */
      createdRowIds?: string[] | null;
    },
    actor: Actor,
  ) => Promise<void>;
  /**
   * cinatra#2415: the canonical row ids for `(packageName, scope)` across EVERY
   * status — the pre/post reads whose set difference is the batch's durable
   * creation provenance. Read at the exact scope (no org→platform fallback:
   * `readLiveRowVersion`'s fallback is what let an org batch mistake a platform
   * row for its own pre-state and skip compensating the org row it created).
   */
  listScopedRowIds: (packageName: string, scope: string | null) => Promise<string[]>;
  /**
   * cinatra#2415: run `fn` holding the PER-PACKAGE install lock (the same
   * re-entrant `withInstallLock` the dispatcher's own install/uninstall take, so
   * this adds no new serialization — it EXTENDS the already-held section). The
   * provenance capture must be atomic with the mutation it describes: reading
   * `before` outside the lock would let an unrelated concurrent insert be
   * mis-attributed to this batch.
   */
  withPackageInstallLock: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Install ONE shared dependency SIDE BY SIDE as a non-default version row
   * (cinatra#1040 S3 `action:"install-side-by-side"` member) — the storage-
   * level installer (real pipeline, row-bound, version-scoped journal, NO
   * runtime activation until S4). Distinct from `installMember`: the package's
   * DEFAULT row stays installed and untouched.
   */
  installMemberSideBySide: (
    member: {
      typeId: string;
      packageName: string;
      version: string;
      scopeOrgId: string | null;
      /** cinatra#1040 S6: persist the member's ownership DECLARATION CAPSULE
       * durably (batch ledger member `grantCapsule`) BEFORE the side-by-side
       * install mutates the shared ownership grant. Its presence ENABLES the
       * ownership union; absent → the S3 DECLARES_OWNERSHIP_KEYS refusal. */
      persistCapsule?: (capsule: SideBySideGrantCapsule) => Promise<void>;
    },
    actor: Actor,
  ) => Promise<void>;
  /**
   * The VERSION-SCOPED compensation inverse for a side-by-side member: tears
   * down ONLY the non-default (package, org, version) row + its version-scoped
   * journal op. NEVER the package-scoped uninstall (which would remove the
   * default install).
   */
  uninstallSideBySideMember: (
    member: {
      typeId: string;
      packageName: string;
      version: string;
      scopeOrgId: string | null;
      /** cinatra#1040 S6: the torn-down member's durable declaration capsule
       * (from the ledger member) — reconciles the shared ownership grant
       * (survivor-check + revoke). Null/absent → no ownership reconcile. */
      capsule?: SideBySideGrantCapsule | null;
    },
    actor: Actor,
  ) => Promise<void>;
  /**
   * Version-scoped journal read (cinatra#1040 S3) — the ledger linkage for a
   * side-by-side member's op (the versionless `readInstallOp` would observe
   * the DEFAULT install's anchor).
   */
  readInstallOpForVersion: (
    packageName: string,
    orgId: string | null,
    version: string,
  ) => Promise<{ installOpId: string; phase: string } | null>;
  /**
   * Fire the SINGLE WayFlow agent-runtime reload at the batch SUCCESS boundary
   * (#157). The agent handler no longer reloads per-member (it installs
   * root-only under the saga), and `installAgentFromPackage` never reloads on
   * its own, so the saga is now the canonical single-shot reload trigger when
   * an agent member was installed. Best-effort: a reload failure is logged, not
   * fatal (the durable DB + disk writes already succeeded). Defaults to the
   * real `triggerWayflowReload` from @cinatra-ai/agents.
   */
  triggerAgentRuntimeReload: () => Promise<{ ok: boolean; reason?: string; detail?: string }>;
  /** Pre-state reads (canonical row + install-op journal). */
  readLiveRowVersion: (packageName: string, orgId: string | null) => Promise<{ present: boolean; version?: string }>;
  readInstallOp: (packageName: string, orgId: string | null) => Promise<{ installOpId: string; phase: string } | null>;
  /** Ledger ops (default: the real batch store). */
  ledger: {
    begin: (input: { batchId: string; rootPackage: string; orgId: string | null; members: InstallBatchMember[] }) => Promise<InstallBatch>;
    setPhase: (batchId: string, phase: InstallBatch["phase"]) => Promise<InstallBatch>;
    updateMember: (
      batchId: string,
      packageName: string,
      patch: Partial<
        Pick<
          InstallBatchMember,
          "status" | "installOpId" | "detail" | "grantCapsule" | "preRowIds" | "createdRowIds"
        >
      >,
    ) => Promise<InstallBatch>;
    listActive: () => Promise<InstallBatch[]>;
  };
  now: () => number;
};

// ---------------------------------------------------------------------------
// cinatra#2415 — THE COMPENSATION INVARIANT
//
//   Compensation deletes ONLY canonical `installed_extension` rows THIS batch
//   created — identified by DURABLE PER-MEMBER PROVENANCE on the ledger, not by
//   a (package, scope, version) guess — and it deletes ALL of them, EXCEPT the
//   two pre-existing, deliberate contracts that refuse a teardown:
//     * a DECLARATION-PROTECTED extension (cinatra#1927) is skipped and
//       recorded as such ("this extension is never uninstalled" is its declared
//       contract);
//     * a LOCKED row (`deleteScopedCanonicalRow` refuses it) is recorded
//       compensation-failed / ROLLBACK INCOMPLETE.
//   Rows that PRE-EXISTED the batch — in the same org and in every other org —
//   are never addressed at all: they are not in the provenance set, so no code
//   path can reach them.
//
// WHY AN ACTOR ALONE CANNOT DO THIS. The abort path used to hand the install's
// STANDING-FREE audit envelope to `extensionRegistry.uninstall`, whose
// `resolveLifecycleTargetRow → assertActorWriteStandingOverRow` refuses a
// role-less actor outright — so every manual/UI compensation was refused and
// the batch's rows were left behind (the #2415 defect). Neither dispatcher
// branch can satisfy the invariant either:
//   * a role-bearing NON-platform actor takes the ARCHIVE branch — the row
//     SURVIVES (archived), so "zero rows created by this batch" fails;
//   * a PLATFORM-standing actor takes the PACKAGE-GLOBAL hard-delete branch,
//     which tears down every OTHER org's row for the package — the boundary
//     PR #2410 pinned with a test.
// So compensation ALWAYS takes the ROW-SCOPED inverse
// (`uninstallMemberRowScoped` → `deleteScopedCanonicalRow`), which deletes one
// canonical row BY ID and can never fan out. The #2410 boundary is now
// STRUCTURAL rather than conventional: the compensation actor is built by
// `buildBatchCompensationActor`, which STRIPS platform standing instead of
// attaching it (closing it even for the fully-roled MCP install actor).
// ---------------------------------------------------------------------------

/**
 * Build the actor a batch's COMPENSATION runs under (cinatra#2415).
 *
 * DERIVED FOR THE PURPOSE, in the `buildInstallRollbackActor` spirit (org-only,
 * never platform) but taken further: NO standing at all is attached.
 *
 *  - `platformRole` is STRIPPED. Attaching it is the #2410 cross-org breach;
 *    stripping it also closes the live hazard on the MCP install path, whose
 *    transport actor may legitimately carry platform standing that would have
 *    been threaded into the abort path.
 *  - `orgRole` is STRIPPED, and deliberately NOT synthesized. `Actor.orgRole` is
 *    a TRUSTED, verified membership hint; "this batch was authorized to install"
 *    is not proof of a membership role, and the row-scoped inverse consults no
 *    roles — a synthetic `org_admin` would be decorative authority and
 *    confused-deputy bait for any future consumer of this actor.
 *  - `orgId` is stripped and re-pinned to the BATCH's own planned scope, so a
 *    caller's stale/different active org can never widen what is addressed.
 *  - the audit identity (`actorType` / `userId` / `source`, plus restrictions
 *    such as `oboCeiling`) is PRESERVED, so the trail still names who triggered
 *    the failed install.
 *
 * Authorization is intentionally replaced by ledger-derived, row-scoped
 * targeting: the rows to delete come from the batch's own durable provenance
 * (`preRowIds` / `createdRowIds`), never from this actor. Pure + exported for
 * direct testing.
 */
export function buildBatchCompensationActor(
  installActor: Actor,
  batchScopeOrgId: string | null,
): Actor {
  const identity: Actor = { ...installActor };
  delete identity.platformRole;
  delete identity.orgRole;
  delete identity.orgId;
  return batchScopeOrgId != null ? { ...identity, orgId: batchScopeOrgId } : identity;
}

/**
 * cinatra#2415: the rows a member's install CREATED = the ids present after it
 * and absent before it. Order-preserving on `after`, de-duplicated. Pure +
 * exported (the saga computes it at capture time; the inverse recomputes it
 * from `createdRowIds`).
 */
export function diffCreatedRowIds(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const had = new Set(before);
  const out: string[] = [];
  for (const id of after) {
    if (!had.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** What compensation must do with ONE member — pure, from the ledger entry alone. */
export type MemberCompensationDecision =
  | { kind: "skip"; reason: "committed-update" | "nothing-created" | "pre-existing" }
  | { kind: "side-by-side" }
  | { kind: "row-scoped" }
  | { kind: "refuse"; reason: "no-durable-provenance" };

/**
 * cinatra#2415: decide a member's compensation from its DURABLE ledger entry.
 * Pure + exported so the rule is unit-testable independently of the saga.
 *
 * Precedence (provenance OUTRANKS the legacy pre-state heuristic):
 *   1. an `action:"update"` member is a COMMITTED dedupe-upward (#1039 Option B)
 *      — never rolled back;
 *   2. an `install-side-by-side` member takes its VERSION-scoped inverse
 *      (cinatra#1040 S3), which can never touch the default install;
 *   3. `createdRowIds: []` — PROVEN to have created nothing at its scope → skip,
 *      on EITHER inverse (a side-by-side member that created no version row must
 *      not fire the version-scoped teardown against a row it did not create);
 *   4. an `install-side-by-side` member with any other provenance state takes
 *      its VERSION-scoped inverse (cinatra#1040 S3), which can never touch the
 *      default install;
 *   5. `createdRowIds: [...]` → the ROW-SCOPED inverse, deleting exactly those;
 *   6. no `createdRowIds` AND `preState.present` → the legacy pre-#2415
 *      discriminator: treat as pre-existing and skip (never remove a
 *      pre-existing install);
 *   7. no `createdRowIds` and NOT pre-existing → REFUSE. A row we cannot prove
 *      this batch created is never deleted — not on a `(scope, version)` guess
 *      and not on a crash-time `current \ preRowIds` difference (the install
 *      lock is gone by then, so an unrelated concurrent install would be
 *      misattributed). The member is recorded compensation-failed (ROLLBACK
 *      INCOMPLETE) for manual review; `preRowIds` remains on the ledger as the
 *      operator's reconciliation evidence.
 */
export function decideMemberCompensation(
  action: "install" | "update" | "install-side-by-side" | undefined,
  ledgerMember:
    | Pick<InstallBatchMember, "preState" | "preRowIds" | "createdRowIds">
    | undefined,
): MemberCompensationDecision {
  if (action === "update") return { kind: "skip", reason: "committed-update" };
  const created = ledgerMember?.createdRowIds ?? null;
  // A member whose provenance PROVES it created nothing is skipped on EITHER
  // inverse — including side-by-side, whose version-scoped teardown would
  // otherwise fire against a row the batch did not create.
  if (created !== null && created.length === 0) {
    return { kind: "skip", reason: "nothing-created" };
  }
  if (action === "install-side-by-side") return { kind: "side-by-side" };
  if (created !== null) return { kind: "row-scoped" };
  if (ledgerMember?.preState.present) return { kind: "skip", reason: "pre-existing" };
  return { kind: "refuse", reason: "no-durable-provenance" };
}

/**
 * #1042 slice-2: resolve the SINGLE freshly-installed (package, scope, version)
 * canonical row the row-scoped compensation must tear down — precisely, never an
 * arbitrary live row. The freshly-installed row is the one at the actor scope
 * carrying the exact version this batch installed. FAIL-CLOSED: more than one
 * live row carrying that version at the scope is ambiguous → `ambiguous:true`
 * (the caller refuses rather than delete the wrong row); zero → `rowId:null`
 * (idempotent — already gone / the install never took). Pure + exported for
 * direct testing. `source.version` is the canonical verdaccio version.
 *
 * cinatra#2415 NOTE: this is NO LONGER the compensation's target resolver — a
 * (scope, version) match does not PROVE the row was created by the batch (an
 * archived pre-existing row that a concurrent restore re-activates matches it).
 * The durable `preRowIds` / `createdRowIds` provenance replaced it. Kept as the
 * pure, tested predicate it always was, and still used as the SECONDARY guard
 * inside the inverse's revalidation.
 */
export function resolveRowScopedCompensationTarget(
  rows: {
    id: string;
    organizationId: string | null;
    status: string;
    source?: { version?: string } | null;
  }[],
  scope: string | null,
  version: string,
): { rowId: string | null; ambiguous: boolean; count: number } {
  const matching = rows.filter(
    (r) =>
      (r.organizationId ?? null) === scope &&
      (r.status === "active" || r.status === "locked") &&
      ((r.source?.version ?? null) === version),
  );
  if (matching.length === 1) return { rowId: matching[0]!.id, ambiguous: false, count: 1 };
  return { rowId: null, ambiguous: matching.length > 1, count: matching.length };
}

/** The member shape the row-scoped compensation inverse addresses (cinatra#2415). */
export type RowScopedCompensationMember = {
  typeId: string;
  packageName: string;
  version: string;
  /** The scope the row was created at — from the LEDGER, never the actor. */
  scopeOrgId: string | null;
  createdRowIds?: string[] | null;
};

/**
 * THE compensation inverse (cinatra#2415) — shared by the live saga's abort path
 * and by boot recovery so both enforce the SAME invariant with the SAME code.
 *
 * Deletes EXACTLY the canonical rows the ledger PROVES this batch created at the
 * member's own scope. Never the package-global hard-delete branch of
 * `extensionRegistry.uninstall` (the #2410 cross-org boundary), never an
 * arbitrary live row, and never a row whose creation this batch cannot prove.
 * Other-scope rows for the same package are unreachable by construction — they
 * are not in the provenance set and are never read for targeting.
 *
 * The whole resolve → revalidate → delete → journal sequence runs inside the
 * per-package install lock (the SAME re-entrant `withInstallLock` the
 * dispatcher's own uninstall takes), so no concurrent install can bind a
 * dependent or recreate a row between the revalidation and the delete.
 *
 * `actor` is the AUDIT envelope only — targeting is ledger-derived.
 */
async function defaultUninstallMemberRowScoped(
  member: RowScopedCompensationMember,
  actor: Actor,
): Promise<void> {
  void actor; // audit envelope only — see the doc above
  const scope = member.scopeOrgId ?? null;
  const { withInstallLock } = await import("@cinatra-ai/agents");
  await withInstallLock(member.packageName, async () => {
    const { readInstalledExtensionById } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    if (member.createdRowIds == null) {
      // FAIL CLOSED. `createdRowIds` is the ONLY delete authorization. The
      // pre-mutation `preRowIds` snapshot is EVIDENCE, not a licence: once a
      // crash releases the install lock, an unrelated operation can create a
      // row at the same scope before boot recovery runs, so a recomputed
      // `current \ preRowIds` difference would misattribute that row to this
      // batch. Refusing leaves the row and records ROLLBACK INCOMPLETE — the
      // safe direction (an operator has `preRowIds` on the ledger to reconcile
      // from). Reachable for a pre-cinatra#2415 ledger row, for a crash inside
      // the capture window, and when the capture read itself failed.
      throw new Error(
        `[extension-install-batch] row-scoped compensation of ${member.packageName}@${member.version} ` +
          `has NO durable creation provenance (no createdRowIds on the ledger) — refusing to delete ` +
          `a row this batch cannot prove it created (compensation left incomplete for manual review).`,
      );
    }
    const targets: string[] = member.createdRowIds;
    if (targets.length === 0) return; // provably created nothing — idempotent no-op
    if (targets.length > 1) {
      console.warn(
        "[extension-install-batch] member %s created %d canonical rows at scope %s — " +
          "compensating ALL of them (each is provably batch-created)",
        member.packageName,
        targets.length,
        scope ?? "(platform)",
      );
    }
    const { deleteScopedCanonicalRow } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    let deleted = 0;
    for (const rowId of targets) {
      const row = await readInstalledExtensionById(rowId);
      if (!row) continue; // already gone — idempotent
      // REVALIDATE the durable provenance against the live row before the
      // destructive act: a recorded id must still BE this package at this scope.
      // A mismatch means the ledger and the store disagree — refuse.
      if (row.packageName !== member.packageName || (row.organizationId ?? null) !== scope) {
        throw new Error(
          `[extension-install-batch] row-scoped compensation of ${member.packageName}@${member.version} ` +
            `refused — recorded row ${rowId} is now package "${row.packageName}" at scope ` +
            `${row.organizationId ?? "(platform)"} (expected ${member.packageName} at ` +
            `${scope ?? "(platform)"}); the ledger provenance and the canonical store disagree.`,
        );
      }
      await deleteScopedCanonicalRow(rowId);
      deleted += 1;
    }
    if (deleted === 0) return;
    // Best-effort terminalize the member's install-op journal so it can never be
    // mistaken for a live anchor.
    try {
      const { readInstallOp, advanceInstallOpPhase } = await import(
        "@/lib/extension-install-ops"
      );
      const op = await readInstallOp(member.packageName, scope);
      if (op && op.phase !== "rolled_back") {
        await advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
      }
    } catch (err) {
      console.warn(
        "[extension-install-batch] terminalizing the install-op journal for %s (row-scoped compensation) failed:",
        member.packageName,
        err instanceof Error ? err.message : err,
      );
    }
  });
}

export async function makeDefaultInstallBatchSagaDeps(): Promise<InstallBatchSagaDeps> {
  const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig, refreshGatekeptInstallGrant } =
    await import("@/lib/gatekept-install");
  const { withInstallGrantContext, getActiveInstallGrantContext } = await import(
    "@/lib/extension-install-grant-context"
  );
  const { planDependencyInstall, defaultOrgPlatformChain } = await import(
    "@/lib/extension-dependency-plan"
  );
  const { readInstallOp } = await import("@/lib/extension-install-ops");
  const batchOps = await import("@/lib/extension-install-batch-ops");
  const { parseManifestDependencyEdges } = await import(
    "@cinatra-ai/extensions/manifest-dependencies"
  );
  const { isAutoInstallableEdge } = await import("@cinatra-ai/extensions/dependency-closure");

  const planDeps: DependencyPlanDeps = {
    fetchSummary: async (packageName, versionOrRange) => {
      const {
        getPublishedExtensionSummary,
        resolveExtensionDistIntegrity,
        resolveMaxSatisfyingVersion,
        isExactVersion,
        isValidVersionRange,
      } = await import("@cinatra-ai/registries");
      // Config: gatekept ON → the grant-context-aware resolver (derives the
      // broker config under the root grant inside a batch); OFF → the
      // server read config (legacy direct read).
      let config;
      if (isGatekeptInstallEnabled()) {
        const { config: c } = await resolveGatekeptInstallConfig(packageName, versionOrRange);
        config = c;
      } else {
        const { loadVerdaccioConfigForReads } = await import("@/lib/verdaccio-config");
        config = await loadVerdaccioConfigForReads();
      }
      const isExact = isExactVersion(versionOrRange);
      let exact = isExact ? versionOrRange : undefined;
      if (!isExact && versionOrRange !== "latest" && versionOrRange !== "") {
        if (isValidVersionRange(versionOrRange)) {
          // A RANGE (dev path): pacote resolves exact versions and dist-tags
          // but NOT ranges against Verdaccio — resolve via the packument's
          // version list (highest satisfying; live-verify finding).
          const resolved = await resolveMaxSatisfyingVersion(
            { packageName, range: versionOrRange },
            config,
          );
          if (!resolved) {
            throw new Error(
              `[extension-install-batch] no published version of ${packageName} satisfies "${versionOrRange}"`,
            );
          }
          exact = resolved;
        } else {
          // A DIST-TAG (e.g. "beta"/"next") — keep the original pacote
          // resolution semantics (merge-gate finding: tags are not ranges).
          const resolved = await resolveExtensionDistIntegrity(
            { packageName, packageVersion: versionOrRange },
            config,
          );
          exact = resolved.resolvedVersion ?? undefined;
        }
      }
      const summary = await getPublishedExtensionSummary(
        { packageName, ...(exact ? { packageVersion: exact } : {}) },
        config,
      );
      if (!summary.resolvedVersion) {
        throw new Error(`[extension-install-batch] no resolvable version for ${packageName}@${versionOrRange}`);
      }
      return {
        resolvedVersion: summary.resolvedVersion,
        kind: summary.kind,
        manifest: summary.manifest,
      };
    },
    // The PR-1 dual-read helper (fail-loud on conflict/malformed) + the
    // shared auto-install predicate — the SAME seams the install gates use.
    parseEdges: (manifest, packageName) =>
      parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge: (dep) => isAutoInstallableEdge(dep),
    readInstalledRows: async () => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      return listInstalledExtensions({});
    },
    // cinatra#1039 decision 2: the extension-saga scope-ancestry is the
    // [organization, platform] binary — an org install resolves the org's own
    // rows first, else platform (the EXACT pre-#1039 findLiveRowsInScope
    // behavior). The agent path (Phase 2) injects the real
    // project→owning-team→org→platform ladder here.
    resolveScopeAncestry: (rowOwnership) => defaultOrgPlatformChain(rowOwnership.organizationId),
    // cinatra#1039 decision 3: the extension-saga rows are ORG-owned and the
    // root install already authorized the org, so a dedupe-upward of a
    // same-org (or platform-fallback) row stays within the caller's established
    // authority — PERMIT (behavior-neutral). The AGENT path (Phase 2) wires the
    // real per-row assertCanInstallAtTarget against the EXISTING row's scope, so
    // a cross-scope mutation refuses.
    authorizeExistingRowMutation: () => {
      /* permit: extension-path row ownership is org-uniform (see #1039 decision 3) */
    },
  };

  return {
    isGatekeptInstallEnabled,
    authorizeRoot: (packageName, version) => resolveGatekeptInstallConfig(packageName, version),
    refreshGrant: refreshGatekeptInstallGrant,
    withGrantContext: (ctx, fn) => withInstallGrantContext(ctx, fn),
    getActiveGrantContext: () => {
      const ctx = getActiveInstallGrantContext();
      return ctx
        ? { rootPackageName: ctx.rootPackageName, resolution: ctx.resolution, memberKinds: ctx.memberKinds }
        : null;
    },
    withGlobalLifecycleLock: async (fn) => {
      const { withGlobalExtensionLifecycleLock } = await import("@cinatra-ai/agents");
      return withGlobalExtensionLifecycleLock(fn);
    },
    withSagaOwnedFanout: async (rootPackageName, fn) => {
      const { withSagaOwnedFanout } = await import("@cinatra-ai/agents");
      return withSagaOwnedFanout({ rootPackageName }, fn);
    },
    triggerAgentRuntimeReload: async () => {
      const { triggerWayflowReload } = await import("@cinatra-ai/agents");
      return triggerWayflowReload();
    },
    plan: (input) => planDependencyInstall(input, planDeps),
    installMember: async (member, actor) => {
      const { extensionRegistry } = await import("@cinatra-ai/extensions");
      await extensionRegistry.install(
        member.typeId,
        { registryUrl: "", packageName: member.packageName, version: member.version },
        actor,
        // cinatra#2696: THREAD the planned anchor into the dispatcher. Passed
        // only when the tuple names a level a CANONICAL ROW can carry — the
        // planner's `RowOwnershipLevel` also admits `"project"` (an agent-path
        // install TARGET with no canonical owner level), which must never reach
        // the row write; such a member falls back to the dispatcher's
        // actor-derived anchor exactly as before this slice.
        ...(member.rowOwnership && member.rowOwnership.ownerLevel !== "project"
          ? [
              {
                rowOwnership: {
                  ownerLevel: member.rowOwnership.ownerLevel,
                  ownerId: member.rowOwnership.ownerId,
                  organizationId: member.rowOwnership.organizationId,
                },
              },
            ]
          : []),
      );
    },
    updateMemberPackage: async (member, actor, expectedInstalledVersion) => {
      const { extensionRegistry } = await import("@cinatra-ai/extensions");
      await extensionRegistry.update(
        member.typeId,
        { registryUrl: "", packageName: member.packageName, version: member.version },
        actor,
        // #1042 slice-1: forward the CAS precondition only when the batch
        // supplied it (root update member). `undefined` = no CAS.
        ...(expectedInstalledVersion !== undefined ? [{ expectedInstalledVersion }] : []),
      );
    },
    isMemberProtected: async (packageName) => {
      const { resolveDeclaredProtection } = await import(
        "@cinatra-ai/extensions/protected-extension"
      );
      try {
        return await resolveDeclaredProtection(packageName);
      } catch (err) {
        // FAIL-CLOSED (cinatra#1927): a PRESENT but unreadable/malformed
        // protection declaration means we cannot prove the member is removable
        // — treat it as protected and skip the teardown rather than tear down
        // something a shipped declaration may protect.
        console.warn(
          "[extension-install-batch] protection declaration for %s is unreadable — treating as PROTECTED (compensation skipped):",
          packageName,
          err instanceof Error ? err.message : err,
        );
        return true;
      }
    },
    listScopedRowIds: async (packageName, scope) => {
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await readInstalledExtensionsByPackageName(packageName);
      // EXACT scope, EVERY status: an archived row is still a row this batch
      // must not be able to claim it created.
      return rows.filter((r) => (r.organizationId ?? null) === scope).map((r) => r.id);
    },
    withPackageInstallLock: async (packageName, fn) => {
      const { withInstallLock } = await import("@cinatra-ai/agents");
      return withInstallLock(packageName, fn);
    },
    uninstallMemberRowScoped: defaultUninstallMemberRowScoped,
    installMemberSideBySide: async (member, actor) => {
      const { installExtensionVersionSideBySide } = await import(
        "@/lib/extension-side-by-side-install"
      );
      await installExtensionVersionSideBySide({
        packageName: member.packageName,
        version: member.version,
        typeId: member.typeId,
        // The RESOLVED conflict scope (codex round-1): an org request that
        // fell back to the platform default installs the side-by-side row at
        // the PLATFORM scope, next to that default.
        orgId: member.scopeOrgId,
        actorUserId: actor.userId ?? null,
        // cinatra#1040 S6 / cinatra#1391: inject the durable capsule sink →
        // ENABLES BOTH shared-grant unions — capability-ownership AND host-ports
        // (absent → the S3 DECLARES_OWNERSHIP_KEYS + PORTS_NOT_COVERED refusals
        // both stand). The default survivor/sibling readers (fs+db, journal-
        // gated) are used; the merged capsule carries both axes' state.
        ...(member.persistCapsule
          ? { grantUnion: { persistCapsule: member.persistCapsule } }
          : {}),
      });
    },
    uninstallSideBySideMember: async (member) => {
      const { uninstallExtensionVersionSideBySide } = await import(
        "@/lib/extension-side-by-side-install"
      );
      await uninstallExtensionVersionSideBySide({
        packageName: member.packageName,
        version: member.version,
        orgId: member.scopeOrgId,
        // cinatra#1040 S6 / cinatra#1391: reconcile the shared ownership AND host-
        // port grants on teardown (the capsule carries both axes).
        capsule: member.capsule ?? null,
      });
    },
    readInstallOpForVersion: async (pkg, oid, version) => {
      const { readInstallOpForVersion } = await import("@/lib/extension-install-ops");
      return readInstallOpForVersion(pkg, oid, version);
    },
    readLiveRowVersion: async (packageName, orgId) => {
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const live = rows.filter((r) => r.status === "active" || r.status === "locked");
      const row =
        live.find((r) => (r.organizationId ?? null) === (orgId ?? null)) ??
        live.find((r) => (r.organizationId ?? null) === null) ??
        null;
      if (!row) return { present: false };
      const v = (row.source as { version?: string } | null)?.version;
      return { present: true, ...(v ? { version: v } : {}) };
    },
    readInstallOp: (pkg, orgId) => readInstallOp(pkg, orgId),
    ledger: {
      begin: (i) => batchOps.beginInstallBatch(i),
      setPhase: (id, phase) => batchOps.setInstallBatchPhase(id, phase),
      updateMember: (id, pkg, patch) => batchOps.updateInstallBatchMember(id, pkg, patch),
      listActive: () => batchOps.listActiveInstallBatches(),
    },
    now: () => Date.now(),
  };
}

/**
 * The dependency-batch install entry. See the module doc for the saga shape.
 */
export async function installExtensionWithDependencies(
  input: {
    packageName: string;
    version?: string;
    actor: Actor;
    /**
     * #1039 Option B (update-time slice): `"update"` routes the ROOT through
     * the durable UPDATE pipeline as a COMMITTED in-place member (its new
     * required deps auto-install as fresh members first; a clean shared-dep
     * dedupe-upward executes as its own committed update). Set by
     * `updateExtensionPackage` / `extensions_update` on the dev/non-gatekept
     * path only. Absent/`"install"` (default) = the unchanged fresh-install
     * flow. The gatekept update path is deferred (#1296) and never sets this.
     */
    rootAction?: "install" | "update";
    /**
     * cinatra#2696 — THE THREADED ROW ANCHOR. The canonical row-ownership tuple
     * the install-access target resolved (S1's `accessTargetToRowOwnership`),
     * handed down by the install action. It becomes the plan's ROOT tuple, so
     * every member is planned, ledger-recorded, installed and compensated at
     * that anchor (an agent dependency of a workspace-anchored root excepted —
     * see `resolveMemberRowOwnership`). ABSENT — every caller that installs
     * without an access target — falls back to the actor-derived default
     * (`ownerLevel: orgId ? "organization" : "platform"`), the exact tuple this
     * saga has always planned with, so those batches are byte-identical.
     */
    rowOwnership?: RowOwnership;
    /**
     * #1042 slice-1 (auto-update loop only): the expected currently-installed
     * version of the ROOT, forwarded to `extensionRegistry.update` as the
     * compare-and-set precondition (`expectedInstalledVersion`) ONLY for the
     * root update member. A drift at the mutation boundary refuses the update
     * before any mutation, so the loop's cached target never overwrites a
     * concurrent winner. Only meaningful with `rootAction:"update"`; absent for
     * every manual caller (byte-unchanged).
     */
    expectedRootInstalledVersion?: string;
    /**
     * @deprecated cinatra#2415 — NO-OP, kept only for source compatibility with
     * the auto-update loop's existing call site. Row-scoped compensation is no
     * longer opt-in: it is the ONLY compensation inverse, for every caller
     * (#1042 slice-2 generalized). Passing `true` changes nothing; omitting it
     * no longer selects the package-global `extensionRegistry.uninstall` — that
     * route is unreachable from compensation by construction.
     */
    rowScopedCompensation?: boolean;
  },
  depsOverride?: InstallBatchSagaDeps,
): Promise<BatchInstallResult> {
  // Tests inject COMPLETE deps; production callers take the default factory
  // (building it eagerly under injected deps would drag the whole dispatcher
  // import graph into unit tests for nothing).
  const deps = depsOverride ?? (await makeDefaultInstallBatchSagaDeps());
  const orgId = input.actor.orgId ?? null;

  // 1. AUTHORIZE ONCE (gatekept) — the single authorize of the whole install
  //    surface. If the CALLER already authorized this root and entered the
  //    grant context (the MCP surface does, so its lifecycle/visibility
  //    resolution derives instead of re-authorizing), the batch ADOPTS that
  //    context; otherwise it authorizes here and enters its own.
  const gatekept = deps.isGatekeptInstallEnabled();
  const adoptedCtx = gatekept ? deps.getActiveGrantContext() : null;
  const adopted = adoptedCtx?.rootPackageName === input.packageName ? adoptedCtx : null;
  const resolution = gatekept
    ? adopted
      ? adopted.resolution
      : await deps.authorizeRoot(input.packageName, input.version)
    : null;
  const rootVersion = resolution
    ? resolution.authorize.resolvedVersion
    : (input.version ?? "latest");

  const runBatch = async (): Promise<BatchInstallResult> => {
    // #157: fire the SINGLE agent-runtime reload iff at least one agent member
    // was installed this run. Best-effort — a reload failure is logged, never
    // fatal (the durable DB + disk writes already succeeded). Called once at the
    // batch success boundary; replaces the per-tree reload that
    // installAgentPackageWithDependencies used to fire (the agent handler now
    // installs root-only under the saga and never reloads on its own).
    const maybeReloadAgentRuntime = async (
      installed: { typeId: string; packageName: string }[],
    ): Promise<void> => {
      if (!installed.some((m) => m.typeId === "agent")) return;
      // STRICTLY best-effort: the durable DB + disk writes already landed and
      // the batch is finalized. A reload that returns ok:false OR THROWS (a
      // rejected dynamic import, a network error) must NOT fail the completed
      // install — both are logged identically and swallowed.
      try {
        const reload = await deps.triggerAgentRuntimeReload();
        if (!reload.ok) {
          // Dynamic values (package name, broker-derived reason/detail) are
          // passed as console SUBSTITUTION ARGUMENTS, never spliced into the
          // format-string position — a format string built from
          // externally-influenced input is a CodeQL js/tainted-format-string
          // hazard, and these values are not trusted to be %-clean.
          console.warn(
            "[extension-install-batch] agent runtime reload returned ok:false " +
              "reason=%s detail=%s (root %s is installed but the runtime may need " +
              "a restart or another reload trigger)",
            reload.reason ?? "—",
            reload.detail ?? "—",
            input.packageName,
          );
        }
      } catch (err) {
        console.warn(
          "[extension-install-batch] agent runtime reload threw (best-effort, " +
            "swallowed): root %s is installed but the runtime may need a restart " +
            "or another reload trigger:",
          input.packageName,
          err instanceof Error ? err.message : err,
        );
      }
    };

    const sideBySideScopeOf = (m: { sideBySideScopeOrgId?: string | null }): string | null =>
      m.sideBySideScopeOrgId === undefined ? orgId : m.sideBySideScopeOrgId;
    /**
     * The scope a member's canonical row lives at.
     *
     * cinatra#2696: this is the MEMBER'S OWN planned anchor — the ledger field
     * the executor already recorded and then discarded is now what every
     * row-addressing read and every compensation targets. A side-by-side member
     * keeps resolving its own conflict-row scope. Absent tuple (a legacy or
     * hand-injected plan) → the batch's org, the pre-#2696 value; for every
     * org-anchored install the tuple's org IS the batch's org, so the resolved
     * scope is unchanged.
     */
    const memberScopeOf = (m: {
      action: "install" | "update" | "install-side-by-side";
      sideBySideScopeOrgId?: string | null;
      rowOwnership?: RowOwnership;
    }): string | null =>
      m.action === "install-side-by-side"
        ? sideBySideScopeOf(m)
        : m.rowOwnership
          ? (m.rowOwnership.organizationId ?? null)
          : orgId;

    // 2. PLAN (+ pre-state capture + overlap guard + ledger begin) under the
    //    GLOBAL lifecycle lock — then release it before installing members
    //    (each member install takes its own per-package lock; holding the
    //    global lock across full installs would serialize every unrelated
    //    lifecycle op behind the batch).
    const planned = await deps.withGlobalLifecycleLock(async () => {
      const plan = await deps.plan({
        root: { packageName: input.packageName, version: rootVersion },
        orgId,
        // cinatra#1039 decision 1+4 / cinatra#2696: the ROOT's rowOwnership.
        // The install action's THREADED tuple when the install-access target
        // resolved one (for the two workspace targets: the org-NULL workspace
        // anchor); otherwise the extension-saga DERIVED-DEFAULT — an org install
        // is organization-owned, a null-org install platform-owned
        // (canonical-store's existing default). Forced onto every member (with
        // the #2696 agent-dependency exception); byte-identical to the previous
        // behavior whenever no tuple is threaded.
        rowOwnership: input.rowOwnership ?? {
          ownerLevel: orgId ? "organization" : "platform",
          ownerId: orgId ?? null,
          organizationId: orgId ?? null,
        },
        closure: resolution ? resolution.authorize.closure : null,
        // #1039 Option B (update-time): route the root through the durable
        // update pipeline as a committed member. `resolution == null` on the
        // dev/non-gatekept path (the only path an update is routed here); on the
        // gatekept path the planner defensively ignores this (closure != null).
        rootAction: input.rootAction ?? "install",
      });

      const toInstall = plan.ordered.filter((m) => !m.alreadyInstalled);
      const alreadyInstalled = plan.ordered
        .filter((m) => m.alreadyInstalled)
        .map((m) => m.packageName);

      // CONCURRENCY CONTRACT: refuse when ANY active batch (same org scope)
      // overlaps this plan's member set — `beginInstallOp`'s reset-on-begin
      // would otherwise let two installs fight over one (package, org)
      // journal row. Checked BEFORE the root-only fast path below: a direct
      // single-package install of a package that is a MEMBER of an in-flight
      // batch is exactly the reset-on-begin hazard this contract closes.
      // The DB's partial unique index backstops root-level uniqueness.
      const active = await deps.ledger.listActive();
      const plannedNames = new Set(plan.ordered.map((m) => m.packageName));
      for (const b of active) {
        if ((b.orgId ?? null) !== orgId) continue;
        const overlap = [b.rootPackage, ...b.members.map((m) => m.packageName)].filter((n) =>
          plannedNames.has(n),
        );
        if (overlap.length > 0) {
          throw new Error(
            `[extension-install-batch] another install batch (${b.batchId}, root ${b.rootPackage}) ` +
              `is in flight and overlaps this install on: ${[...new Set(overlap)].join(", ")} — ` +
              `retry after it completes.`,
          );
        }
      }

      // ROOT-ONLY FAST PATH: nothing to auto-install → no ledger row, the
      // root installs exactly as before (one canonical row, one journal op).
      if (toInstall.length === 1 && toInstall[0]!.packageName === input.packageName) {
        return { plan, batch: null as InstallBatch | null, toInstall, alreadyInstalled };
      }

      // PRE-STATE per member (under the same lock — precise compensation basis).
      const members: InstallBatchMember[] = [];
      for (const m of plan.ordered) {
        // cinatra#2696: the pre-state is read AT THE MEMBER'S OWN ANCHOR — the
        // compensation basis must describe the row this member will actually
        // write (an org-NULL workspace row is invisible to an org-scoped read).
        // Identical to the batch org for every org-anchored install.
        const memberScope = memberScopeOf(m);
        const row = await deps.readLiveRowVersion(m.packageName, memberScope);
        const op = await deps.readInstallOp(m.packageName, memberScope);
        members.push({
          packageName: m.packageName,
          version: m.version,
          typeId: m.typeId,
          status: m.alreadyInstalled ? "already-installed" : "planned",
          action: m.action,
          // cinatra#1039: STAMP the resolved rowOwnership onto the ledger member
          // (rides the existing JSONB `members` column — NO schema change). The
          // executor thus records WHO OWNS each installed/updated row; for the
          // extension default this equals the batch's org scope (behavior-neutral).
          rowOwnership: m.rowOwnership,
          // The RESOLVED side-by-side scope rides the ledger so compensation
          // and the boot sweeper address the same scope (codex round-1).
          ...(m.action === "install-side-by-side"
            ? // NULL is a meaningful (platform) scope — only an ABSENT value
              // falls back to the request org (?? would swallow the platform
              // fallback).
              { scopeOrgId: m.sideBySideScopeOrgId === undefined ? orgId : m.sideBySideScopeOrgId }
            : {}),
          preState: {
            present: row.present,
            ...(row.version ? { version: row.version } : {}),
            ...(op ? { installOpId: op.installOpId, installOpPhase: op.phase } : {}),
          },
        });
      }
      const batch = await deps.ledger.begin({
        batchId: randomUUID(),
        rootPackage: input.packageName,
        orgId,
        members,
      });
      await deps.ledger.setPhase(batch.batchId, "installing");
      return { plan, batch, toInstall, alreadyInstalled };
    });

    const { batch, toInstall, alreadyInstalled } = planned;
    void planned.plan; // (plan retained on `planned` for the result's resolved root version)

    // ROOT-ONLY FAST PATH (no ledger). Still runs inside the saga-owned-fan-out
    // context (#157): even a depless root must install root-only so the agent
    // handler does not re-fan-out via the second registries resolver. The
    // single agent reload fires here at the success boundary when the root is
    // an agent (installAgentFromPackage does not reload on its own).
    if (batch === null) {
      const root = toInstall[0]!;
      // #1039 Option B (update-time): a lone root can itself be a committed
      // in-place UPDATE (`updateExtensionPackage`/`extensions_update` on the
      // dev/non-gatekept path with no NEW deps to add) — route it through the
      // durable update pipeline, not a fresh install. A fresh depless install
      // stays exactly as before (installMember).
      const rootIsUpdate = root.action === "update";
      await deps.withSagaOwnedFanout(input.packageName, () =>
        rootIsUpdate
          ? // #1042 slice-1: the depless root is always `input.packageName`, so
            // forward the CAS precondition (undefined for manual callers).
            deps.updateMemberPackage(root, input.actor, input.expectedRootInstalledVersion)
          : deps.installMember(root, input.actor),
      );
      await maybeReloadAgentRuntime([root]);
      const rootEntry = { packageName: root.packageName, version: root.version };
      return {
        rootPackage: input.packageName,
        // The PLANNED root version (dev "latest" already resolved concrete).
        rootVersion: root.version,
        installed: rootIsUpdate ? [] : [rootEntry],
        // An in-place root update is surfaced under `updated`, mirroring the
        // committed dedupe-upward result partition on the batched path.
        updated: rootIsUpdate ? [rootEntry] : [],
        // The ROOT is never a side-by-side member (root conflicts are the
        // caller-chosen install/update flow).
        installedSideBySide: [],
        alreadyInstalled,
        batchId: null,
      };
    }

    // 3. INSTALL members in topo order (dependencies first, root last).
    //    EVERY failure in the per-member sequence — the TTL/refresh check,
    //    the ledger transitions, the install itself — routes into ONE abort +
    //    compensation path: the batch either returns success with the ledger
    //    `finalized`, or it compensates and throws. A ledger write failing
    //    after members installed must not strand them outside the
    //    compensation contract.
    //
    //    REQUIRES_REBUILD is a REFUSAL on every kind that throws it (the
    //    dispatcher rolled back the placeholder row — nothing durable
    //    installed), so it aborts + compensates like any failure; the RAW
    //    error is rethrown (not wrapped) so the MCP surface keeps returning
    //    its structured { requiresRebuild: true } outcome.
    const installedThisBatch: {
      packageName: string;
      version: string;
      typeId: string;
      action: "install" | "update" | "install-side-by-side";
      sideBySideScopeOrgId?: string | null;
      /** cinatra#2696: the member's own anchor — drives compensation targeting. */
      rowOwnership?: RowOwnership;
    }[] = [];
    // cinatra#2415: the member whose install THREW but which durably CREATED a
    // canonical row before failing (e.g. the dispatcher finalized the row and
    // then threw on the "did not hot-activate" check, which deliberately leaves
    // the committed install intact). An aborting batch must leave ZERO rows it
    // created, so this member's provably-created rows are torn down too — first,
    // as the most recent mutation. Its ledger status stays `failed` (it is the
    // failure, not a rolled-back success); the teardown is recorded in `detail`.
    let failedMemberWithRows:
      | {
          packageName: string;
          version: string;
          typeId: string;
          action: "install" | "update" | "install-side-by-side";
          sideBySideScopeOrgId?: string | null;
          /** cinatra#2696: the member's own anchor — drives compensation targeting. */
          rowOwnership?: RowOwnership;
        }
      | null = null;
    /**
     * cinatra#2415: persist the member's creation provenance (`after \ before`)
     * to the ledger AND mirror it into the in-memory batch member (the
     * `persistCapsule` pattern) so same-process compensation reads it without a
     * re-fetch. Called INSIDE the per-package lock, on BOTH the success and the
     * failure exit of the member's install.
     */
    const captureCreatedRows = async (
      member: {
        packageName: string;
        action: "install" | "update" | "install-side-by-side";
        sideBySideScopeOrgId?: string | null;
        rowOwnership?: RowOwnership;
      },
      before: string[],
      failed: boolean,
    ): Promise<string[] | null> => {
      let createdRowIds: string[];
      try {
        const after = await deps.listScopedRowIds(member.packageName, memberScopeOf(member));
        createdRowIds = diffCreatedRowIds(before, after);
      } catch (readErr) {
        // The capture READ failed, so we do not know what this member created.
        // `null` is NOT "created nothing": the member is left WITHOUT creation
        // provenance, which the compensation rule turns into a loud REFUSE
        // (ROLLBACK INCOMPLETE) rather than a silent skip.
        console.error(
          "[extension-install-batch] creation-provenance capture for %s FAILED — the member has no " +
            "delete authorization and its compensation will be refused for manual review:",
          member.packageName,
          readErr instanceof Error ? readErr.message : readErr,
        );
        await deps.ledger
          .updateMember(batch.batchId, member.packageName, {
            detail:
              "creation-provenance capture failed — compensation cannot prove what this member " +
              "created (cinatra#2415); reconcile from preRowIds",
          })
          .catch(() => undefined);
        return null;
      }
      const lm = batch.members.find((x) => x.packageName === member.packageName);
      if (lm) lm.createdRowIds = createdRowIds;
      await deps.ledger
        .updateMember(batch.batchId, member.packageName, {
          createdRowIds,
          ...(failed && createdRowIds.length > 0
            ? {
                detail:
                  `install FAILED after durably creating ${createdRowIds.length} canonical row(s) ` +
                  `— compensated by this batch (cinatra#2415)`,
              }
            : {}),
        })
        .catch(() => undefined);
      return createdRowIds;
    };
    for (const member of toInstall) {
      try {
        // P2-5 GRANT TTL: refresh near expiry; refusal/unavailability aborts.
        if (resolution) {
          const expiresAt = Date.parse(resolution.authorize.expiresAt);
          // FAIL CLOSED on an unparseable expiry: we cannot prove the grant is
          // still valid, so we must NOT proceed under it. (An unparseable expiry
          // would otherwise skip the near-expiry check and run the batch until
          // the grant expired mid-install — a trust-floor weakening.)
          if (!Number.isFinite(expiresAt)) {
            throw new Error(
              `[extension-install-batch] the active grant for ${input.packageName}@${rootVersion} ` +
                `has an unparseable expiry (${String(resolution.authorize.expiresAt)}) — refusing ` +
                `to continue the batch (newly-installed members are compensated; retry to ` +
                `authorize a fresh grant).`,
            );
          }
          if (expiresAt - deps.now() < GRANT_REFRESH_MARGIN_MS) {
            const { computeClosureHash } = await import("@/lib/gatekept-install");
            const refreshed = await deps.refreshGrant(resolution, {
              packageName: input.packageName,
              version: rootVersion,
              closureHash: computeClosureHash(resolution.authorize.closure),
            });
            // The refresh must NOT change the authorization set (closure-hash
            // binding) — a drifted closure is a refused refresh.
            const same =
              refreshed.authorize.closure.length === resolution.authorize.closure.length &&
              refreshed.authorize.closure.every((c) =>
                resolution.authorize.closure.some(
                  (o) => o.name === c.name && o.version === c.version,
                ),
              );
            if (!same) {
              throw new Error(
                `[extension-install-batch] grant refresh returned a DIFFERENT closure for ` +
                  `${input.packageName}@${rootVersion} — refusing to continue the batch.`,
              );
            }
            // Mutate in place: the grant context holds this object by
            // reference, so derived member reads pick up the new grant token.
            resolution.config = refreshed.config;
            resolution.authorize = refreshed.authorize;
          }
        }

        // cinatra#2415 — DURABLE BATCH PROVENANCE, captured atomically with the
        // mutation it describes. The pre-read, the pre-write, the install and
        // the post-read all happen inside ONE hold of the per-package install
        // lock — the SAME re-entrant `withInstallLock` the dispatcher's own
        // install takes internally, so this adds no new serialization; it just
        // extends the already-held section to cover the reads. Reading `before`
        // outside the lock would let an unrelated concurrent insert be
        // mis-attributed to this batch.
        await deps.withPackageInstallLock(member.packageName, async () => {
          const memberScope = memberScopeOf(member);
          const preRowIds = await deps.listScopedRowIds(member.packageName, memberScope);
          {
            const lm = batch.members.find((x) => x.packageName === member.packageName);
            if (lm) lm.preRowIds = preRowIds;
          }
          // The pre-mutation evidence is persisted BEFORE the mutation: a crash
          // between here and the post-capture still leaves the boot sweeper able
          // to recompute the difference under the lock.
          await deps.ledger.updateMember(batch.batchId, member.packageName, {
            status: "installing",
            preRowIds,
          });
          // #157: the agent handler dispatched here installs ROOT-ONLY under the
          // saga-owned-fan-out context — the saga (this loop) owns the dependency
          // fan-out, so no second registries dep-resolver runs per member.
          //
          // #1039 Option B: an `action:"update"` member is a CLEAN dedupe-upward of
          // an already-installed shared dependency — routed through the durable
          // UPDATE pipeline (in-place re-materialize at the new pin), not a fresh
          // install. It is a COMMITTED upgrade: because it is a pre-existing member
          // (`preState.present`), the newly-installed-only compensation loop below
          // and the boot sweeper both skip it, so a later member's failure leaves
          // it at the new (provably non-breaking) version.
          // cinatra#1040 S3: an `install-side-by-side` member routes through the
          // version-scoped storage installer — NEVER the package-scoped install
          // (which would resolve/short-circuit against the DEFAULT row) and never
          // an upgraded/derived action: only the PLANNER emits this action, on
          // the non-gatekept path exclusively.
          try {
            await deps.withSagaOwnedFanout(input.packageName, () =>
              member.action === "update"
                ? // #1042 slice-1: forward the CAS precondition ONLY for the ROOT
                // update member — a non-root dedupe-upward member is an internal
                // committed upgrade with no caller-supplied expectation.
                deps.updateMemberPackage(
                  member,
                  input.actor,
                  member.packageName === input.packageName
                    ? input.expectedRootInstalledVersion
                    : undefined,
                )
              : member.action === "install-side-by-side"
                ? deps.installMemberSideBySide(
                    {
                      ...member,
                      scopeOrgId: sideBySideScopeOf(member),
                      // cinatra#1040 S6: the durable capsule sink for THIS member.
                      // Persist to the ledger (DB — for cross-process boot
                      // recovery) AND mirror into the in-memory batch member (so
                      // same-process compensation below reads it without a
                      // re-fetch). Called UNDER the side-by-side install's
                      // per-package lock, BEFORE any ownership-grant mutation.
                      persistCapsule: async (capsule) => {
                        await deps.ledger.updateMember(batch.batchId, member.packageName, {
                          grantCapsule: capsule,
                        });
                        const lm = batch.members.find(
                          (x) => x.packageName === member.packageName,
                        );
                        if (lm) lm.grantCapsule = capsule;
                      },
                    },
                    input.actor,
                  )
                : deps.installMember(member, input.actor),
            );
          } catch (installErr) {
            // The install THREW. Capture the provenance anyway (still inside the
            // lock): a dispatcher that finalized a row and then threw leaves a
            // durable row this batch created, and the invariant says it must not
            // survive the abort. Recorded, then compensated with the rest.
            //
            // `null` = the capture itself failed. That is NOT "created nothing":
            // the member is queued anyway so the compensation rule REFUSES it
            // loudly (ROLLBACK INCOMPLETE) instead of dropping it silently.
            const createdOnFailure = await captureCreatedRows(member, preRowIds, true);
            if (createdOnFailure === null || createdOnFailure.length > 0) {
              failedMemberWithRows = member;
            }
            throw installErr;
          }
          // Track the durable install/update IMMEDIATELY — before the ledger write —
          // so a ledger failure right after a successful member op still routes it
          // correctly (an install compensates; a committed update is skipped by the
          // pre-existing-member guard in compensation).
          installedThisBatch.push(member);
          await captureCreatedRows(member, preRowIds, false);
          const op =
            member.action === "install-side-by-side"
              ? await deps
                  .readInstallOpForVersion(
                    member.packageName,
                    sideBySideScopeOf(member),
                    member.version,
                  )
                  .catch(() => null)
              : // cinatra#2696: the journal anchor of the row this member wrote
                // — its OWN scope, not the actor's.
                await deps.readInstallOp(member.packageName, memberScope).catch(() => null);
          await deps.ledger.updateMember(batch.batchId, member.packageName, {
            status: "installed",
            ...(op ? { installOpId: op.installOpId } : {}),
          });
        });
      } catch (err) {
        await abortAndCompensate(member.packageName, err);
        throw err; // unreachable (abortAndCompensate throws) — defensive.
      }
    }

    try {
      await deps.ledger.setPhase(batch.batchId, "finalized");
    } catch (err) {
      // The batch is success IFF the ledger says `finalized` — a batch left
      // ACTIVE would be compensated by the boot sweeper later anyway, so
      // compensate NOW, deterministically, with the loud error.
      await abortAndCompensate(input.packageName, err);
      throw err; // unreachable — defensive.
    }
    // cinatra#1040 S6: RELEASE spent capsules (orphan-GC happy path). The
    // side-by-side members are COMMITTED now — their durable declaration
    // capsules will never be consumed by a teardown (an explicit uninstall
    // reconciles fresh from the live store), so clear them with an evidence
    // log. Best-effort: a crash before this leaves a capsule on a FINALIZED
    // batch member, which the boot orphan-GC (`gcOrphanedSideBySideCapsules`)
    // collects. After `finalized` so a clear failure never un-finalizes.
    {
      const released: string[] = [];
      for (const m of installedThisBatch) {
        if (m.action !== "install-side-by-side") continue;
        const ok = await deps.ledger
          .updateMember(batch.batchId, m.packageName, { grantCapsule: null })
          .then(() => true)
          .catch(() => false);
        if (ok) released.push(`${m.packageName}@${m.version}`);
      }
      if (released.length > 0) {
        console.warn(
          `[side-by-side-capsule] released ${released.length} spent capsule(s) for ` +
            `finalized batch ${batch.batchId}: ${released.join(", ")}`,
        );
      }
    }
    // #157: SINGLE agent-runtime reload at the batch success boundary. The
    // agent handler installed root-only per member (no per-member reload) and
    // installAgentFromPackage never reloads on its own, so the saga is now the
    // canonical single-shot reload. Fires ONCE for the whole batch iff an agent
    // member was installed this run; best-effort (durable writes already
    // landed). After `finalized` so a reload failure never un-finalizes a batch.
    await maybeReloadAgentRuntime(installedThisBatch);
    return {
      rootPackage: input.packageName,
      // The PLANNED root version — concrete on both paths (gatekept authorize
      // pin, or the dev registry resolution).
      rootVersion:
        planned.plan.ordered.find((m) => m.packageName === input.packageName)?.version ??
        rootVersion,
      installed: installedThisBatch
        .filter((m) => m.action === "install")
        .map(({ packageName, version }) => ({ packageName, version })),
      updated: installedThisBatch
        .filter((m) => m.action === "update")
        .map(({ packageName, version }) => ({ packageName, version })),
      installedSideBySide: installedThisBatch
        .filter((m) => m.action === "install-side-by-side")
        .map(({ packageName, version }) => {
          const evidence = planned.plan.ordered.find(
            (pm) => pm.packageName === packageName,
          )?.sideBySideEvidence?.detail;
          return { packageName, version, ...(evidence ? { evidence } : {}) };
        }),
      alreadyInstalled,
      batchId: batch.batchId,
    };

    // -- 4. abort + inverse-order compensation -----------------------------
    async function abortAndCompensate(failedMember: string, cause: unknown): Promise<never> {
      await deps.ledger
        .updateMember(batch!.batchId, failedMember, {
          status: "failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        })
        .catch(() => undefined);
      await deps.ledger.setPhase(batch!.batchId, "failed").catch(() => undefined);

      const compensated: string[] = [];
      const failures: string[] = [];
      // cinatra#2415: the compensation actor — platform standing STRIPPED (never
      // attached), no role synthesized, scope pinned to the batch's own. See
      // `buildBatchCompensationActor`. Row targeting is ledger-derived; this
      // actor is the AUDIT envelope.
      const compensationActor = buildBatchCompensationActor(input.actor, orgId);
      // Members THIS batch mutated, INVERSE order — the failed member (when it
      // durably created a row before throwing) is the most recent, so it comes
      // first. Which of them is actually torn down is decided per member by
      // `decideMemberCompensation` from the DURABLE ledger provenance.
      const compensationQueue = [
        ...installedThisBatch,
        ...(failedMemberWithRows ? [failedMemberWithRows] : []),
      ].reverse();
      for (const m of compensationQueue) {
        const isFailedMember = m === failedMemberWithRows;
        const ledgerMember = batch!.members.find((x) => x.packageName === m.packageName);
        const decision = decideMemberCompensation(m.action, ledgerMember);
        if (decision.kind === "skip") continue; // committed update / nothing created / pre-existing
        if (decision.kind === "refuse") {
          // No durable provenance ⇒ we cannot prove this batch created the row.
          // Refuse rather than delete on a guess (only reachable for a ledger
          // row written before cinatra#2415).
          failures.push(m.packageName);
          await deps.ledger
            .updateMember(batch!.batchId, m.packageName, {
              status: "compensation-failed",
              detail:
                "compensation refused — no durable batch provenance (pre-cinatra#2415 ledger row)",
            })
            .catch(() => undefined);
          console.error(
            `[extension-install-batch] compensation of ${m.packageName} REFUSED (batch ${batch!.batchId}): ` +
              `no durable provenance proves this batch created the row — left for manual review.`,
          );
          continue;
        }
        // DECLARATION-DRIVEN PROTECTION (cinatra#1927) — never tear down an
        // extension whose own declaration marks it protected, on EITHER
        // compensation inverse (the dispatcher route would refuse anyway; the
        // row-scoped route bypasses the dispatcher and would not). Recorded
        // honestly as a skip, so the ledger shows the extension is still
        // installed BY DECLARATION rather than as a silent compensation gap.
        if (await deps.isMemberProtected(m.packageName)) {
          await deps.ledger
            .updateMember(batch!.batchId, m.packageName, {
              detail: "compensation skipped — protected-declaration (cinatra#1927)",
            })
            .catch(() => undefined);
          console.warn(
            `[extension-install-batch] compensation of ${m.packageName} SKIPPED (batch ${batch!.batchId}): ` +
              `the extension declares itself protected — it is never uninstalled.`,
          );
          continue;
        }
        try {
          if (decision.kind === "side-by-side") {
            await deps.uninstallSideBySideMember(
              {
                ...m,
                scopeOrgId: sideBySideScopeOf(m),
                // cinatra#1040 S6: the member's durable capsule (mirrored into
                // the in-memory ledger by the persist sink above) drives the
                // ownership-grant reconcile on this compensation teardown.
                capsule: ledgerMember?.grantCapsule ?? null,
              },
              compensationActor,
            );
          } else {
            // cinatra#2415: the ROW-SCOPED inverse is the ONLY inverse — it
            // deletes exactly the rows the ledger proves this batch created and
            // can never fan out to another scope. `uninstallMember` (the
            // package-scoped dispatcher) is deliberately NOT reachable from
            // compensation: its non-platform branch archives (the row survives)
            // and its platform branch is package-global (the #2410 boundary).
            await deps.uninstallMemberRowScoped(
              {
                typeId: m.typeId,
                packageName: m.packageName,
                version: m.version,
                scopeOrgId: memberScopeOf(m),
                createdRowIds: ledgerMember?.createdRowIds ?? null,
              },
              compensationActor,
            );
          }
          await deps.ledger.updateMember(
            batch!.batchId,
            m.packageName,
            // The FAILED member keeps its `failed` status — it is the failure,
            // not a rolled-back success. Its teardown is recorded in `detail`
            // (written at capture time), so the ledger stays honest.
            isFailedMember ? {} : { status: "compensated" },
          );
          compensated.push(m.packageName);
        } catch (err) {
          failures.push(m.packageName);
          await deps.ledger
            .updateMember(batch!.batchId, m.packageName, {
              status: "compensation-failed",
              detail: err instanceof Error ? err.message : String(err),
            })
            .catch(() => undefined);
          console.error(
            `[extension-install-batch] compensation uninstall of ${m.packageName} failed (batch ${batch!.batchId}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      await deps.ledger
        .setPhase(batch!.batchId, failures.length === 0 ? "compensated" : "failed")
        .catch(() => undefined);
      // REQUIRES_REBUILD: the refusing kind needs a host rebuild before this
      // install can proceed — compensation has run; rethrow the RAW error so
      // the structured { requiresRebuild } surface contract is preserved.
      if ((cause as { code?: unknown } | null)?.code === "REQUIRES_REBUILD") {
        throw cause;
      }
      // AGENT_PACKAGE_CONTRACT_VIOLATION: a closure MEMBER failed the
      // fail-closed agent metadata contract. Compensation has run; rethrow the
      // RAW structured error (naming the offending package + exact fields) so
      // the MCP install surface renders a structured 4xx-shaped result instead
      // of the wrapped error becoming an opaque 500. Same raw-rethrow contract
      // as REQUIRES_REBUILD above (string-literal code — no cross-package
      // import). cinatra#1163.
      if (
        (cause as { code?: unknown } | null)?.code ===
        "AGENT_PACKAGE_CONTRACT_VIOLATION"
      ) {
        throw cause;
      }
      throw new BatchMemberInstallError(
        `Installing ${input.packageName}@${rootVersion} failed at dependency ${failedMember}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. ` +
          (compensated.length > 0
            ? `Rolled back the dependencies this install had added (${compensated.join(", ")}); `
            : `No dependencies needed rollback; `) +
          (failures.length > 0
            ? `ROLLBACK INCOMPLETE for ${failures.join(", ")} — these may need manual removal. `
            : ``) +
          `Previously-installed extensions were not touched.`,
        failedMember,
        compensated,
        failures,
        cause,
      );
    }
  };

  // The WHOLE batch (planning + member installs) runs inside the grant
  // context on the gatekept path — `resolveGatekeptInstallConfig` derives
  // every read from the root grant; authorize ran exactly once (here or in
  // the adopting caller).
  if (resolution) {
    // memberKinds are only known after planning; the context map is filled by
    // the planner via this wrapper (reads happen during/after planning).
    const targetKinds = adopted
      ? adopted.memberKinds
      : new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">();
    const innerPlan = deps.plan;
    deps.plan = async (i) => {
      const p = await innerPlan(i);
      for (const [k, v] of p.memberKinds) targetKinds.set(k, v);
      return p;
    };
    if (adopted) {
      // Already INSIDE the caller's context — run directly (re-entering with
      // the same object would be a harmless nest; skipping it keeps the
      // adopted context the single source of truth).
      return runBatch();
    }
    return deps.withGrantContext(
      { rootPackageName: input.packageName, resolution, memberKinds: targetKinds },
      runBatch,
    );
  }
  return runBatch();
}

// ---------------------------------------------------------------------------
// Boot recovery — the batch sweeper
// ---------------------------------------------------------------------------

/**
 * Compensate STALE active batches from the ledger (compensate-never-resume:
 * there is no root grant at boot, and P2-5 forbids continuing without one).
 *
 * cinatra#2415: boot recovery enforces the SAME invariant as the live abort
 * path, with the SAME code. It reads the SAME durable per-member provenance
 * (`createdRowIds`) and routes every non-side-by-side member through the
 * ROW-SCOPED inverse — so
 * a process crash can no longer violate the invariant the live path enforces.
 * Its actor is built by the same `buildBatchCompensationActor` (no standing,
 * scope pinned to the batch's own). Idempotent + best-effort per member; a
 * member without durable provenance is REFUSED, never deleted on a guess.
 */
export async function sweepStaleInstallBatches(
  opts?: { olderThanMs?: number },
  depsOverride?: {
    listStale?: (olderThanMs: number) => Promise<InstallBatch[]>;
    setPhase?: (batchId: string, phase: InstallBatch["phase"]) => Promise<InstallBatch>;
    updateMember?: (
      batchId: string,
      packageName: string,
      patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail">>,
    ) => Promise<InstallBatch>;
    /** cinatra#2415: the SAME row-scoped, provenance-targeted inverse the saga uses. */
    uninstallMemberRowScoped?: (
      member: RowScopedCompensationMember,
      actor: Actor,
    ) => Promise<void>;
    /** cinatra#1927 — same declaration-driven protection check the live saga
     *  applies, so BOOT RECOVERY cannot tear down a protected extension either. */
    isMemberProtected?: (packageName: string) => Promise<boolean>;
    /** Version-scoped teardown for `install-side-by-side` members (cinatra#1040 S3). */
    uninstallSideBySideMember?: (member: {
      typeId: string;
      packageName: string;
      version: string;
      orgId: string | null;
      /** cinatra#1040 S6: the swept member's durable capsule → ownership reconcile. */
      capsule?: SideBySideGrantCapsule | null;
    }) => Promise<void>;
  },
  batchOpsDeps?: InstallBatchOpsDeps,
): Promise<{ swept: number }> {
  const olderThanMs = opts?.olderThanMs ?? 5 * 60 * 1000;
  const batchOps = await import("@/lib/extension-install-batch-ops");
  const listStale =
    depsOverride?.listStale ?? ((ms: number) => batchOps.listStaleInstallBatches(ms, batchOpsDeps));
  const setPhase =
    depsOverride?.setPhase ??
    ((id: string, phase: InstallBatch["phase"]) => batchOps.setInstallBatchPhase(id, phase, batchOpsDeps));
  const updateMember =
    depsOverride?.updateMember ??
    ((
      id: string,
      pkg: string,
      patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail">>,
    ) => batchOps.updateInstallBatchMember(id, pkg, patch, batchOpsDeps));
  // cinatra#2415: the boot-recovery audit identity. Per batch it is narrowed to
  // that batch's own scope by `buildBatchCompensationActor` (no standing is ever
  // attached — targeting is ledger-derived).
  const sweeperIdentity: Actor = { actorType: "system", source: "worker" };
  const isMemberProtected =
    depsOverride?.isMemberProtected ??
    (async (packageName: string) => {
      const { resolveDeclaredProtection } = await import(
        "@cinatra-ai/extensions/protected-extension"
      );
      try {
        return await resolveDeclaredProtection(packageName);
      } catch {
        return true; // fail-closed: unreadable declaration ⇒ never swept away
      }
    });
  const uninstallMemberRowScoped =
    depsOverride?.uninstallMemberRowScoped ?? defaultUninstallMemberRowScoped;
  const uninstallSideBySideMember =
    depsOverride?.uninstallSideBySideMember ??
    (async (member: {
      typeId: string;
      packageName: string;
      version: string;
      orgId: string | null;
      capsule?: SideBySideGrantCapsule | null;
    }) => {
      const { uninstallExtensionVersionSideBySide } = await import(
        "@/lib/extension-side-by-side-install"
      );
      await uninstallExtensionVersionSideBySide({
        packageName: member.packageName,
        version: member.version,
        orgId: member.orgId,
        // cinatra#1040 S6 / cinatra#1391: reconcile the shared ownership AND host-
        // port grants on boot teardown (the capsule carries both axes).
        capsule: member.capsule ?? null,
      });
    });

  const stale = await listStale(olderThanMs);
  let swept = 0;
  for (const batch of stale) {
    // Inverse install order = reverse ledger order (the ledger is topo-ordered).
    // Which members are torn down is decided by the SAME pure rule the live
    // abort path uses (cinatra#2415): the durable per-member provenance
    // OUTRANKS the legacy `preState.present` heuristic, so an org batch that
    // created an org row while a platform row existed is no longer skipped.
    const compensationActor = buildBatchCompensationActor(
      sweeperIdentity,
      batch.orgId ?? null,
    );
    const candidates = [...batch.members]
      .reverse()
      .filter((m) => m.status === "installed" || m.status === "installing");
    let failures = 0;
    for (const m of candidates) {
      const decision = decideMemberCompensation(m.action, m);
      if (decision.kind === "skip") continue;
      if (decision.kind === "refuse") {
        // No durable provenance (a ledger row written before cinatra#2415):
        // refuse rather than delete a row this batch cannot prove it created.
        failures += 1;
        await updateMember(batch.batchId, m.packageName, {
          status: "compensation-failed",
          detail:
            "boot-sweep compensation refused — no durable batch provenance (pre-cinatra#2415 ledger row)",
        }).catch(() => undefined);
        console.error(
          `[extension-install-batch] boot sweep: compensation of ${m.packageName} REFUSED (batch ${batch.batchId}): ` +
            `no durable provenance proves this batch created the row — left for manual review.`,
        );
        continue;
      }
      // cinatra#1927: a protected extension is never torn down, not even by
      // boot recovery — recorded as a skip, exactly like the live saga.
      if (await isMemberProtected(m.packageName)) {
        await updateMember(batch.batchId, m.packageName, {
          detail: "boot-sweep compensation skipped — protected-declaration (cinatra#1927)",
        }).catch(() => undefined);
        continue;
      }
      try {
        if (decision.kind === "side-by-side") {
          await uninstallSideBySideMember({
            typeId: m.typeId,
            packageName: m.packageName,
            version: m.version,
            // The RESOLVED scope from the ledger (codex round-1); legacy rows
            // without it fall back to the batch's org.
            orgId: m.scopeOrgId === undefined ? (batch.orgId ?? null) : m.scopeOrgId,
            // cinatra#1040 S6: the DURABLE capsule persisted at install time
            // (read from the ledger member) reconciles the shared ownership
            // grant on this boot-recovery teardown.
            capsule: m.grantCapsule ?? null,
          });
        } else {
          // cinatra#2415: the SAME provenance-targeted row-scoped inverse the
          // live abort path uses — never the package-global dispatcher.
          await uninstallMemberRowScoped(
            {
              typeId: m.typeId,
              packageName: m.packageName,
              version: m.version,
              // cinatra#2696: the member's OWN recorded anchor. The ledger
              // stamps `rowOwnership` per member, so boot recovery addresses the
              // scope the row was actually created at — an org-NULL
              // workspace-anchored row included, which the batch's org would
              // never match (the inverse's provenance revalidation would refuse
              // it and leave the row behind). Legacy members without the field
              // fall back to the batch org, exactly as before.
              scopeOrgId: m.rowOwnership
                ? (m.rowOwnership.organizationId ?? null)
                : (batch.orgId ?? null),
              createdRowIds: m.createdRowIds ?? null,
            },
            compensationActor,
          );
        }
        await updateMember(batch.batchId, m.packageName, { status: "compensated" });
      } catch (err) {
        failures += 1;
        await updateMember(batch.batchId, m.packageName, {
          status: "compensation-failed",
          detail: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
        console.error(
          `[extension-install-batch] boot sweep: compensation uninstall of ${m.packageName} failed (batch ${batch.batchId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await setPhase(batch.batchId, failures === 0 ? "compensated" : "failed").catch(() => undefined);
    swept += 1;
  }
  return { swept };
}

/**
 * (package, org) keys owned by STILL-ACTIVE batches — the per-op boot-orphan
 * cleanup must SKIP these (the batch sweeper owns batch-member ops; sweeping
 * them per-op would compensate a batch another worker is actively driving).
 */
export async function collectActiveBatchMemberKeys(
  batchOpsDeps?: InstallBatchOpsDeps,
): Promise<Set<string>> {
  const { listActiveInstallBatches } = await import("@/lib/extension-install-batch-ops");
  const active = await listActiveInstallBatches(batchOpsDeps);
  const keys = new Set<string>();
  for (const b of active) {
    for (const m of b.members) keys.add(`${m.packageName}::${b.orgId ?? "(global)"}`);
  }
  return keys;
}

/**
 * ORPHAN-GC (cinatra#1040 S6): clear SPENT side-by-side declaration capsules
 * left on TERMINAL batches. A capsule is spent once its batch is terminal — a
 * finalized member's version committed (no teardown consumes it); a compensated
 * member was already reconciled on teardown. The happy path RELEASES capsules at
 * the finalize boundary; this collects the ones a crash left behind between the
 * boundary and the release, so they don't accumulate. Each clear is logged with
 * evidence (the terminal phase that proves the capsule is spent). Idempotent +
 * best-effort per member. Runs at boot AFTER the stale-batch sweep (which OWNS
 * the capsules of still-ACTIVE batches — those are reconciled on teardown, never
 * GC'd here).
 */
export async function gcOrphanedSideBySideCapsules(depsOverride?: {
  listTerminalWithCapsules?: () => Promise<InstallBatch[]>;
  updateMember?: (
    batchId: string,
    packageName: string,
    patch: Partial<Pick<InstallBatchMember, "grantCapsule">>,
  ) => Promise<InstallBatch>;
}): Promise<{ cleared: number }> {
  const batchOps = await import("@/lib/extension-install-batch-ops");
  const listTerminal =
    depsOverride?.listTerminalWithCapsules ??
    (() => batchOps.listTerminalInstallBatchesWithCapsules());
  const updateMember =
    depsOverride?.updateMember ??
    ((id: string, pkg: string, patch: Partial<Pick<InstallBatchMember, "grantCapsule">>) =>
      batchOps.updateInstallBatchMember(id, pkg, patch));

  const batches = await listTerminal();
  let cleared = 0;
  for (const b of batches) {
    for (const m of b.members) {
      if (m.action !== "install-side-by-side" || !m.grantCapsule) continue;
      // PROVEN-SPENT ONLY (cinatra#1391 / codex round-0): a capsule is cleared
      // when its member COMMITTED on a finalized batch (no teardown will ever
      // consume it) or was COMPENSATED (the teardown already reconciled from
      // it). A `failed` / `compensation-failed` member — or an `installed`
      // member stranded on a failed batch by a mid-compensation crash — keeps
      // its capsule: it is the ONLY durable record of the shared-grant prior
      // state, and clearing it would destroy the recovery evidence.
      const spent =
        m.status === "compensated" ||
        (b.phase === "finalized" &&
          (m.status === "installed" || m.status === "already-installed"));
      if (!spent) {
        console.warn(
          `[side-by-side-capsule] orphan-GC KEPT an unproven capsule: ${m.packageName}@${m.version} ` +
            `on terminal batch ${b.batchId} (phase=${b.phase}, member=${m.status}) — needs ` +
            `manual reconcile/review before release`,
        );
        continue;
      }
      const ok = await updateMember(b.batchId, m.packageName, { grantCapsule: null })
        .then(() => true)
        .catch((err) => {
          console.error(
            `[side-by-side-capsule] orphan-GC clear of ${m.packageName}@${m.version} ` +
              `(batch ${b.batchId}) failed:`,
            err instanceof Error ? err.message : err,
          );
          return false;
        });
      if (ok) {
        cleared += 1;
        console.warn(
          `[side-by-side-capsule] orphan-GC cleared a spent capsule: ${m.packageName}@${m.version} ` +
            `on terminal batch ${b.batchId} (evidence: phase=${b.phase})`,
        );
      }
    }
  }
  return { cleared };
}
