import "server-only";

// The TRUSTED install-record resolver — closes the runtime-loader loop.
//
// The boot RuntimePackageLoader refuses to import anything without a trusted
// anchor sourced OUTSIDE the writable package store. This module IS that
// source: it reads the canonical `installed_extension` row (recorded by the
// install pipeline with a REAL tarball integrity + content hash) and the
// admin-approved host-port grant, and returns the `InstallTrustAnchor` the
// loader's trust gate consumes. Legacy/dispatcher rows (placeholder integrity,
// no content hash) yield `null` → the package is NOT activatable at runtime.
//
// Dependency-injected so the resolution logic is unit-testable without a DB; the
// default factory wires the canonical store + the grant store.

import type { InstallTrustAnchor } from "@/lib/extension-package-store";

/** A minimal view of the canonical install row the resolver needs. */
export type InstallAnchorRow = {
  status: string;
  /**
   * The canonical row's extension KIND (cinatra#792) — surfaced on the resolved
   * anchor so the loader can bind it to the store record's PATH kind
   * (`<root>/<kind>/<slug>/<digest>`), fail-closed on a mismatch. Optional so
   * pure unit tests can omit it (treated as unbound — no kind assertion).
   */
  kind?: string;
  source: {
    type?: string;
    registryUrl?: string;
    integrity?: string;
    contentHash?: string;
    version?: string;
    /** base64 Ed25519 signature over the tarball, if the producer signed it. */
    signature?: string;
    /** The recorded materialization-plan closureHash (cinatra#181), if the package carried a plan. */
    closureHash?: string;
    /** The DB-authoritative active tarball digest (cinatra#792), if recorded. */
    activeDigest?: string;
  } | null;
};

export type InstallAnchorGrant = { status: string; approvedPorts: string[]; orgId: string | null };

export type ResolveInstallAnchorDeps = {
  readActiveInstall: (packageName: string, orgId: string | null) => Promise<InstallAnchorRow | null>;
  readGrant: (packageName: string, orgId: string | null) => Promise<InstallAnchorGrant | null>;
  /**
   * Read the install-op journal ANCHOR for the package. The PRIMARY trust gate:
   * a row only resolves to a trusted anchor when its phase is `finalized`. A
   * half-install (provenance maybe written, but the saga never finalized) is
   * refused here even if the integrity/contentHash belt-and-suspenders check
   * would otherwise pass. `digest` (cinatra#158) is the tarball digest the
   * finalized op recorded; it is surfaced on the resolved anchor so the loader
   * can bind the anchor to the on-disk bytes. Optional so pure unit tests can
   * omit it (treated as "no journal row" → refuse).
   */
  readInstallOp?: (
    packageName: string,
    orgId: string | null,
  ) => Promise<{ phase: string; digest?: string | null } | null>;
  orgId?: string | null;
};

/** Integrity values that mean "not materialized through the real pipeline". */
const PLACEHOLDER_INTEGRITY = new Set(["", "dispatcher-install", "pending-resolution", "latest", "HEAD"]);

/**
 * The ACTIVE-DIGEST SELECTOR (cinatra#792) — the single, shared, JOURNAL-GATED
 * rule for which store digest an install row pins. Used by the anchor resolver
 * (boot/hot-activate trust gate) AND the boot rematerialization sweep, so the
 * two can never rebuild/select different digests.
 *
 * Selection order:
 *  - row `source.activeDigest` present AND equal to the FINALIZED install-op
 *    journal digest → that digest (the DB is authoritative, journal-confirmed);
 *  - row `source.activeDigest` absent → the journal digest alone (legacy rows;
 *    may be null = unbound);
 *  - row `source.activeDigest` present but the journal digest is missing or
 *    different → FAIL CLOSED (`ok:false`). A crash between the provenance
 *    write and the journal finalize (or a torn rollback) can never leave the
 *    row's field outranking the journal — the journal remains the primary
 *    trust gate, the row field is a cross-checked binding on top of it.
 *
 * The plain-text `current` store file is deliberately NOT an input here: it is
 * a write-only mirror/ops hint (the writable store must never select what gets
 * imported).
 */
export function selectActiveDigest(input: {
  /** The canonical row's `source.activeDigest`, if recorded. */
  activeDigest: string | null | undefined;
  /** The FINALIZED install-op journal's recorded digest, if any. */
  journalDigest: string | null | undefined;
}): { ok: true; digest: string | null } | { ok: false; reason: string } {
  const rowDigest = input.activeDigest ?? null;
  const journalDigest = input.journalDigest ?? null;
  if (rowDigest === null) return { ok: true, digest: journalDigest };
  if (journalDigest === null) {
    return {
      ok: false,
      reason: `row activeDigest ${rowDigest} has no finalized journal digest to confirm it — fail closed`,
    };
  }
  if (rowDigest !== journalDigest) {
    return {
      ok: false,
      reason: `row activeDigest ${rowDigest} != finalized journal digest ${journalDigest} — fail closed`,
    };
  }
  return { ok: true, digest: rowDigest };
}

/**
 * Pick the SINGLE live canonical row for an exact (package, org) scope, or null
 * when none exists OR more than one does. A row is live when its status is
 * `active` OR `locked` (locked = removal-protected, still a live install).
 * Canonical identity is (organization_id, owner_level, owner_id, package_name),
 * so multiple live rows for one (package, org) are legal (different owners). The
 * runtime trust gate must resolve exactly ONE row, so an ambiguous match FAILS
 * CLOSED rather than trusting (and activating) an arbitrary owner's install.
 *
 * SIDE-BY-SIDE VERSIONS (cinatra#1040 S3): with versioned identity a scope can
 * also hold NON-DEFAULT sibling version rows (`isDefault === false`). Single-row
 * surfaces resolve the DEFAULT row — the picker selects EXACTLY ONE live default
 * (a legacy row/fixture without `isDefault` counts as default; the DB enforces
 * at most one default per (org, owner, package)):
 *   - one default + any number of non-default siblings → the default;
 *   - two defaults (cross-owner ambiguity) → null (fail closed, as before);
 *   - ZERO defaults (only non-default siblings remain) → null — a non-default
 *     version row is INVISIBLE to single-row runtime surfaces until the
 *     versioned-activation slice (S4); resolving one here would prematurely
 *     promote it.
 */
export function pickSingleActiveRow<
  T extends { status: string; organizationId: string | null; isDefault?: boolean },
>(rows: readonly T[], orgId: string | null): T | null {
  const matching = rows.filter(
    (r) => (r.status === "active" || r.status === "locked") && (r.organizationId ?? null) === orgId,
  );
  const defaults = matching.filter((r) => r.isDefault !== false);
  return defaults.length === 1 ? defaults[0] : null;
}

/**
 * PLATFORM-GLOBAL pick: the SINGLE live (active|locked) canonical row for a
 * package ACROSS ALL org scopes, or null when none exists OR more than one does.
 *
 * The RuntimePackageLoader boot pass loads extensions PLATFORM-GLOBALLY
 * (one process, no per-org boot context) — so an org-scoped hot install must
 * still be picked up at the next boot. The exact-org `pickSingleActiveRow` (with
 * a fixed `orgId=null`) would NOT match an `organization`-owned row, dropping it
 * from in-process capabilities after a restart. This picker is org-agnostic so a
 * platform-global boot resolves the row regardless of its owner scope, then reads
 * the grant/journal for THAT row's actual org. Still FAILS CLOSED on ambiguity
 * (>1 live row across orgs) — the trust gate must resolve exactly one row.
 */
export function pickSingleLiveRowAcrossOrgs<
  T extends { status: string; organizationId: string | null; isDefault?: boolean },
>(rows: readonly T[]): T | null {
  const matching = rows.filter((r) => r.status === "active" || r.status === "locked");
  // Same exact-one-default rule as pickSingleActiveRow (cinatra#1040 S3): a
  // non-default side-by-side version row must not un-anchor (or replace) the
  // default at boot; zero live defaults stays fail-closed.
  const defaults = matching.filter((r) => r.isDefault !== false);
  return defaults.length === 1 ? defaults[0] : null;
}

/**
 * Resolve the trusted anchor for a package, or null when it has no active
 * real-pipeline install record.
 *
 * Capability split: `trustDecision` (the persisted host trust
 * decision consumed by `classifyExtensionTrust` as the import-trust factor) is
 * DECOUPLED from the host-port grant's approval status. An active, finalized,
 * real-pipeline install record IS the affirmative persisted decision — that is
 * what the installer flow recorded — so a resolved anchor sets
 * `trustDecision: true`. Revocation/uninstall is expressed by the install row
 * leaving `status === "active"` (→ this resolver returns `null` → fail closed),
 * NOT by tying `trustDecision` to the port grant. `approvedPorts` remains the
 * SEPARATE grant subset: empty unless the grant is `approved`, so an unsigned
 * marketplace bootstrap install (whose grant the pipeline deliberately leaves
 * `pending` per the capability split) still imports in-process with ZERO ports,
 * instead of being wrongly refused as "no persisted host trust decision".
 */
export async function resolveInstallAnchor(
  packageName: string,
  deps: ResolveInstallAnchorDeps,
): Promise<InstallTrustAnchor | null> {
  const row = await deps.readActiveInstall(packageName, deps.orgId ?? null);
  // Accept `active` OR `locked` (locked = removal-protected, still a live install).
  if (!row || (row.status !== "active" && row.status !== "locked") || !row.source || row.source.type !== "verdaccio")
    return null;

  const integrity = row.source.integrity ?? "";
  const contentHash = row.source.contentHash ?? "";
  // Secondary belt-and-suspenders: only real-pipeline installs (recorded content
  // hash + non-placeholder integrity) could ever be trusted anchors. Legacy/
  // dispatcher rows fail closed here.
  if (!contentHash || PLACEHOLDER_INTEGRITY.has(integrity)) return null;

  // PRIMARY trust gate (journal-first): the install-op journal must report a
  // `finalized` phase. Provenance is written LATE by the pipeline (just before
  // the journal is finalized), so a crash mid-install leaves a non-finalized row
  // → refused, even if provenance happened to land. No journal row → refuse.
  const op = await deps.readInstallOp?.(packageName, deps.orgId ?? null);
  if (!op || op.phase !== "finalized") return null;
  // cinatra#158/#792: the anchor digest is the JOURNAL-GATED selection over the
  // row's DB-authoritative `source.activeDigest` and the finalized op's recorded
  // tarball digest (`selectActiveDigest` — the shared selector the boot sweep
  // uses too). A row digest the journal does not confirm FAILS CLOSED (a crash
  // between the provenance write and the journal finalize can never let the row
  // outrank the journal). The selected digest binds the anchor to the on-disk
  // store dir (<kind>/<slug>/<digest>): the loader asserts
  // record.declaredDigest === anchor.digest so an OLD-finalized-op + NEW-source
  // residue (a crash mid durable-restore) fails closed.
  const selection = selectActiveDigest({
    activeDigest: row.source.activeDigest ?? null,
    journalDigest: op.digest ?? null,
  });
  if (!selection.ok) return null;
  const anchorDigest = selection.digest;

  const grant = await deps.readGrant(packageName, deps.orgId ?? null);
  // Reject a fallback grant: an org-scoped install must NOT inherit the global
  // (org_id IS NULL) grant's approved ports — those were never approved for this
  // org. Only a grant whose scope EXACTLY matches the anchor's org counts.
  const grantForScope = grant && (grant.orgId ?? null) === (deps.orgId ?? null) ? grant : null;
  // The port grant is a SEPARATE axis from import-trust (capability split):
  // it governs `approvedPorts` ONLY, never `trustDecision`. A `pending` grant (the
  // bootstrap case) means zero approved ports, not "untrusted to import".
  const portsApproved = grantForScope?.status === "approved";
  return {
    integrity,
    contentHash,
    registryUrl: row.source.registryUrl ?? null,
    // The active + finalized + real-pipeline install record IS the persisted host
    // trust decision. Decoupled from `portsApproved`.
    trustDecision: true,
    approvedPorts: portsApproved ? grantForScope!.approvedPorts : [],
    version: row.source.version ?? null,
    signature: row.source.signature ?? null,
    // cinatra#158/#792: the journal-gated active digest — the loader binds it
    // to the on-disk store dir digest (fail-closed on mismatch).
    digest: anchorDigest,
    // cinatra#792: the canonical row's KIND — the loader binds it to the store
    // record's PATH kind (fail-closed on mismatch). Unbound when the row view
    // omits it (pure unit tests).
    kind: row.kind ?? null,
    // cinatra#181: the recorded closureHash rides the anchor into the boot/
    // activation v2 signature verdict. The recorded SIGNATURE authenticates it:
    // a tampered hash fails v2 verification, and a NULLED hash flips the
    // verdict to closure-less semantics where the recorded v2 signature (which
    // binds the real hash, never `none`) also fails — fail-closed either way.
    closureHash: row.source.closureHash ?? null,
  };
}

/**
 * Resolution scope for the default anchor resolver:
 *  - `"exact-org"` (default): resolve the single live row at the EXACT (package,
 *    org) scope of `orgId`. Used by the install-time hot-activate path, which
 *    binds the row to the install actor's org.
 *  - `"platform-global"`: resolve the single live row for the package ACROSS ALL
 *    orgs, then read the grant/journal for THAT row's derived org. Used by the
 *    RuntimePackageLoader BOOT pass (one process, no per-org boot context)
 *    so an org-scoped hot install is still picked up after a restart — the
 *    platform-global load constraint. Fails closed on >1 live row across orgs.
 */
export type InstallAnchorResolutionScope = "exact-org" | "platform-global";

/**
 * Build the default boot resolver: reads the canonical store + grant store.
 * `(packageName) => Promise<InstallTrustAnchor | null>` — the shape
 * `loadRuntimePackageExtensions({ resolveInstallAnchor })` expects.
 *
 * `scope` (default `"platform-global"` when no `orgId` is given, else
 * `"exact-org"`) selects the row-resolution mode (see
 * `InstallAnchorResolutionScope`). The boot loader calls this with no `orgId` →
 * platform-global, so an org-scoped hot install loads in-process at boot; the
 * install-time hot-activate path passes the install actor's `orgId` →
 * exact-org, so it binds the same row the saga/pipeline finalized.
 */
export async function makeDefaultInstallAnchorResolver(
  orgId: string | null = null,
  scope: InstallAnchorResolutionScope = orgId == null ? "platform-global" : "exact-org",
): Promise<(packageName: string) => Promise<InstallTrustAnchor | null>> {
  const { readInstalledExtensionsByPackageName } = await import("@cinatra-ai/extensions/canonical-store");
  const { readGrant } = await import("@/lib/extension-host-port-grants");
  const { readInstallOp } = await import("@/lib/extension-install-ops");
  return async (packageName: string) => {
    // In platform-global mode the row's org is DERIVED from the single live row
    // across all orgs (then the grant + install-op are read for THAT org). In
    // exact-org mode the org is the fixed `orgId`. Resolve it once per package so
    // the grant/journal reads bind the SAME org as the row.
    let derivedOrgId: string | null = orgId;
    if (scope === "platform-global") {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const live = pickSingleLiveRowAcrossOrgs(rows);
      // Fail closed on 0 / ambiguous: nothing to anchor (or an ambiguous
      // multi-org install) → refuse rather than trust an arbitrary owner's row.
      if (!live) return null;
      derivedOrgId = live.organizationId ?? null;
    }
    return resolveInstallAnchor(packageName, {
      orgId: derivedOrgId,
      readActiveInstall: async (pkg, oid) => {
        const rows = await readInstalledExtensionsByPackageName(pkg);
        // Resolve the SINGLE active row for this exact (package, org) scope — fail
        // closed on 0 or >1 (ambiguous owner scope) so the trust gate never
        // resolves one owner's source against another's journal/grant. In
        // platform-global mode `oid` is the DERIVED org of the single live row, so
        // this still resolves exactly that one row.
        const active = pickSingleActiveRow(rows, oid);
        return active
          ? { status: active.status, kind: active.kind, source: active.source as InstallAnchorRow["source"] }
          : null;
      },
      readGrant: async (pkg, oid) => {
        const g = await readGrant({ packageName: pkg, orgId: oid });
        // Carry the grant's actual org so resolveInstallAnchor can reject a
        // global-fallback grant for an org-scoped install.
        return g ? { status: g.status, approvedPorts: g.approvedPorts, orgId: g.orgId } : null;
      },
      readInstallOp: (pkg, oid) => readInstallOp(pkg, oid),
    });
  };
}
