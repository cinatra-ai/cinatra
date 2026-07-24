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
async function defaultResolveLiveTemplates(
  organizationId: string,
): Promise<LiveDashboardTemplate[]> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");
  const { readPackDashboardTemplate } = await import("@/lib/dashboards/read-pack-dashboard-template");

  const livePackages = new Set<string>();
  const rows = await listInstalledExtensions({});
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (row.organizationId === null || row.organizationId === organizationId) {
      livePackages.add(row.packageName);
    }
  }

  const templates: LiveDashboardTemplate[] = [];
  for (const packageName of livePackages) {
    const record = STATIC_EXTENSION_MANIFEST[packageName];
    if (!record || record.kind !== "artifact") continue;
    const resolved = readPackDashboardTemplate(packageName, record.sourceDir);
    if (!resolved) continue; // no dashboard template, or unreadable — skip
    templates.push({
      packageName,
      config: resolved.config,
      name: resolved.name,
      // An org install materializes the template under the org owner axis; the
      // config's own `scopeLevel` still drives the row's `template_scope`.
      scope: { ownerLevel: "organization", ownerId: organizationId },
    });
  }
  return templates;
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
  const { packShipsDashboardTemplate } = await import("@/lib/dashboards/read-pack-dashboard-template");

  const rows = await listInstalledExtensions({});
  const orgIds = new Set<string>();
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (row.organizationId === null) continue; // system-locked fan-out is a follow-up
    const record = STATIC_EXTENSION_MANIFEST[row.packageName];
    if (!record || record.kind !== "artifact") continue;
    if (!packShipsDashboardTemplate(row.packageName, record.sourceDir)) continue;
    orgIds.add(row.organizationId);
  }
  return [...orgIds];
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
