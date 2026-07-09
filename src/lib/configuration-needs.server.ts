import "server-only";

// Post-install "needs configuration" resolver (cinatra #1057).
//
// The install closure is PRESENCE-only by design — an install never blocks on
// configuration. This resolver surfaces the follow-up: after a batch installs
// an extension (and auto-installs its connector dependencies), which of those
// connectors still need to be CONFIGURED before the extension can actually run.
//
// It probes every CONNECTOR the batch touched (the installed root AND its
// dependency members that resolve to a catalog connector descriptor) through
// that connector's OWN readiness probe — the SAME probe the `/connectors` card
// grid and the setup-page badge read — and hands the per-connector readiness
// rows to the pure `summarizeConfigurationNeeds` derivation. Per the ratified
// readiness-chaining decision (#1057), each connector's readiness is its own
// probe result; a required connector-dependency's readiness is surfaced as its
// OWN row, never folded into a facade's readiness.
//
// FAIL-SOFT: `resolveConnectorBadgeState` already degrades a throwing/absent
// probe to not-connected rather than 500-ing, so an unconfigured connector is
// surfaced as a Configure affordance instead of crashing the screen — the same
// posture as the setup-page badge.

import {
  getConnectorSetupHref,
  resolveConnectorBadgeState,
  type ConnectorReadinessContext,
} from "@/lib/connectors-registry.server";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  summarizeConfigurationNeeds,
  type ConfigurationNeedsSummary,
  type ConnectorReadinessRow,
} from "@/lib/extension-dependency-ux";
import type { InstallBatch } from "@/lib/extension-install-batch-ops";

/**
 * `@scope/slug` → `slug`. Catalog packageIds are `<scope>/<slug>` (the slug is
 * the workspace short name), so the connector descriptor keyed by slug is
 * recoverable from any batch member's package name.
 */
function slugFromPackageName(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}

/**
 * Resolve the post-install "needs configuration" summary for one install
 * batch. Non-connector members (agents/skills/artifacts) and runtime-only
 * connectors with no build-time catalog descriptor carry no readiness surface
 * and are skipped; each catalog connector is probed exactly once (dedup by
 * packageId). Returns the pure summary the batch panel renders.
 */
export async function resolveBatchConfigurationNeeds(
  batch: InstallBatch,
  ctx: ConnectorReadinessContext,
): Promise<ConfigurationNeedsSummary> {
  const rows: ConnectorReadinessRow[] = [];
  const seen = new Set<string>();

  for (const member of batch.members) {
    const slug = slugFromPackageName(member.packageName);
    const descriptor = getConnectorDescriptorBySlug(slug);
    if (!descriptor) continue; // not a catalog connector — no readiness surface
    if (seen.has(descriptor.packageId)) continue;
    seen.add(descriptor.packageId);

    const readiness = await resolveConnectorBadgeState(descriptor.packageId, ctx);
    rows.push({
      packageName: member.packageName,
      // The connector's HUMAN-READABLE manifest name (the SAME `displayName`
      // the /connectors card grid and the setup-page header render) is the
      // primary label — never the bare package name (cinatra #1234 owner
      // review). Catalog descriptors always carry it; fall back to the slug
      // only if a future descriptor ever omitted it.
      displayName: descriptor.displayName || slug,
      slug,
      connected: readiness.connected,
      settingsHref: getConnectorSetupHref(slug),
      isRoot: member.packageName === batch.rootPackage,
    });
  }

  return summarizeConfigurationNeeds(rows);
}

/**
 * Resolve the configuration-needs summary for every FINALIZED batch, keyed by
 * batchId. Only finalized (successfully installed) batches carry a
 * needs-configuration affordance — a compensated/failed batch rolled its
 * install back, so nothing is left to configure. Batches with no unconfigured
 * connector produce an empty-`needs` summary (the panel renders nothing).
 */
export async function resolveConfigurationNeedsByBatch(
  batches: readonly InstallBatch[],
  ctx: ConnectorReadinessContext,
): Promise<Record<string, ConfigurationNeedsSummary>> {
  const out: Record<string, ConfigurationNeedsSummary> = {};
  for (const batch of batches) {
    if (batch.phase !== "finalized") continue;
    out[batch.batchId] = await resolveBatchConfigurationNeeds(batch, ctx);
  }
  return out;
}
