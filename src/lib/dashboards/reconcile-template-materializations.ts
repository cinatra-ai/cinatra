import "server-only";

// The dashboard-TEMPLATE MATERIALIZE reconciler (cinatra#1896 Scope 2 / epic
// #1883 install→materialize trigger).
//
// `materializeExtensionTemplate` (the dashboards single-writer) had NO app-side
// caller on `origin/main`: the carrier/template substrate + the twin pairing were
// merged, but nothing INSTALLED a pack's dashboard. This is that trigger. Modelled
// on the sibling `reconcile-contribution-adoptions` boot reconcile: AFTER extension
// activation, for every org that holds a LIVE install of a `kind:"artifact"` pack
// shipping a `form:"dashboard"` template, it materializes the pack's dashboard
// (idempotent — `materializeExtensionTemplate` upserts the single template row per
// (extension, org) in place, so a re-boot / reinstall re-converges + the twin's
// meaning-assertion mint is precedence-guarded).
//
// DORMANT by construction: candidate orgs are only those with a live install of a
// dashboard-template pack. The current fleet ships none in the dev/required lock,
// so this reconciles zero orgs and is a clean no-op. It becomes live the moment
// such a pack (e.g. `@cinatra-ai/web-analytics-dashboard-artifact`) is installed.
//
// TWO INSTALL SOURCES (cinatra#1896 runtime-store carry). A live install of a
// dashboard-template pack is discovered from EITHER:
//   - the STATIC manifest (a dev/required-locked pack in `STATIC_EXTENSION_MANIFEST`,
//     template read from `<cwd>/<sourceDir>`); OR
//   - the RUNTIME package store (a MARKETPLACE-installed pack NOT in the static
//     manifest — its anchor-vetted `{packageName, storeDir}` comes from the SAME
//     `rescanArtifactBridgeFromStore` authority that registers runtime artifact
//     types at boot, template read from the absolute `storeDir`).
// Both are gated by a live `installed_extension` row (active/locked, org-addressable),
// which supplies the org attribution the runtime record lacks. TWO fail-closed
// invariants (codex #1896-r0):
//   - STATIC PRESENCE IS AUTHORITATIVE: a package the trusted static manifest claims
//     is served ONLY from static — the untrusted runtime store is never consulted for
//     it, even if the static read fails (no fall-through / no runtime override).
//   - the UNTRUSTED runtime path validates the pack's `dashboardContribution` claim
//     via the sdk leaf's `parseDashboardContribution` (never a looser parse) BEFORE it
//     is a candidate — a locked static pack is host-trusted and keys on templates.
//
// Best-effort + fully injectable (unit-tested with synthetic templates + a spy
// materializer, no DB/fs): idempotent, per-org + per-pack failures contained.
//
// Deliberately NOT importing "server-only" at the resolver leaves — unit tests
// import the phase list; the heavy default resolvers are dynamically imported.

import {
  materializeExtensionTemplate,
  type ExtensionDashboardOwnerScope,
  type MaterializeTemplateInput,
} from "@cinatra-ai/dashboards/extension-materialization";
import {
  parseDashboardContribution,
  resolveDashboardContributionClaim,
} from "@cinatra-ai/sdk-extensions";

/** The canonical statuses that count as LIVE (mirrors the reader-gate oracle). */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** One materializable dashboard template resolved for an org: the pack, its raw
 *  `cinatra/dashboard.json` config (validated as apiVersion 1.2 by the
 *  materializer), an optional display name, and the owner scope the template row
 *  is stamped under. */
export type LiveDashboardTemplate = {
  readonly packageName: string;
  /** Raw dashboard config (the pack's `cinatra/dashboard.json`) — validated as
   *  apiVersion 1.2 by `materializeExtensionTemplate`, which throws
   *  `DashboardConfigInvalidError` on a malformed template (a bad template is
   *  contained per-pack, never fatal). */
  readonly config: unknown;
  readonly name?: string;
  readonly scope: ExtensionDashboardOwnerScope;
};

export type ReconcileTemplateMaterializeDeps = {
  /** Override live-template resolution (tests inject synthetic templates). */
  readonly resolveLiveTemplates?: (organizationId: string) => Promise<LiveDashboardTemplate[]>;
  /** Override the transactional writer (tests). */
  readonly materialize?: typeof materializeExtensionTemplate;
};

// --- pure resolution core (unit-tested with fakes; no DB/fs) ------------------

/** The minimal `installed_extension` row shape the resolvers read. */
type InstalledRowLite = {
  readonly packageName: string;
  readonly status: string;
  readonly organizationId: string | null;
};
/** The minimal static-manifest record shape the resolvers read. */
type StaticRecordLite = { readonly kind: string; readonly sourceDir: string };
/** An anchor-vetted runtime artifact store record (from `rescanArtifactBridgeFromStore`). */
type RuntimeArtifactRecord = { readonly packageName: string; readonly storeDir: string };
/** A dashboard-template read result (the pack's parsed config + optional name). */
type ReadTemplateResult = { config: unknown; name?: string } | null;

/**
 * FAIL-CLOSED runtime claim gate (codex #1896-r0 HIGH): an UNTRUSTED runtime-store
 * pack materializes its dashboard ONLY IF its `cinatra.dashboardContribution` claim
 * passes the sdk leaf's `parseDashboardContribution` — the SAME validator the
 * adoption path uses, applied through the SAME `resolveDashboardContributionClaim`
 * artifact-kind + object gate the generator/loader carry through (NEVER a looser
 * runtime parse: a wrong kind, a non-object claim, a schema-invalid claim, or one
 * built for an incompatible SDK ABI all fail closed). A dev/required-LOCKED static
 * pack is host-trusted and is NOT subject to this gate (it keys on `artifact.templates`
 * exactly as the merged #2032 static path does).
 */
export function runtimePackHasValidContributionClaim(
  raw: { kind: unknown; dashboardContribution: unknown } | null,
): boolean {
  if (!raw) return false;
  const claim = resolveDashboardContributionClaim(raw.kind, { dashboardContribution: raw.dashboardContribution });
  if (!claim) return false;
  return parseDashboardContribution(claim).ok;
}

/**
 * PURE: resolve the LIVE dashboard templates for one org by merging the STATIC
 * manifest source and the RUNTIME store source. STATIC PRESENCE IS AUTHORITATIVE
 * (codex #1896-r0 HIGH): a package the trusted static manifest CLAIMS is served ONLY
 * from static and is NEVER overridden by untrusted runtime-store bytes — even if its
 * static template read fails (it then simply does not materialize; it does NOT fall
 * through to the store). The runtime store is consulted ONLY for a package the static
 * manifest does not claim at all (a genuine marketplace install). `runtimeRecords`
 * are already anchor-vetted AND claim-validated by the caller. Packages that resolve
 * to no dashboard template are skipped (degrade-with-diagnostic upstream).
 */
export function resolveLiveTemplatesFromSources(input: {
  organizationId: string;
  rows: readonly InstalledRowLite[];
  staticManifest: Readonly<Record<string, StaticRecordLite | undefined>>;
  runtimeRecords: readonly RuntimeArtifactRecord[];
  readStaticTemplate: (packageName: string, sourceDir: string) => ReadTemplateResult;
  readTemplateFromDir: (packageName: string, storeDir: string) => ReadTemplateResult;
}): LiveDashboardTemplate[] {
  const { organizationId, rows, staticManifest, runtimeRecords } = input;
  const livePackages = new Set<string>();
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (row.organizationId === null || row.organizationId === organizationId) {
      livePackages.add(row.packageName);
    }
  }
  const runtimeByName = new Map(runtimeRecords.map((r) => [r.packageName, r] as const));
  const scope: ExtensionDashboardOwnerScope = { ownerLevel: "organization", ownerId: organizationId };

  const templates: LiveDashboardTemplate[] = [];
  for (const packageName of livePackages) {
    const staticRecord = staticManifest[packageName];
    let resolved: ReadTemplateResult = null;
    if (staticRecord) {
      // STATIC PRESENCE CLAIMS the package — authoritative. Read the template only
      // for a kind:"artifact" static record; either way, NEVER consult the runtime
      // store for a statically-claimed package (no fall-through on a failed read).
      if (staticRecord.kind === "artifact") {
        resolved = input.readStaticTemplate(packageName, staticRecord.sourceDir);
      }
    } else {
      // Not in the static manifest → a genuine marketplace/runtime-store install.
      const runtime = runtimeByName.get(packageName);
      if (runtime) resolved = input.readTemplateFromDir(packageName, runtime.storeDir);
    }
    if (!resolved) continue;
    templates.push({ packageName, config: resolved.config, name: resolved.name, scope });
  }
  return templates;
}

/**
 * PURE: collect the candidate org ids for the all-orgs reconcile — every org
 * holding a live, org-addressable install of a dashboard-template pack from EITHER
 * source. `runtimeShippers` is the set of runtime-store package names already
 * confirmed to ship a `form:"dashboard"` template (the cheap manifest probe over
 * their `storeDir`), so this helper needs no fs.
 */
export function collectCandidateOrgIdsFromSources(input: {
  rows: readonly InstalledRowLite[];
  staticManifest: Readonly<Record<string, StaticRecordLite | undefined>>;
  runtimeShippers: ReadonlySet<string>;
  staticShips: (packageName: string, sourceDir: string) => boolean;
}): string[] {
  const orgIds = new Set<string>();
  for (const row of input.rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (row.organizationId === null) continue; // system-locked fan-out is a follow-up
    const staticRecord = input.staticManifest[row.packageName];
    if (staticRecord) {
      // STATIC PRESENCE IS AUTHORITATIVE (codex #1896-r0 HIGH): decide candidacy
      // from the static source ALONE — never OR in the runtime store for a package
      // the trusted static manifest already claims.
      if (staticRecord.kind === "artifact" && input.staticShips(row.packageName, staticRecord.sourceDir)) {
        orgIds.add(row.organizationId);
      }
    } else if (input.runtimeShippers.has(row.packageName)) {
      orgIds.add(row.organizationId);
    }
  }
  return [...orgIds];
}

export type ReconcileTemplateMaterializeResult = {
  /** Template rows materialized/re-converged (one per (pack, org)). */
  readonly materialized: number;
  /** Templates skipped fail-closed (invalid config / writer threw), contained per pack. */
  readonly failed: number;
};

/**
 * Resolve the LIVE dashboard-template packs for `organizationId` from the
 * canonical install store + the generated manifest, reading each pack's
 * `artifact.templates[form:"dashboard"]` sidecar config off disk. Liveness matches
 * the reader-gate oracle (active/locked, org-addressable). A pack that is not on
 * disk / has no dashboard template / whose sidecar is unreadable is skipped
 * (degrade-with-diagnostic, never fatal).
 */
/**
 * Best-effort discovery of the anchor-vetted RUNTIME-store artifact records
 * (`{packageName, storeDir}`) — the SAME authority (`rescanArtifactBridgeFromStore`)
 * that registers runtime artifact object types at boot, so a dashboard materializes
 * exactly when the pack's artifact type is live on disk. Re-invoking it here is
 * idempotent (the object registry is replace-by-id; the type was already registered
 * in the preceding activation phase). A discovery failure (no `/data` store, DB
 * unavailable) degrades to `[]` — the static source still reconciles.
 */
async function defaultRuntimeArtifactRecords(): Promise<RuntimeArtifactRecord[]> {
  try {
    const { rescanArtifactBridgeFromStore } = await import("@/lib/extension-artifact-bridge-rescan");
    const { readPackContributionClaimFromDir } = await import("@/lib/dashboards/read-pack-dashboard-template");
    const { registeredRecords } = await rescanArtifactBridgeFromStore();
    // FAIL-CLOSED (codex #1896-r0 HIGH): an untrusted runtime-store pack is a
    // materialize candidate ONLY when its dashboardContribution claim is VALID
    // (`parseDashboardContribution` via the shared gate — never a looser parse). A
    // pack with no claim, a non-object claim, or a schema-/ABI-invalid claim is
    // dropped here, so the template read below never runs for an unvalidated pack.
    return registeredRecords.filter((r) =>
      runtimePackHasValidContributionClaim(readPackContributionClaimFromDir(r.storeDir)),
    );
  } catch (err) {
    console.warn(
      "[dashboards/materialize] runtime artifact-store discovery unavailable — " +
        "reconciling static-manifest packs only:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

async function defaultResolveLiveTemplates(
  organizationId: string,
): Promise<LiveDashboardTemplate[]> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");
  const { readPackDashboardTemplate, readPackDashboardTemplateFromDir } = await import(
    "@/lib/dashboards/read-pack-dashboard-template"
  );

  const rows = await listInstalledExtensions({});
  const runtimeRecords = await defaultRuntimeArtifactRecords();

  return resolveLiveTemplatesFromSources({
    organizationId,
    rows,
    staticManifest: STATIC_EXTENSION_MANIFEST,
    runtimeRecords,
    readStaticTemplate: readPackDashboardTemplate,
    readTemplateFromDir: readPackDashboardTemplateFromDir,
  });
}

/**
 * Materialize every live dashboard-template pack's dashboard for one org.
 * Idempotent (`materializeExtensionTemplate` upserts the single template row per
 * (extension, org) in place). Fail-closed per pack: an invalid template config or a
 * writer throw is contained (logged), so a sibling pack still materializes. Returns
 * a summary.
 */
export async function reconcileDashboardTemplateMaterializations(
  organizationId: string,
  deps: ReconcileTemplateMaterializeDeps = {},
): Promise<ReconcileTemplateMaterializeResult> {
  const resolveLiveTemplates = deps.resolveLiveTemplates ?? defaultResolveLiveTemplates;
  const materialize = deps.materialize ?? materializeExtensionTemplate;

  // System actor for the install-triggered materialize audit rows (install authz
  // is gated upstream — materialize is a system write, like the archive/adopt
  // paths, so it does NOT re-run the user-facing dashboard access resolver).
  const actor = {
    userId: "system:dashboard-template-materializer",
    organizationId,
    teamIds: [] as string[],
    orgRole: "owner" as const,
    teamRoles: {} as Record<string, "admin" | "member">,
  };

  const templates = await resolveLiveTemplates(organizationId);

  let materialized = 0;
  let failed = 0;
  for (const t of templates) {
    const input: MaterializeTemplateInput = {
      extensionId: t.packageName,
      organizationId,
      config: t.config,
      scope: t.scope,
      actor,
      ...(t.name !== undefined ? { name: t.name } : {}),
    };
    try {
      await materialize(undefined, input);
      materialized += 1;
    } catch (err) {
      // A malformed template config (DashboardConfigInvalidError) or a writer throw
      // rolls THIS pack's materialize back (nothing partially written — one tx per
      // pack). Contain it per pack (fail-closed) so a sibling pack still
      // materializes; the pack is left un-materialized until the manifest is fixed.
      failed += 1;
      console.warn(
        `[dashboards/materialize] template materialize FAILED for ${t.packageName} ` +
          `(org ${organizationId}; contained — the dashboard is left un-materialized):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { materialized, failed };
}

// ---------------------------------------------------------------------------
// ALL-ORGS reconcile — the boot / install TRIGGER entry point. Candidate orgs are
// only those holding a live install of a dashboard-template pack, so the whole
// path is DORMANT until such a pack ships. Per-org failures are contained.
// ---------------------------------------------------------------------------

export type ReconcileAllTemplateMaterializeDeps = ReconcileTemplateMaterializeDeps & {
  /** Override candidate-org resolution (tests). Defaults to the live-install org
   *  scan (the reconcile is a no-op for any org with no dashboard-template pack). */
  readonly resolveCandidateOrgIds?: () => Promise<string[]>;
};

export type ReconcileAllTemplateMaterializeResult = {
  readonly orgsReconciled: number;
  readonly materialized: number;
  readonly failed: number;
};

async function defaultResolveCandidateOrgIds(): Promise<string[]> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");
  const { packShipsDashboardTemplate, packShipsDashboardTemplateInDir } = await import(
    "@/lib/dashboards/read-pack-dashboard-template"
  );

  const rows = await listInstalledExtensions({});
  const runtimeRecords = await defaultRuntimeArtifactRecords();
  // Pre-filter the runtime records to the ones actually shipping a dashboard
  // template (cheap manifest probe over the anchor-vetted storeDir) so the pure
  // collector needs no fs.
  const runtimeShippers = new Set(
    runtimeRecords
      .filter((r) => packShipsDashboardTemplateInDir(r.packageName, r.storeDir))
      .map((r) => r.packageName),
  );

  return collectCandidateOrgIdsFromSources({
    rows,
    staticManifest: STATIC_EXTENSION_MANIFEST,
    runtimeShippers,
    staticShips: packShipsDashboardTemplate,
  });
}

export async function reconcileAllDashboardTemplateMaterializations(
  deps: ReconcileAllTemplateMaterializeDeps = {},
): Promise<ReconcileAllTemplateMaterializeResult> {
  const resolveCandidateOrgIds = deps.resolveCandidateOrgIds ?? defaultResolveCandidateOrgIds;
  const orgIds = await resolveCandidateOrgIds();

  let orgsReconciled = 0;
  let materialized = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const r = await reconcileDashboardTemplateMaterializations(orgId, deps);
      materialized += r.materialized;
      failed += r.failed;
      orgsReconciled += 1;
    } catch (err) {
      // Contain a per-org failure so a sibling org still reconciles.
      failed += 1;
      console.warn(
        `[dashboards/materialize] org ${orgId} template reconcile threw (contained):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { orgsReconciled, materialized, failed };
}
