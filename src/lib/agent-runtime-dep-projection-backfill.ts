import "server-only";

// ---------------------------------------------------------------------------
// Agent runtime-dependency projection backfill (cinatra#1056).
//
// The install path projects the canonical `cinatra.dependencies` edges into the
// two runtime-gate columns on `agent_templates` (`connector_dependencies` +
// `agent_dependencies`). Templates installed BEFORE that projection carry the
// canonical edges only on their canonical `installed_extension` row (persisted
// by #180) — not on the template columns the run-enqueue connector preflight
// and the orchestrator-readiness gate read. This one-shot, boot-time pass
// re-projects each installed template's canonical-row edges onto its columns so
// the runtime gates fire for already-installed agents.
//
// MERGE, NEVER CLEAR: the projection only ADDS/UPDATES entries derived from a
// canonical kinded edge; it never removes an existing map entry. So a
// legacy-only template (whose `agent_dependencies` was install-seeded from the
// legacy `cinatra.agentDependencies` map, with no canonical kinded agent edge)
// keeps its existing map and still gates identically — dual-read is preserved.
//
// Inert + safe: kill-switchable (`CINATRA_AGENT_RUNTIME_DEP_BACKFILL=off`),
// idempotent (writes only when the merged projection differs), soft-failing
// per-template (never aborts boot). ONLY REQUIRED `kind:"agent"` edges are
// projected into `agent_dependencies` (the readiness gate hard-fails every entry
// and is requirement-less; optional-agent behavior is a later wave); ALL
// `kind:"connector"` edges are projected into `connector_dependencies` carrying
// their requirement.
// ---------------------------------------------------------------------------

import type { ExtensionDependency, VersionConstraint } from "@cinatra-ai/extensions/canonical-types";
import { versionConstraintToRange } from "@cinatra-ai/extensions/manifest-dependencies";

/** Env kill switch — set to `off` to disable the pass entirely. */
const KILL_SWITCH_ENV = "CINATRA_AGENT_RUNTIME_DEP_BACKFILL";

/** Canonical statuses treated as a live install (mirrors the install anchor). */
const LIVE_STATUSES = new Set(["active", "locked"]);

export type ConnectorDepValue = { range: string; requirement: "required" | "optional" };
export type ConnectorDependencyMap = Record<string, string | ConnectorDepValue>;

export type RuntimeDepMaps = {
  agentDependencies?: Record<string, string>;
  connectorDependencies?: ConnectorDependencyMap;
};

/**
 * PURE projection. MERGE the canonical edges onto the existing runtime-dep maps
 * — required `kind:"agent"` edges into `agentDependencies` (as a bare range),
 * every `kind:"connector"` edge into `connectorDependencies` (as
 * `{ range, requirement }`). NEVER removes an existing entry, so a template's
 * install-seeded legacy `agentDependencies` survive untouched when the canonical
 * row carries no kinded agent edge. `changed` is true only when the merged
 * result differs from what the template already holds (idempotence).
 */
export function projectCanonicalEdgesOntoRuntimeDeps(
  edges: readonly ExtensionDependency[],
  existing: RuntimeDepMaps,
  toRange: (vc: VersionConstraint) => string = versionConstraintToRange,
): { next: Required<RuntimeDepMaps>; changed: boolean } {
  const existingAgent = existing.agentDependencies ?? {};
  const existingConnector = existing.connectorDependencies ?? {};

  const nextAgent: Record<string, string> = { ...existingAgent };
  const nextConnector: ConnectorDependencyMap = { ...existingConnector };
  for (const e of edges) {
    if (e.kind === "agent" && e.requirement === "required") {
      nextAgent[e.packageName] = toRange(e.versionConstraint);
    } else if (e.kind === "connector") {
      nextConnector[e.packageName] = {
        range: toRange(e.versionConstraint),
        requirement: e.requirement,
      };
    }
  }

  const changed =
    JSON.stringify(nextAgent) !== JSON.stringify(existingAgent) ||
    JSON.stringify(nextConnector) !== JSON.stringify(existingConnector);
  return { next: { agentDependencies: nextAgent, connectorDependencies: nextConnector }, changed };
}

export type RuntimeDepBackfillResult = {
  scanned: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Set when the whole pass short-circuited before scanning. */
  skippedReason?: "kill-switch";
};

export type BackfillTemplate = {
  id: string;
  packageName: string;
} & RuntimeDepMaps;

export type RuntimeDepBackfillDeps = {
  /** Every installed agent_template that carries a packageName. */
  listTemplates: () => Promise<BackfillTemplate[]>;
  /** The canonical dependency edges recorded for a package (from its live installed_extension row). */
  readCanonicalEdges: (packageName: string) => Promise<ExtensionDependency[]>;
  /** Persist the merged runtime-dep maps onto a template row. */
  updateTemplateDeps: (id: string, patch: RuntimeDepMaps) => Promise<void>;
  log?: (msg: string) => void;
};

/**
 * Run the backfill. Tests inject in-memory deps; boot uses the real deps wired
 * by {@link makeDefaultRuntimeDepBackfillDeps}. Never throws — soft-fails per
 * template so a single bad row cannot abort boot.
 */
export async function runAgentRuntimeDepProjectionBackfill(
  overrides: Partial<RuntimeDepBackfillDeps> = {},
): Promise<RuntimeDepBackfillResult> {
  const empty: RuntimeDepBackfillResult = { scanned: 0, updated: 0, unchanged: 0, failed: 0 };

  if ((process.env[KILL_SWITCH_ENV] ?? "").trim().toLowerCase() === "off") {
    return { ...empty, skippedReason: "kill-switch" };
  }

  const deps = overrides.listTemplates
    ? (overrides as RuntimeDepBackfillDeps)
    : { ...(await makeDefaultRuntimeDepBackfillDeps()), ...overrides };

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let scanned = 0;

  try {
    const templates = await deps.listTemplates();
    scanned = templates.length;
    for (const t of templates) {
      try {
        const edges = await deps.readCanonicalEdges(t.packageName);
        if (edges.length === 0) {
          // No canonical edges to project — leave the template's install-seeded
          // maps untouched (legacy-only templates gate on those unchanged).
          unchanged++;
          continue;
        }
        const { next, changed } = projectCanonicalEdgesOntoRuntimeDeps(edges, t);
        if (!changed) {
          unchanged++;
          continue;
        }
        await deps.updateTemplateDeps(t.id, {
          agentDependencies: next.agentDependencies,
          connectorDependencies: next.connectorDependencies,
        });
        updated++;
      } catch (err) {
        failed++;
        deps.log?.(
          `[agent-runtime-dep-backfill] FAILED ${t.packageName} (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    deps.log?.(
      `[agent-runtime-dep-backfill] enumeration failed (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { scanned, updated, unchanged, failed: failed + 1 };
  }

  return { scanned, updated, unchanged, failed };
}

/** Build the real (server-only) deps. */
export async function makeDefaultRuntimeDepBackfillDeps(): Promise<RuntimeDepBackfillDeps> {
  const [
    { readAllAgentTemplatesWithPackageName, updateAgentTemplate },
    { readInstalledExtensionsByPackageName },
  ] = await Promise.all([
    import("@cinatra-ai/agents/store"),
    import("@cinatra-ai/extensions/canonical-store"),
  ]);

  return {
    listTemplates: async () => {
      const rows = await readAllAgentTemplatesWithPackageName();
      return rows
        .filter((t): t is typeof t & { packageName: string } => !!t.packageName)
        .map((t) => ({
          id: t.id,
          packageName: t.packageName,
          agentDependencies: t.agentDependencies,
          connectorDependencies: t.connectorDependencies,
        }));
    },
    readCanonicalEdges: async (packageName) => {
      const rows = await readInstalledExtensionsByPackageName(packageName);
      // The edges are a fact of the (package, version) manifest; prefer a LIVE
      // (active|locked) row, falling back to any row for the package. ZERO rows
      // (a direct agent install that never went through the dispatcher) => no
      // canonical source => no-op.
      const live = rows.filter((r) => LIVE_STATUSES.has(r.status));
      const src = live[0] ?? rows[0];
      return src?.dependencies ?? [];
    },
    updateTemplateDeps: async (id, patch) => {
      await updateAgentTemplate(id, patch);
    },
    log: (m) => console.info(m),
  };
}
