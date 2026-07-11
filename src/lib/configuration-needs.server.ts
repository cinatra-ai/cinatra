import "server-only";

// Post-install "needs configuration" resolver (cinatra #1057).
//
// The install closure is PRESENCE-only by design — an install never blocks on
// configuration. This resolver surfaces the follow-up: after an AGENT extension
// is installed, which of its REQUIRED connector dependencies still need to be
// CONFIGURED before the agent can actually run.
//
// SCOPE (owner ruling, #1057 (a)): this need arises for exactly one case — an
// agent whose required dependency set includes connectors. So the resolver only
// considers agent-kind roots and their REQUIRED (non-peer) connector
// dependencies; every other kind, and every optional/peer connector edge, is
// out of scope and carries no configuration-needs surface.
//
// DIRECT required connector deps, each by its OWN probe (ratified chaining, per-
// connector-AUTHORITATIVE): the agent's card surfaces the connectors the agent
// itself requires, each evaluated by that connector's OWN readiness probe — the
// SAME probe the /connectors card grid and setup-page badge read. It does NOT
// descend into a facade connector's transitive base/oauth dependencies. That is
// deliberate and is the ratified decision's core rationale: a facade's probe
// already reflects the real chained end-state (a saved connection cannot exist
// unless its required base is satisfied), while the probe-less base connectors
// (*-oauth / social-media / …) default to not-connected — folding or descending
// into them would leave every facade perpetually not-ready. Each base's readiness
// is surfaced as its OWN row on the /connectors grid, never folded here.
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
import type {
  ExtensionDependency,
  ExtensionKind,
} from "@cinatra-ai/extensions/canonical-types";

/**
 * `@scope/slug` → `slug`. Catalog packageIds are `<scope>/<slug>` (the slug is
 * the workspace short name), so the connector descriptor keyed by slug is
 * recoverable from any dependency's package name.
 */
function slugFromPackageName(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}

/**
 * A required (non-peer) dependency edge that must be present to run — the SAME
 * predicate `dependency-closure.isInstallBlockingEdge` keys on. Inlined (rather
 * than imported) to keep this resolver off the closure module's heavier graph.
 */
function isRequiredEdge(dep: ExtensionDependency): boolean {
  return dep.requirement === "required" && dep.edgeType !== "peer";
}

/** The minimal installed-extension shape the resolver reads (kind + edges). */
export type AgentConfigurationTarget = {
  kind: ExtensionKind;
  packageName: string;
  dependencies: readonly ExtensionDependency[];
};

/**
 * Resolve the "needs configuration" summary for one installed extension.
 *
 * Only an AGENT root is in scope: a non-agent kind short-circuits to an empty
 * summary without probing. For an agent, each DIRECT REQUIRED dependency that
 * resolves to a catalog CONNECTOR descriptor is probed exactly once (dedup by
 * packageId) through its own readiness probe; non-connector deps, optional/peer
 * edges, and any connector without a catalog descriptor (no setup surface) are
 * skipped. Returns the pure summary the card renders.
 */
export async function resolveAgentConfigurationNeeds(
  target: AgentConfigurationTarget,
  ctx: ConnectorReadinessContext,
): Promise<ConfigurationNeedsSummary> {
  // Scope gate — never probe for a non-agent root.
  if (target.kind !== "agent") {
    return summarizeConfigurationNeeds({ rootKind: target.kind, connectors: [] });
  }

  const rows: ConnectorReadinessRow[] = [];
  const seen = new Set<string>();

  for (const dep of target.dependencies) {
    if (!isRequiredEdge(dep)) continue; // optional/peer never gates the agent

    const slug = slugFromPackageName(dep.packageName);
    const descriptor = getConnectorDescriptorBySlug(slug);
    if (!descriptor) continue; // not a catalog connector — no setup surface
    if (seen.has(descriptor.packageId)) continue;
    seen.add(descriptor.packageId);

    // Each connector's OWN probe result (per-connector-authoritative). The probe
    // keys on the catalog packageId — the SAME key the /connectors grid uses.
    const readiness = await resolveConnectorBadgeState(descriptor.packageId, ctx);
    rows.push({
      packageName: dep.packageName,
      // The connector's HUMAN-READABLE manifest name (the SAME `displayName` the
      // /connectors card grid and setup header render) is the primary label —
      // never the bare package name (cinatra #1234). Fall back to the slug only
      // if a future descriptor ever omitted it.
      displayName: descriptor.displayName || slug,
      slug,
      connected: readiness.connected,
      settingsHref: getConnectorSetupHref(slug),
      required: true,
    });
  }

  return summarizeConfigurationNeeds({ rootKind: target.kind, connectors: rows });
}

/** An installed extension row the screen wants a configuration summary for. */
export type InstalledAgentConfigurationInput = AgentConfigurationTarget;

/**
 * Resolve the configuration-needs summary for a set of installed extensions,
 * keyed by packageName. Non-agent rows are skipped entirely (never probed);
 * only agent rows that carry at least one UNCONFIGURED required connector appear
 * in the map, so the caller can look up `map[packageName]?.needs` and render the
 * needs-review strip only where there is something to configure.
 */
export async function resolveConfigurationNeedsForAgents(
  targets: readonly InstalledAgentConfigurationInput[],
  ctx: ConnectorReadinessContext,
): Promise<Record<string, ConfigurationNeedsSummary>> {
  const out: Record<string, ConfigurationNeedsSummary> = {};
  for (const target of targets) {
    if (target.kind !== "agent") continue;
    const summary = await resolveAgentConfigurationNeeds(target, ctx);
    if (summary.needs.length > 0) out[target.packageName] = summary;
  }
  return out;
}
