/**
 * The per-scope tab ROW BUILDERS (cinatra#2808, per-scope surfaces S2).
 *
 * The eligibility loader answers WHICH packages a scope reaches; this module
 * turns that answer into the two tabs' row models — and it is the ONE place the
 * scope's addresses are attached, always from #2809's own contract
 * (`scope-surfaces.ts`), never composed here.
 *
 * PURE, and deliberately free of a VALUE import of `@/lib/scope-filter`: the
 * assistants directory resolver sits in the reachable graph of /chat and the
 * a2a / llm-bridge / mcp API routes, all route-graph-ratcheted, so its scope
 * predicate is INJECTED (`AssistantsDirectoryOptions.scopeMatch`) and only the
 * erased type crosses the boundary. `scopeSurfaceScopeMatch` mints exactly that
 * predicate for a viewed scope, and it imports `NormalizedResourceScope` as a
 * TYPE only, for the same reason the resolver does.
 */
import type { AgentRunRowModel } from "@cinatra-ai/agents/agent-run-client";
import type { ScopeAssistantRow } from "@/components/scope/scope-assistants-tab";
import type { NormalizedResourceScope } from "@/lib/scope-filter";
import type { ScopeEligibilityRow } from "@/lib/scope-surface-eligibility";
import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

/**
 * The Agents tab's rows: "Non-assistant agent packages, `active|locked`."
 *
 * The row model is `AgentRunRowModel` — the SAME one `AgentRunClient` renders on
 * /agents — extended by name with the scope's Settings href, the version and
 * the status. `detailHref` is deliberately NULL: this surface is member-facing,
 * and no member-facing surface renders a link into `/configuration` (epic
 * #2699), so "More details" opens the ratified modal from its own button.
 */
export function buildScopeAgentRows(
  scope: ScopeSurfaceRef,
  rows: readonly ScopeEligibilityRow[],
): AgentRunRowModel[] {
  return rows
    .filter((row) => !row.isAssistant)
    .map((row) => ({
      key: row.packageName,
      name: row.displayName,
      description: row.description ?? "",
      // Every package listed here is a Cinatra-hosted install of this tenant —
      // an external A2A agent has no install row to be eligible through.
      host: "local" as const,
      // The picker's free-text filter reads name and description only; a scope
      // row advertises no skill list of its own.
      skills: [],
      packageName: row.packageName,
      detailHref: null,
      runHref: scopeSurfaceAgentLaunchHref(scope, row.packageName),
      settingsHref: scopeSurfaceAgentSettingsHref(scope, row.packageName),
      version: row.version,
      status: row.status,
    }));
}

/** The directory resolver's row, as much of it as this builder reads. */
export type ScopeAssistantDirectoryRow = {
  packageName: string;
  vendor: string;
  slug: string;
  displayName: string;
  description?: string | null;
  localChatHref: string;
  remoteInstances: readonly {
    instanceId: string;
    name: string;
    localChatHref: string;
    remoteHref: string;
  }[];
};

/**
 * The Assistants tab's rows: the directory resolver's own rows — its Chat
 * affordances preserved exactly — re-addressed at the viewed scope and extended
 * with the Settings href and the installed-card fields.
 *
 * A directory row the scope's eligibility does not admit is dropped: the
 * resolver answers what the ACTOR may reach, and a scope tab shows the
 * intersection with what the SCOPE reaches.
 */
export function buildScopeAssistantRows(
  scope: ScopeSurfaceRef,
  directoryRows: readonly ScopeAssistantDirectoryRow[],
  eligibility: readonly ScopeEligibilityRow[],
): ScopeAssistantRow[] {
  const byPackage = new Map(
    eligibility.filter((row) => row.isAssistant).map((row) => [row.packageName, row]),
  );
  const rows: ScopeAssistantRow[] = [];
  for (const row of directoryRows) {
    const eligible = byPackage.get(row.packageName);
    if (!eligible) continue;
    const assistant = { vendor: row.vendor, slug: row.slug };
    rows.push({
      packageName: row.packageName,
      vendor: row.vendor,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description ?? eligible.description,
      version: eligible.version,
      status: eligible.status,
      localChatHref: scopeSurfaceAssistantLaunchHref(scope, assistant),
      settingsHref: scopeSurfaceAssistantSettingsHref(scope, assistant),
      remoteInstances: row.remoteInstances.map((instance) => ({
        instanceId: instance.instanceId,
        name: instance.name,
        // The site-scoped chat moves INSIDE the scope; the jump-out is the
        // connected site's own URL and is never re-based.
        localChatHref: scopeSurfaceAssistantLaunchHref(scope, {
          ...assistant,
          instance: instance.instanceId,
        }),
        remoteHref: instance.remoteHref,
      })),
    });
  }
  return rows;
}

/**
 * THE INJECTED PREDICATE. Does a directory row's scope footprint reach the
 * VIEWED scope?
 *
 * An `adminOnly` grant never matches: a scope tab is member-facing, and the
 * eligibility loader's vantage arm refuses the `admin` tier for the same
 * reason — a scope holds no admin standing.
 */
export function scopeSurfaceScopeMatch(
  scope: ScopeSurfaceRef,
): (entries: readonly NormalizedResourceScope[]) => boolean {
  return (entries) =>
    entries.some((entry) => {
      if (entry.adminOnly) return false;
      // A workspace-locus grant is tenant-wide: every scope of the tenant
      // reaches it.
      if (entry.locus === "workspace") return true;
      // A personal scope has exactly one member — the actor — and the resolver
      // has already narrowed to what that actor may reach, so nothing further
      // is withheld there.
      if (scope.kind === "personal" || scope.kind === "workspace") return true;
      return entry.locus === scope.kind && entry.locusId === scope.id;
    });
}
