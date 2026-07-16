import "server-only";

// App-side liveness oracle for the dashboards reader gate (cinatra#1628, S11a).
//
// The reader gate (packages/dashboards `isDashboardRowRenderable` /
// `filterRenderableDashboards`) denies an `extension_id`-bearing dashboard row
// whose owning extension is not currently LIVE. "Live" = the package has an
// `active` or `locked` canonical `installed_extension` row addressable to the
// row's organization (a system-locked row is org-null; a per-org install carries
// the org). This module resolves that set from the canonical store and hands the
// pure gate a total predicate.
//
// The canonical-store import lives HERE (the app), not in @cinatra-ai/dashboards
// — that package must stay dependency-light + must not pull the extensions
// canonical store. The dashboards package exposes only the pure predicate-shaped
// gate; the app injects this oracle.
//
// FAIL-CLOSED / TRANSIENT-SAFE: on ANY resolution failure the returned predicate
// denies every extension row (HIDE-at-read) and never throws — an unverifiable
// orphan must not render. Hiding is recoverable (the row reappears once the store
// resolves); it never archives user state (archival is the separate durable
// migration sweep + committed-uninstall hook).
//
// SCOPE NOTE (S11a): liveness here is INSTALL liveness (installed + active). The
// contribution-declaration refinement — additionally requiring the live record to
// declare a `cinatra.dashboardContribution` — lands in S11b with the successor
// reader/reconciler that materializes off the claim. For S11a the entire
// extension-dashboard population is legacy workflow rows whose package is not
// installed at all, so install liveness gates exactly them off; an installed+
// active package never carries extension dashboard rows until S11b materializes
// them, so the two definitions coincide on today's data.

import type { ExtensionLivenessOracle } from "@cinatra-ai/dashboards/extension-dashboard-reads";

/** The canonical statuses that count as LIVE for the reader gate. */
const LIVE_STATUSES = new Set(["active", "locked"]);

/**
 * Resolve a total {@link ExtensionLivenessOracle} for `organizationId`: a package
 * is live iff it has an `active`/`locked` install row scoped to this org (or a
 * system org-null row). Never throws — a resolution failure yields a deny-all
 * predicate (fail-closed hide-at-read).
 */
export async function resolveLiveExtensionPredicate(
  organizationId: string | null | undefined,
): Promise<ExtensionLivenessOracle> {
  const live = new Set<string>();
  try {
    const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
    const rows = await listInstalledExtensions({});
    for (const row of rows) {
      if (!LIVE_STATUSES.has(row.status)) continue;
      // Addressable to the row's org: a system-locked row is org-null; a per-org
      // install must match. (S11a gate is org-coarse by design — install-level
      // liveness, not per-actor addressability, which the owner/project gate
      // already enforces downstream.)
      if (row.organizationId === null || row.organizationId === organizationId) {
        live.add(row.packageName);
      }
    }
  } catch (e) {
    // Transient store failure — deny every extension row (hide-at-read). Log,
    // never throw: a reader path must degrade to the empty/absent state, never
    // crash, and must never archive.
    console.warn(
      `[dashboards/live-extension-oracle] liveness resolution failed for org ${organizationId ?? "<none>"}; ` +
        `denying extension dashboards (hide-at-read):`,
      e instanceof Error ? e.message : e,
    );
    return () => false;
  }
  return (extensionId: string) => live.has(extensionId);
}
