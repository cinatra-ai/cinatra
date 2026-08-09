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
  const [summary] = await resolveConfigurationNeedsBatch([target], ctx);
  return summary!;
}

/**
 * A probe cache for ONE resolution pass (cinatra#2539).
 *
 * `resolveConnectorBadgeState` is a live readiness probe — a database read, and
 * for most connectors a call out to the connection broker. Its result is a
 * property of the CONNECTOR and the viewer, not of the agent that happens to
 * depend on it, so within a single pass a given `packageId` is probed exactly
 * once and every agent that requires it reads the same answer. Keyed on the
 * promise so concurrent requesters share the in-flight probe rather than
 * starting a second one.
 */
type ProbeCache = Map<string, Promise<{ connected: boolean }>>;

/**
 * How many connector readiness probes may be in flight at once (cinatra#2539).
 * Enough to keep the page's probes overlapping; small enough that a catalog
 * full of distinct connectors cannot burst the database / connection broker.
 */
const PROBE_CONCURRENCY = 8;

function probeOnce(
  cache: ProbeCache,
  packageId: string,
  ctx: ConnectorReadinessContext,
): Promise<{ connected: boolean }> {
  const inFlight = cache.get(packageId);
  if (inFlight) return inFlight;
  const started = resolveConnectorBadgeState(packageId, ctx);
  cache.set(packageId, started);
  return started;
}

/**
 * Resolve the summaries for a batch of roots against ONE shared probe cache,
 * with the probes issued concurrently (cinatra#2539).
 *
 * Behaviour is identical to the previous serialized shape — the same connectors
 * are probed, each row carries the same fields, and the declared dependency
 * order is preserved — but a page rendering N agents that share M connectors
 * now performs `|distinct connectors|` probes in parallel instead of `N × M`
 * probes one after another. `resolveConnectorBadgeState` already degrades a
 * throwing probe to not-connected, so no probe can reject this batch.
 */
async function resolveConfigurationNeedsBatch(
  targets: readonly AgentConfigurationTarget[],
  ctx: ConnectorReadinessContext,
): Promise<ConfigurationNeedsSummary[]> {
  const cache: ProbeCache = new Map();

  // Plan first (pure): which descriptor each root's required edges resolve to,
  // in declared order, deduped WITHIN the root exactly as before.
  const plans = targets.map((target) => {
    if (target.kind !== "agent") return { target, edges: [] as const };
    const seen = new Set<string>();
    const edges: { packageName: string; slug: string; packageId: string; displayName: string }[] = [];
    for (const dep of target.dependencies) {
      if (!isRequiredEdge(dep)) continue; // optional/peer never gates the agent
      const slug = slugFromPackageName(dep.packageName);
      const descriptor = getConnectorDescriptorBySlug(slug);
      if (!descriptor) continue; // not a catalog connector — no setup surface
      if (seen.has(descriptor.packageId)) continue;
      seen.add(descriptor.packageId);
      edges.push({
        packageName: dep.packageName,
        slug,
        packageId: descriptor.packageId,
        // The connector's HUMAN-READABLE manifest name (the SAME `displayName`
        // the /connectors card grid and setup header render) is the primary
        // label — never the bare package name (cinatra #1234). Fall back to the
        // slug only if a future descriptor ever omitted it.
        displayName: descriptor.displayName || slug,
      });
    }
    return { target, edges };
  });

  // Probe every distinct connector ONCE, at BOUNDED concurrency. Unbounded
  // would trade one amplifier for another: these probes hit the database and
  // the connection broker, and a catalog with many distinct connectors would
  // burst that many simultaneous calls. A small window keeps the fan-out
  // parallel without becoming a thundering herd.
  const distinctPackageIds = [
    ...new Set(plans.flatMap(({ edges }) => edges.map((edge) => edge.packageId))),
  ];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, distinctPackageIds.length) },
    async () => {
      while (next < distinctPackageIds.length) {
        const packageId = distinctPackageIds[next++]!;
        await probeOnce(cache, packageId, ctx);
      }
    },
  );
  await Promise.all(workers);

  return Promise.all(
    plans.map(async ({ target, edges }) => {
      const rows: ConnectorReadinessRow[] = [];
      for (const edge of edges) {
        const readiness = await probeOnce(cache, edge.packageId, ctx);
        rows.push({
          packageName: edge.packageName,
          displayName: edge.displayName,
          slug: edge.slug,
          connected: readiness.connected,
          settingsHref: getConnectorSetupHref(edge.slug),
          required: true,
        });
      }
      return summarizeConfigurationNeeds({ rootKind: target.kind, connectors: rows });
    }),
  );
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
  // Non-agent roots are dropped before the batch so they are never probed.
  const agents = targets.filter((target) => target.kind === "agent");
  const summaries = await resolveConfigurationNeedsBatch(agents, ctx);
  agents.forEach((target, index) => {
    const summary = summaries[index]!;
    if (summary.needs.length > 0) out[target.packageName] = summary;
  });
  return out;
}
