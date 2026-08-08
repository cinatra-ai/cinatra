import "server-only";

import type { ExtensionKind } from "@cinatra-ai/extensions/canonical-types";

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
  /**
   * The canonical row's id (cinatra#1392 S8) — surfaced on the resolved anchor
   * (`installId`) so the loader can thread the EXACT install identity into the
   * host ctx's edge-bound consume seams. Optional so pure unit tests / legacy
   * row views omit it (identity-less semantics).
   */
  id?: string;
  status: string;
  /**
   * The canonical row's `is_default` (cinatra#1040 S4) — surfaced on the resolved
   * anchor so the loader elects the DEFAULT version to own the package's
   * unversioned global names and activates non-default siblings side-by-side
   * against a side-effect-free host context. Optional so pure unit tests /
   * legacy rows omit it (treated as default — the pre-S4 single-version behavior).
   */
  isDefault?: boolean;
  /**
   * The canonical row's extension KIND (cinatra#792) — surfaced on the resolved
   * anchor so the loader can bind it to the store record's PATH kind
   * (`<root>/<kind>/<slug>/<digest>`), fail-closed on a mismatch. Optional so
   * pure unit tests can omit it (treated as unbound — no kind assertion).
   */
  kind?: string;
  /**
   * The canonical row's `organization_id` (owner ruling 2026-07-23) — surfaced on
   * the resolved anchor (`orgId`) so the marketplace-install-provenance arm can
   * veto a non-approved ownership grant at the install's ACTUAL org. Optional
   * (pure unit fixtures omit it → the resolver falls back to `deps.orgId`).
   */
  organizationId?: string | null;
  /**
   * The canonical row's `widget_auth_token_keys` (owner ruling 2026-07-23) — the
   * tamper-proof declaration surfaced on the anchor for arm (c)'s P5. Optional
   * (legacy row / unit fixtures omit it → null → arm (c) fails closed).
   */
  widgetAuthTokenKeys?: string[] | null;
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
    // cinatra#1392 S8: the exact canonical row id (absent on legacy row views).
    installId: row.id ?? null,
    integrity,
    contentHash,
    registryUrl: row.source.registryUrl ?? null,
    // The active + finalized + real-pipeline install record IS the persisted host
    // trust decision. Decoupled from `portsApproved`.
    trustDecision: true,
    approvedPorts: portsApproved ? grantForScope!.approvedPorts : [],
    version: row.source.version ?? null,
    // cinatra#1040 S4: the canonical row's default flag rides the anchor so the
    // loader elects the default version for global-name ownership. Absent = default.
    isDefault: row.isDefault !== false,
    signature: row.source.signature ?? null,
    // cinatra#158/#792: the journal-gated active digest — the loader binds it
    // to the on-disk store dir digest (fail-closed on mismatch).
    digest: anchorDigest,
    // cinatra#792: the canonical row's KIND — the loader binds it to the store
    // record's PATH kind (fail-closed on mismatch). Unbound when the row view
    // omits it (pure unit tests).
    kind: row.kind ?? null,
    // Owner ruling 2026-07-23: the DERIVED org scope this anchor resolved (the
    // row's org, or the resolution scope `deps.orgId` when the row view omits
    // it) — arm (c) vetoes a non-approved ownership grant at this org AND global.
    orgId: row.organizationId ?? deps.orgId ?? null,
    // Owner ruling 2026-07-23: the canonical row's RECORDED widget-auth declared
    // token keys (tamper-proof P5 source for arm (c)). null on a legacy row.
    widgetAuthTokenKeys: row.widgetAuthTokenKeys ?? null,
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
          ? {
              id: active.id,
              status: active.status,
              kind: active.kind,
              // Owner ruling 2026-07-23: surface the row's org + recorded
              // widget-auth token keys so the anchor carries the veto org + the
              // tamper-proof P5 declaration.
              organizationId: active.organizationId ?? null,
              widgetAuthTokenKeys: active.widgetAuthTokenKeys ?? null,
              source: active.source as InstallAnchorRow["source"],
            }
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

/**
 * MULTI-VERSION anchor resolver (cinatra#1040 S4) — the side-by-side counterpart
 * of `makeDefaultInstallAnchorResolver`. Returns `(packageName) =>
 * Promise<InstallTrustAnchor[]>`: ONE anchor per LIVE version row (the default +
 * any non-default siblings), each carrying its OWN version/digest/approvedPorts/
 * isDefault. Boot + re-election wire THIS resolver so side-by-side versions
 * activate together; the singular `makeDefaultInstallAnchorResolver` stays for
 * legacy/pre-verify callers that need exactly the default.
 *
 * It REUSES the per-row trust gate `resolveInstallAnchor` UNCHANGED (journal-
 * finalized, integrity, digest selection, grant scope) — invoked once per
 * version with a per-version `readActiveInstall` (the specific row) and a
 * version-scoped journal read (`readInstallOpForVersion`). The authoritative org
 * is derived EXACTLY as the single-anchor path (the one live default across orgs
 * for a platform-global boot; the fixed org for exact-org), so multi-org
 * side-by-side never fans out here. Per-version cross-owner ambiguity (two owner
 * rows for one version in the derived org) fails closed for THAT version; two
 * resolved defaults fail closed for the whole package.
 */
export async function makeDefaultInstallAnchorsResolver(
  orgId: string | null = null,
  scope: InstallAnchorResolutionScope = orgId == null ? "platform-global" : "exact-org",
): Promise<(packageName: string) => Promise<InstallTrustAnchor[]>> {
  const { readInstalledExtensionsByPackageName } = await import("@cinatra-ai/extensions/canonical-store");
  const { readGrant } = await import("@/lib/extension-host-port-grants");
  const { readInstallOpForVersion } = await import("@/lib/extension-install-ops");
  return async (packageName: string) => {
    const rows = await readInstalledExtensionsByPackageName(packageName);
    // Derive the authoritative org exactly as the single-anchor path.
    let derivedOrgId: string | null = orgId;
    if (scope === "platform-global") {
      const live = pickSingleLiveRowAcrossOrgs(rows);
      if (!live) return [];
      derivedOrgId = live.organizationId ?? null;
    }
    // Live version rows for THAT org: the default + any non-default siblings.
    const orgRows = rows.filter(
      (r) => (r.status === "active" || r.status === "locked") && (r.organizationId ?? null) === derivedOrgId,
    );
    // Group by version so a per-version cross-owner ambiguity fails closed for
    // that version alone (never resolving one owner's source against another's).
    const byVersion = new Map<string, typeof orgRows>();
    for (const r of orgRows) {
      // `version` is NOT NULL in the DB (the S1 backfill floors legacy rows to
      // "0.0.0"); coerce defensively so the grouping key is always a string.
      const v = r.version ?? "0.0.0";
      const bucket = byVersion.get(v);
      if (bucket) bucket.push(r);
      else byVersion.set(v, [r]);
    }
    const anchors: InstallTrustAnchor[] = [];
    for (const [version, verRows] of byVersion) {
      if (verRows.length !== 1) {
        console.warn(
          `[extension-install-anchor] refusing ambiguous version ${packageName}@${version}: ` +
            `${verRows.length} live owner rows in org ${derivedOrgId ?? "(null)"} — skipping (fail-closed)`,
        );
        continue;
      }
      const versionRow = verRows[0];
      // Which journal NAMESPACE holds THIS row's finalized install-op? The two
      // install paths journal differently:
      //   - the DEFAULT install (the general pipeline's `beginInstallOp`) passes
      //     NO version, so its op lands in the '0.0.0' DEFAULT namespace (the
      //     journal column's default) — even though the canonical DEFAULT row
      //     carries the REAL resolved semver in `row.version` (e.g. 0.1.6);
      //   - a NON-DEFAULT side-by-side sibling journals at its OWN real version
      //     (the side-by-side installer passes the pin).
      // So the read is namespace-aware: a DEFAULT row reads the '0.0.0' namespace
      // EXACTLY; a non-default sibling reads its own version. Reading a default row
      // version-scoped by its real semver would MISS its '0.0.0' journal →
      // `resolveInstallAnchor` returns null → the stock marketplace default is
      // refused activation on EVERY boot (it only ever hot-activated at install
      // time, via the versionless singular resolver — the reboot-survival bug).
      //
      // EXACT '0.0.0' read (not the versionless `readInstallOp`): the versionless
      // reader only PREFERS '0.0.0' and falls back to any finalized op, so a
      // default row whose own '0.0.0' op is absent could borrow a non-default
      // sibling's finalized op — and `selectActiveDigest` does not catch it when
      // the row records no `activeDigest`. The exact read binds the default to its
      // own namespace and fails closed otherwise.
      //
      // `isDefault` is the journal-lineage key, valid under the current invariant:
      // the default lineage journals at '0.0.0' and NO writer flips `is_default`
      // between an existing default and a sibling (versioned re-election does not
      // re-anchor the journal today). A future promotion that flips `is_default`
      // must re-anchor the new default's journal (or thread persisted lineage
      // identity); the exact '0.0.0' read keeps that case fail-closed meanwhile.
      const isDefaultRow = versionRow.isDefault !== false;
      const anchor = await resolveInstallAnchor(packageName, {
        orgId: derivedOrgId,
        readActiveInstall: async () => ({
          id: versionRow.id,
          status: versionRow.status,
          kind: versionRow.kind,
          isDefault: versionRow.isDefault,
          organizationId: versionRow.organizationId ?? null,
          widgetAuthTokenKeys: versionRow.widgetAuthTokenKeys ?? null,
          source: versionRow.source as InstallAnchorRow["source"],
        }),
        readGrant: async (pkg, oid) => {
          const g = await readGrant({ packageName: pkg, orgId: oid });
          return g ? { status: g.status, approvedPorts: g.approvedPorts, orgId: g.orgId } : null;
        },
        readInstallOp: (pkg, oid) =>
          isDefaultRow ? readInstallOpForVersion(pkg, oid, "0.0.0") : readInstallOpForVersion(pkg, oid, version),
      });
      if (anchor) anchors.push(anchor);
    }
    // Defense in depth: the DB enforces at most one default per (org, owner,
    // package); if two versions resolved as default here, the package identity is
    // ambiguous — refuse ALL rather than let two versions own the global names.
    const defaults = anchors.filter((a) => a.isDefault !== false);
    if (defaults.length > 1) {
      console.warn(
        `[extension-install-anchor] refusing ${packageName}: ${defaults.length} live DEFAULT versions ` +
          `resolved — fail-closed (no version activated)`,
      );
      return [];
    }
    return anchors;
  };
}

// ===========================================================================
// INSTALL-RECORD HEAL (cinatra#2536)
//
// Hosted in THIS module deliberately: it is the same subject — the canonical
// `installed_extension` record an anchor is resolved from — and the route-graph
// ratchet (scripts/audit/route-graph-ratchet.mjs) locks the reachable
// first-party module count of five routes, so a NEW file referenced from the
// boot importer / dev scan / materializer seam would grow every one of them.
// Keeping the repair beside the resolver that consumes its output costs zero
// graph pressure and keeps one module answering "what is this package's
// canonical install record, and can it anchor?".
// ===========================================================================

// ---------------------------------------------------------------------------
// INSTALL-RECORD HEAL (cinatra#2536).
//
// THE DEFECT. Every boot importer treats a matching `packageVersion` (or
// manifest hash) as proof that the package is fully installed, and SKIPS
// re-import: `… skipped — already up to date (bump packageVersion to force
// re-import)`. But the version signal lives on a DIFFERENT row than the install
// record — `agent_templates` / the on-disk tree vs `installed_extension` — so a
// reset/reinstall (or a producer whose artifact was never pulled into the
// install closure, cinatra#2537) can leave the version signal intact while the
// canonical `installed_extension` row is ABSENT. The package then LOADS and is
// selectable/runnable, yet it is not install-active, so:
//
//   1. nothing marks it install-active → the boot claim-activation backstop
//      (`runInstallAnchorClaimBackstop`) skips it → `artifact_type_claims`
//      never seeds;
//   2. `readEffectiveArtifactSafeTypeIdsForExtension` returns []; and
//   3. the materializer fails EVERY run with a MANIFEST-BLAMING error
//      (`declares no artifact-safe object type`) although the manifest is
//      correct and the type IS registered.
//
// It does not self-heal: the next boot re-hits the same skip.
//
// THE RULE THIS MODULE ENFORCES: "already up to date" REQUIRES a LIVE
// (`active`|`locked`) canonical install record. An ABSENT record at a matching
// version is a broken install, not a healthy one — it triggers this repair.
//
// WHAT THE REPAIR MAY AND MAY NOT DO:
//   - ABSENT record  → seed ONE platform-scoped `local`-source row through the
//     canonical lifecycle primitive (`installExtensionManifest` — never raw
//     SQL), so the manifest stays the single write authority.
//   - INACTIVE record (`archived`) → REFUSED. An archived row is an operator's
//     deliberate uninstall/archive decision and is authoritative lifecycle
//     memory; resurrecting it here would be the exact anti-pattern the
//     static-bundle anchor seeder is careful to avoid. The caller keeps
//     skipping (no per-boot re-import loop) and the condition is SURFACED.
//   - LIVE ONLY IN SPECIFIC ORGS (no platform anchor) → REFUSED. The package is
//     installed, just not instance-wide; seeding the ambient anchor would hand
//     every other org an install nobody granted them. The repair RESTORES a
//     missing record, it never broadens one.
//   - A LIVE ROW THAT CANNOT ANCHOR (governs another KIND, or no live row in
//     scope is the DEFAULT) → REFUSED and SURFACED. The identity slot is taken
//     so nothing can be seeded, and the claim backstop cannot use such a row —
//     calling it healthy would restore the very silence this module ends.
//   - UNREADABLE canonical store → REFUSED (fail closed): an unreadable store
//     cannot PROVE the record is absent, and seeding on a transient read error
//     could duplicate a live row.
//
// SCOPE IS NOT OPTIONAL. "Some live row exists" is not "install-active here" —
// the write/claim chain this failure runs through (`isArtifactExtensionWrite-
// Allowed`, and the claim read whose org chain is `platform` + `org:<id>`)
// admits an org's OWN live row, else an AMBIENT platform one, never another
// org's. The repair therefore reasons about the PLATFORM anchor and the
// diagnostics reason about the FAILING ORG's chain (codex round 1).
//
// IDENTITY IS PROVEN, NOT ASSERTED: a row is only ever seeded for a package
// whose on-disk manifest at `packageDir` actually declares that
// `name` (and, when it declares a `cinatra.kind`, that kind). A caller that
// cannot point at a readable manifest gets `refused-unverified` — the heal
// never mints a row for a package it cannot see.
//
// CONVERGENT + IDEMPOTENT BY CONSTRUCTION: the repair writes the very row the
// probe requires, so the NEXT call short-circuits at `already-live` with no
// write at all. One repair per broken package, once — never a re-import loop
// (the same self-limiting shape as the cinatra#2044 lifecycle-config drift
// check in `ensureAgentPackageFromGitFile`).
//
// Kill-switchable via `CINATRA_DISABLE_INSTALL_RECORD_HEAL=true`.
// ---------------------------------------------------------------------------


/** Live install statuses. Mirrors the install anchor + the access gates. */
const LIVE_STATUSES = new Set(["active", "locked"]);

export type InstallRecordProbe =
  /**
   * A live (`active|locked`) row GOVERNS the queried scope — the package is
   * install-active there. `scope:"platform"` is the ambient anchor every org's
   * resolution chain sees; `scope:"organization"` is that org's own install.
   */
  | {
      state: "live";
      rowId: string;
      status: string;
      scope: "platform" | "organization";
      organizationId: string | null;
      /** The anchor row's recorded version (the claim fence compares it). */
      version: string | null;
    }
  /**
   * Live rows exist but NONE governs the queried scope — the package is
   * installed only in OTHER organizations (and there is no platform anchor).
   * Distinct from `absent` because the repair must NOT silently broaden one
   * org's install into an instance-wide one.
   */
  | { state: "live-elsewhere"; organizationIds: string[] }
  /**
   * A live row governs the scope but is NOT a usable anchor: it governs a
   * different KIND, or no live row in the scope is the DEFAULT. Both make the
   * claim-activation backstop skip the package (`pickSingleActiveRow` + its
   * `row.kind !== "artifact"` gate), so reporting "healthy" here would restore
   * exactly the silent failure this issue is about — and the identity slot is
   * taken, so the repair cannot seed over it either.
   */
  | { state: "mismatched"; rowId: string; reason: string }
  /** Rows exist, none live (an archived tombstone / deliberate uninstall). */
  | { state: "inactive"; rowId: string; status: string }
  /** No `installed_extension` row at all — the cinatra#2536 state. */
  | { state: "absent" }
  /** The canonical store could not be read — callers FAIL CLOSED on this. */
  | { state: "unreadable"; reason: string };

export type CanonicalRowView = {
  id: string;
  status: string;
  organizationId: string | null;
  /** The kind the row GOVERNS (`installed_extension.kind`). */
  kind: string | null;
  /** Is this the DEFAULT row for the identity? Side-by-side versions mean a
   *  package can hold several live rows; only the default owns the package's
   *  unversioned identity, and only it is anchor-eligible. */
  isDefault: boolean;
  /**
   * The row's LIVE provenance version. Updates rewrite `source.version` on the
   * SAME canonical row while the `version` COLUMN can lag, so the claim
   * backstop's stale-record fence reads `source.version` first and falls back
   * to the column — this mirrors that precedence exactly
   * (artifact-claim-install-anchor.ts). Reading the column alone would make the
   * heal think a freshly-updated install is a different version and go quiet.
   */
  version: string | null;
};

export type InstallRecordHealDeps = {
  /** Canonical rows for a package. Default: the canonical store. */
  readRows?: (packageName: string) => Promise<CanonicalRowView[]>;
  /** Create the healed row. Default: the canonical lifecycle primitive. */
  installRow?: (input: {
    id: string;
    packageName: string;
    kind: ExtensionKind;
    version: string;
    sourcePath: string;
  }) => Promise<void>;
  /** Read an on-disk `package.json`. Default: `node:fs/promises`. */
  readManifest?: (packageDir: string) => Promise<string>;
};

/**
 * The DEFAULT canonical-row read this module uses. Exported so a test can wrap
 * the REAL read (e.g. with a barrier that forces two boot passes to race the
 * identity index) without re-implementing its projection.
 */
export async function readInstallRecordRows(packageName: string): Promise<CanonicalRowView[]> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const rows = await readInstalledExtensionsByPackageName(packageName);
  return rows.map((r) => {
    // `source.version` FIRST, the column as fallback — the same precedence the
    // claim backstop's fence uses (see `CanonicalRowView.version`).
    const sourceVersion =
      r.source && typeof (r.source as { version?: unknown }).version === "string"
        ? (r.source as { version: string }).version
        : null;
    return {
      id: r.id,
      status: r.status,
      organizationId: r.organizationId ?? null,
      kind: r.kind ?? null,
      // A row read from the DB always carries `is_default` (NOT NULL DEFAULT
      // true); the `?? true` only covers hand-built fixtures, matching how every
      // other reader treats an unset value.
      isDefault: r.isDefault ?? true,
      version: sourceVersion ?? r.version ?? null,
    };
  });
}

async function defaultReadManifest(packageDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(packageDir, "package.json"), "utf8");
}

/**
 * Probe the canonical install record for a package, AT A SCOPE.
 *
 * SCOPE MATTERS and a scope-blind probe is wrong in both directions (codex
 * round 1, High). "Some live row exists" is NOT "this package is install-active
 * here": the write/claim chain this failure runs through
 * (`isArtifactExtensionWriteAllowed` and the org-chain claim read, which sees
 * `platform` plus `org:<id>`) admits the org's OWN live row, else an AMBIENT
 * platform one — never another org's. So:
 *
 *   - `opts.orgId` GIVEN (the diagnostics view): governed by this org's own
 *     live row, else a live platform row. Live rows belonging only to OTHER
 *     orgs report `live-elsewhere`, so an unserved org is never told "it is
 *     installed, just restart".
 *   - `opts.orgId` OMITTED (the REPAIR's anchor view): only a live PLATFORM row
 *     counts. The repair seeds the ambient anchor, so an org-scoped install
 *     must not suppress it — but it must not be silently broadened into one
 *     either (see the heal's `refused-org-scoped`).
 *
 * IDENTITY MATTERS TOO (codex round 2, High). A live row is only an ANCHOR when
 * it governs the expected KIND and is the DEFAULT row: the claim-activation
 * backstop picks `pickSingleActiveRow` (default, unambiguous) and drops
 * anything whose `kind` is not `artifact`. A row failing either test would be
 * reported "healthy" while claims never seed — the exact silent failure this
 * module exists to end — so it reports `mismatched` instead.
 *
 * NEVER throws: a store read failure resolves to `unreadable` so every caller
 * can make its own fail-closed decision instead of crashing a boot importer.
 */
export async function probeInstallRecord(
  packageName: string,
  deps: InstallRecordHealDeps = {},
  opts: { orgId?: string | null; expectKind?: ExtensionKind } = {},
): Promise<InstallRecordProbe> {
  const readRows = deps.readRows ?? readInstallRecordRows;
  let rows: CanonicalRowView[];
  try {
    rows = await readRows(packageName);
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (rows.length === 0) return { state: "absent" };

  const live = rows.filter((r) => LIVE_STATUSES.has(r.status));
  const orgId = opts.orgId ?? null;
  // The org's OWN live rows win over the ambient anchor (same precedence as the
  // write/claim chain); the anchor view (no orgId) considers platform rows only.
  const ownLive = orgId === null ? [] : live.filter((r) => r.organizationId === orgId);
  const platformLive = live.filter((r) => r.organizationId === null);
  const inScope = ownLive.length > 0 ? ownLive : platformLive;
  if (inScope.length > 0) {
    // Anchor eligibility: EXACTLY ONE default row in the scope, governing the
    // expected kind. `pickSingleActiveRow` — the row pick the claim backstop
    // actually performs — fails closed on ambiguity, so accepting the first of
    // several defaults here would again report "healthy" for a package whose
    // claims can never activate.
    const anchors = inScope.filter(
      (r) => r.isDefault && (opts.expectKind === undefined || r.kind === opts.expectKind),
    );
    if (anchors.length === 1) {
      const anchor = anchors[0]!;
      return {
        state: "live",
        rowId: anchor.id,
        status: anchor.status,
        scope: anchor.organizationId === null ? "platform" : "organization",
        organizationId: anchor.organizationId,
        version: anchor.version,
      };
    }
    const shown = (anchors[0] ?? inScope[0])!;
    const kinds = [...new Set(inScope.map((r) => r.kind ?? "null"))].join(", ");
    return {
      state: "mismatched",
      rowId: shown.id,
      reason:
        anchors.length > 1
          ? `${anchors.length} live DEFAULT installed_extension rows share this scope — the ` +
            `claim-activation backstop resolves a single default row and fails closed on ambiguity, ` +
            `so no claim can activate; reconcile the duplicate install rows`
          : opts.expectKind !== undefined && !inScope.some((r) => r.kind === opts.expectKind)
            ? `a live installed_extension row exists but governs kind [${kinds}], not "${opts.expectKind}" — ` +
              `the claim-activation backstop drops it, so its artifact type claims can never seed; ` +
              `reinstall the package so its canonical row governs the right kind`
            : `a live installed_extension row exists but NONE is the default row for its identity ` +
              `(side-by-side versions) — the claim-activation backstop resolves only the default row; ` +
              `promote/reinstall the intended version`,
    };
  }
  // Nothing governs this scope. An ARCHIVE anywhere is checked BEFORE the
  // other-org case: it is a deliberate lifecycle decision and outranks a
  // broadening repair (see `refused-archived`).
  const inactive = rows.find((r) => !LIVE_STATUSES.has(r.status));
  if (inactive) return { state: "inactive", rowId: inactive.id, status: inactive.status };
  return {
    state: "live-elsewhere",
    organizationIds: [...new Set(live.map((r) => r.organizationId).filter((o): o is string => o !== null))],
  };
}

export type InstallRecordHealOutcome =
  /** A live row already existed — NO write (the idempotent re-fire). */
  | "already-live"
  /** A live row was created for a package that had none. */
  | "repaired"
  /** A non-live row exists — an operator decision, never resurrected. */
  | "refused-archived"
  /** Live only in specific organizations — never silently broadened. */
  | "refused-org-scoped"
  /** A live row occupies the identity slot but cannot anchor (kind/default). */
  | "refused-mismatched-row"
  /** The on-disk manifest could not prove this package's identity. */
  | "refused-unverified"
  /** The canonical store could not be read (fail closed). */
  | "refused-unreadable"
  /** `CINATRA_DISABLE_INSTALL_RECORD_HEAL=true`. */
  | "refused-disabled"
  /** The repair write itself failed. */
  | "failed";

export type InstallRecordHealResult = {
  outcome: InstallRecordHealOutcome;
  /** The live row's id — set for `already-live` and `repaired`. */
  rowId?: string;
  /** The live row's recorded VERSION — set for `already-live` and `repaired`. */
  rowVersion?: string | null;
  /** Human-readable detail for every non-healthy outcome. */
  reason?: string;
};

/** Is the package install-active after this heal? */
export function healLeftRecordLive(result: InstallRecordHealResult): boolean {
  return result.outcome === "already-live" || result.outcome === "repaired";
}

/**
 * Repair an ABSENT canonical install record for a package that is loaded from
 * an on-disk (in-tree / bundled) package dir. See the module header for the
 * absent/inactive/unreadable policy. Idempotent; never throws.
 */
export async function healMissingInstallRecord(
  input: {
    packageName: string;
    kind: ExtensionKind;
    /** The on-disk package dir — the manifest there PROVES the identity. */
    packageDir?: string;
    /** The manifest version, recorded on the healed row. */
    version?: string;
  },
  deps: InstallRecordHealDeps = {},
): Promise<InstallRecordHealResult> {
  if ((process.env.CINATRA_DISABLE_INSTALL_RECORD_HEAL ?? "").trim() === "true") {
    return { outcome: "refused-disabled", reason: "CINATRA_DISABLE_INSTALL_RECORD_HEAL=true" };
  }

  // ANCHOR VIEW (no orgId): the repair owns the ambient PLATFORM anchor, so
  // only a live platform row that can actually ANCHOR (default row, expected
  // kind) makes it a no-op.
  const probe = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
  if (probe.state === "live") {
    return { outcome: "already-live", rowId: probe.rowId, rowVersion: probe.version };
  }
  if (probe.state === "unreadable") {
    return { outcome: "refused-unreadable", reason: probe.reason };
  }
  if (probe.state === "mismatched") {
    // The identity slot is occupied by a live row the claim backstop cannot
    // use. Seeding is impossible (unique identity) and reporting "healthy"
    // would hide the failure — surface it instead.
    return { outcome: "refused-mismatched-row", rowId: probe.rowId, reason: probe.reason };
  }
  if (probe.state === "inactive") {
    // A non-live row is authoritative lifecycle memory (an operator's
    // uninstall/archive) at SOME scope. Never resurrected here — restore is an
    // explicit, audited lifecycle op, not a boot-time side effect. Seeding an
    // ambient platform anchor would be worse than a status flip: the access
    // gates fall back to an ambient live row when an org's own row is archived,
    // so it would resurrect that org's uninstall THROUGH the anchor.
    return {
      outcome: "refused-archived",
      rowId: probe.rowId,
      reason: `installed_extension row is '${probe.status}' — a deliberate archive/uninstall is never resurrected by the boot repair; restore the extension to make it install-active`,
    };
  }
  if (probe.state === "live-elsewhere") {
    // The package IS installed — just not instance-wide. Seeding a platform
    // anchor here would hand every other org an install nobody granted them,
    // which is a governance decision the boot repair has no business making.
    // The repair only ever RESTORES a package that has no rows at all.
    return {
      outcome: "refused-org-scoped",
      reason:
        `installed_extension rows exist and are live only for organization(s) ` +
        `[${probe.organizationIds.join(", ")}] — the boot repair restores a MISSING install record, it never ` +
        `broadens an organization's install into an instance-wide one; install the extension for the ` +
        `affected organization`,
    };
  }

  // ABSENT — prove the identity off the on-disk manifest before minting a row.
  if (!input.packageDir) {
    return {
      outcome: "refused-unverified",
      reason: "no on-disk package dir was supplied — the repair never mints a row for a package it cannot read",
    };
  }
  const readManifest = deps.readManifest ?? defaultReadManifest;
  let manifest: { name?: unknown; version?: unknown; cinatra?: { kind?: unknown } };
  try {
    manifest = JSON.parse(await readManifest(input.packageDir));
  } catch (err) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} is unreadable/invalid (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (manifest?.name !== input.packageName) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} declares name ${JSON.stringify(manifest?.name ?? null)}, not "${input.packageName}"`,
    };
  }
  const declaredKind = manifest?.cinatra?.kind;
  if (typeof declaredKind === "string" && declaredKind !== input.kind) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} declares cinatra.kind "${declaredKind}", not "${input.kind}"`,
    };
  }

  const version =
    input.version ?? (typeof manifest.version === "string" ? manifest.version : undefined) ?? "0.0.0";

  const installRow = deps.installRow ?? defaultInstallRow;
  const { randomUUID } = await import("node:crypto");
  try {
    await installRow({
      id: `iext_${randomUUID().slice(0, 12)}`,
      packageName: input.packageName,
      kind: input.kind,
      version,
      sourcePath: input.packageDir,
    });
  } catch (err) {
    // A concurrent boot/worker may have inserted the row between our probe and
    // this write (the identity slot is unique). Re-probe before reporting a
    // failure — a race that ends with a live ANCHOR row is a SUCCESS. The
    // re-probe carries the SAME `expectKind` as the first one: a race winner
    // that governs another kind (or leaves the scope ambiguous) is not a
    // healthy outcome just because it won.
    const after = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
    if (after.state === "live") {
      return { outcome: "already-live", rowId: after.rowId, rowVersion: after.version };
    }
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const after = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
  if (after.state === "live") {
    return { outcome: "repaired", rowId: after.rowId, rowVersion: after.version };
  }
  return {
    outcome: "failed",
    reason: `the repair write reported success but no live installed_extension row is readable for ${input.packageName}`,
  };
}

async function defaultInstallRow(input: {
  id: string;
  packageName: string;
  kind: ExtensionKind;
  version: string;
  sourcePath: string;
}): Promise<void> {
  const { installExtensionManifest } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  const { isPackageRequiredInProd } = await import("@cinatra-ai/extensions/required-in-prod");
  await installExtensionManifest(
    {
      id: input.id,
      packageName: input.packageName,
      // PLATFORM scope: the package is present on the instance's own disk, not
      // acquired by one org. This mirrors the static-bundle anchor's scope, so
      // the row is visible to every org's resolution chain (an org-scoped heal
      // would silently exclude every other org).
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
      kind: input.kind,
      source: {
        type: "local",
        path: input.sourcePath,
        // Local sources carry no registry identity; the in-tree materialization
        // IS the payload, so the version identifies it.
        resolvedCommitOrTreeHash: `in-tree@${input.version}`,
      },
      // Passed EXPLICITLY (the store would otherwise floor a `local` source to
      // `0.0.0`): the claim-activation backstop's stale-record fence compares
      // this against the store manifest's own version, and a floored row would
      // make the fence skip every activation.
      version: input.version,
      requiredInProd: isPackageRequiredInProd(input.packageName),
      // SEED ONLY, exactly like the dispatcher's placeholder row: the manifest's
      // real edges are recorded by the materializing install path. Seeding
      // declared edges here would let a heal row carry an install-blocking edge
      // to a package that is NOT installed, which the prod extension-closure
      // boot gate fails CLOSED on — a repair must never be able to brick a boot.
      dependencies: [],
      manifestHash: null,
    },
    {
      actor: { source: "install-record-heal" },
      reason: "cinatra#2536 boot repair — loaded package had no canonical install record",
    },
  );
}

// ---------------------------------------------------------------------------
// Artifact packages: record + CLAIMS.
// ---------------------------------------------------------------------------

export type ArtifactHealResult = {
  record: InstallRecordHealResult;
  /**
   * What the claim-activation pass did.
   *   `converged`      — at least one scope activated or matched (healthy);
   *   `failed`         — the hook reported a lifecycle failure;
   *   `skipped`        — it ran (or could not run) and converged NOTHING; the
   *                      claims still do not exist → a SURFACED condition;
   *   `not-applicable` — the live record describes a DIFFERENT version than
   *                      this on-disk dir, so this dir is not its claim source
   *                      (the store-based boot backstop owns it). Not a problem.
   */
  claims: "converged" | "failed" | "skipped" | "not-applicable";
  detail?: string;
};

/**
 * The FULL instance-level heal for a loaded `kind:"artifact"` package: repair
 * the canonical install record, then converge `artifact_type_claims`.
 *
 * The claim half REUSES `runInstallAnchorClaimBackstop` — the same idempotent
 * hook the install anchor and the boot bridge rescan fire (diff-first: a
 * healthy install no-ops on a live-claims match, a drifted one routes through
 * retire+replay). No second activation path is introduced. The object-type
 * registry is warmed first so the fail-closed per-claim activation gate can
 * resolve each claimed type's validator.
 *
 * Never throws — a heal failure must never break a boot scan or a hot reload.
 */
export async function healArtifactInstallRecordAndClaims(
  input: { packageName: string; packageDir: string; version?: string },
  deps: InstallRecordHealDeps = {},
): Promise<ArtifactHealResult> {
  const record = await healMissingInstallRecord(
    { packageName: input.packageName, kind: "artifact", packageDir: input.packageDir, version: input.version },
    deps,
  );
  if (!healLeftRecordLive(record)) {
    return { record, claims: "skipped", detail: record.reason };
  }
  // A PRE-EXISTING install at a DIFFERENT version is not this dir's business:
  // the claim backstop's stale-record fence compares the row's version against
  // the manifest it is handed, so activating from an in-tree dir that describes
  // another version would (correctly) be refused. Report it as not-applicable
  // rather than as a failure, so a dev tree that runs ahead of the installed
  // version does not warn on every boot (codex round 2).
  if (
    record.outcome === "already-live" &&
    input.version !== undefined &&
    record.rowVersion != null &&
    record.rowVersion !== input.version
  ) {
    return {
      record,
      claims: "not-applicable",
      detail:
        `the live installed_extension row records version ${record.rowVersion}, not the ${input.version} ` +
        `materialized at ${input.packageDir} — its claims are owned by that version's store record`,
    };
  }
  try {
    const { ensureArtifactTypesRegistered } = await import("@/lib/artifacts/ensure-artifact-registry");
    ensureArtifactTypesRegistered();
    const { runInstallAnchorClaimBackstop } = await import(
      "@/lib/objects/artifact-claim-install-anchor"
    );
    const backstop = await runInstallAnchorClaimBackstop([
      { packageName: input.packageName, storeDir: input.packageDir },
    ]);
    const tally = `converged=${backstop.converged} failed=${backstop.failed} skipped=${backstop.skipped}`;
    // A backstop that converged NOTHING is not a success (codex round 2): it
    // skips a row whose recorded version no longer matches the vetted store
    // manifest (its stale-record fence), an unreadable manifest, and a
    // non-default/foreign-kind row. Reporting "converged" there would restore
    // the silent failure — the claims still do not exist.
    if (backstop.failed > 0) return { record, claims: "failed", detail: tally };
    if (backstop.converged === 0) {
      return {
        record,
        claims: "skipped",
        detail:
          `${tally} — the claim-activation backstop converged nothing for "${input.packageName}"; ` +
          `its artifact_type_claims remain unseeded (common causes: the canonical row's recorded version ` +
          `does not match the package manifest's version, or the manifest is unreadable at ${input.packageDir})`,
      };
    }
    return { record, claims: "converged", detail: tally };
  } catch (err) {
    return {
      record,
      claims: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// DIAGNOSTICS (cinatra#2536 item 3) — stop blaming a correct manifest.
// ---------------------------------------------------------------------------

/**
 * Explain why an extension has NO effective artifact-safe claim, in terms of
 * the INSTALL state rather than the manifest.
 *
 * The materializer's pure resolver can only see "this extension contributes
 * zero artifact-safe declared types" and historically reported that as
 * `extension "<x>" declares no artifact-safe object type — … declare a
 * produces/binding objectTypeId over an artifact-safe claim`, which sends a
 * developer to edit a manifest that is already correct. The real cause is
 * almost always an incomplete install: no install record, an archived one, or a
 * live record whose claims never activated. Each of those has a DIFFERENT heal,
 * so each gets its own sentence — and every one of them names what is missing
 * and how it heals.
 *
 * Never throws: on any read failure it returns a message that says the install
 * state could not be read (still not manifest-blaming).
 */
export async function explainAbsentArtifactSafeClaims(
  input: {
    orgId: string;
    extension: string;
    /** The type ids the pack manifest declares, when resolvable. */
    declaredObjectTypeIds?: readonly string[];
  },
  deps: InstallRecordHealDeps = {},
): Promise<string> {
  const named =
    input.declaredObjectTypeIds && input.declaredObjectTypeIds.length > 0
      ? input.declaredObjectTypeIds.map((t) => `"${t}"`).join(", ")
      : "its declared object type(s)";
  // Only ASSERT the manifest is fine when we actually read its declarations.
  // When the pack manifest could not be resolved/validated from here it may
  // ALSO be malformed, and claiming otherwise would be its own false lead
  // (codex round 3, Medium).
  const manifestNote =
    input.declaredObjectTypeIds && input.declaredObjectTypeIds.length > 0
      ? "The extension manifest is not at fault."
      : "The pack manifest could not be read/validated from this instance, so check it too — but the install state named here is the first thing to fix.";
  // SCOPED to the failing org (codex round 1, High): another org's live row must
  // never be reported to THIS org as "installed, just restart" — that advice
  // would be a no-op forever.
  const probe = await probeInstallRecord(input.extension, deps, { orgId: input.orgId });
  switch (probe.state) {
    case "absent":
      return (
        `extension "${input.extension}" is NOT install-active: no installed_extension row exists for it, ` +
        `so no artifact-safe claim over ${named} was ever seeded in artifact_type_claims for org "${input.orgId}". ` +
        `${manifestNote} Heal: install the extension (it is loaded from disk but never installed), ` +
        `or restart the instance — the boot importer repairs a missing install record and reseeds the claims (cinatra#2536).`
      );
    case "live-elsewhere":
      return (
        `extension "${input.extension}" is not install-active for org "${input.orgId}": it is installed only in ` +
        `organization(s) [${probe.organizationIds.join(", ")}] and there is no platform-wide install, so no ` +
        `artifact-safe claim over ${named} governs this org. ${manifestNote} Heal: install ` +
        `the extension for THIS organization — a restart cannot fix it (the boot repair never broadens another ` +
        `organization's install).`
      );
    case "mismatched":
      return (
        `no artifact-safe claim for ${named} governs org "${input.orgId}" — the install record for ` +
        `"${input.extension}" cannot anchor one: ${probe.reason}. ${manifestNote}`
      );
    case "inactive":
      return (
        `extension "${input.extension}" is NOT install-active: its installed_extension row is '${probe.status}' ` +
        `(archived/uninstalled), so its artifact-safe claim over ${named} is retired for org "${input.orgId}". ` +
        `${manifestNote} Heal: restore/reinstall the extension — the boot repair deliberately ` +
        `never resurrects an archive.`
      );
    case "live":
      return (
        `no active artifact-safe claim for ${named} in org "${input.orgId}" — extension install/activation incomplete ` +
        `for "${input.extension}" (its ${probe.scope}-scoped installed_extension row is '${probe.status}', but ` +
        `artifact_type_claims holds no active claim governing this org). ${manifestNote} ` +
        `Heal: restart the instance (the boot claim-activation backstop re-fires activation) or reinstall the extension.`
      );
    case "unreadable":
      return (
        `no artifact-safe claim resolved for "${input.extension}" in org "${input.orgId}" and its install state could ` +
        `not be read (${probe.reason}) — this is an install/activation or store-availability problem, not a manifest ` +
        `problem. Heal: check the database/extension store, then restart the instance.`
      );
  }
}
