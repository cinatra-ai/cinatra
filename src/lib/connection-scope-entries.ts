// ---------------------------------------------------------------------------
// /connectors scope-filter entries from REAL granted connections
// (cinatra#953 W3).
//
// Replaces the deleted hardcoded per-slug pseudo-scope map: a connector card's
// filterable scopes are now derived from the actor-visible `nango_connection`
// identity rows and their per-connection grant rows (polymorphic
// `extension_access_policy`, kind `connection`). PURE — the page loads the
// rows/policies (batched) and this module folds them into
// `NormalizedResourceScope` entries for the shared `scopeSelectionMatches`
// predicate.
//
// Semantics (codex round-0 converged):
//   • personal   → the ACTOR's own connections only. A foreign owner-only
//                  connection contributes NOTHING (it is invisible grant-wise).
//   • org/team/project selections → only connections whose stored grant names
//                  that CONCRETE locus (org:<id> / team:<id> / project:<id>).
//                  A `workspace` grant deliberately adds no locus entry — the
//                  default view already shows everything; a Team/Project/Org
//                  selection means "genuinely granted to that locus".
//   • admin      → connections whose grant is the admin visibility tier.
//   • legacy bare "org" grants bind to the identity row's own org id; a
//                  null-org row's bare grant contributes nothing (fail-closed
//                  — locusId undefined matches nothing).
//   • absent policy row → the connection kind's owner-default (never
//                  auto-shares): treated exactly like an "owner" grant.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type { NormalizedResourceScope } from "@/lib/scope-filter";

/** The slice of the identity row this module needs (keeps the fold pure). */
export type ConnectionScopeRow = {
  id: string;
  connectorPackageId: string;
  organizationId: string | null;
  ownerUserId: string;
};

/**
 * Fold the actor-visible connection rows + their grant rows into per-connector
 * scope entries. Returns a map: connectorPackageId → entries[]. The "use" tier
 * (`runDataVisibility` — the same field the uniform evaluator maps the `use`
 * op to) is the visibility that decides the entry.
 */
export function buildConnectionScopeEntries(
  rows: ConnectionScopeRow[],
  policies: ReadonlyMap<string, AgentAuthPolicy>,
  actorUserId: string | null,
): Map<string, NormalizedResourceScope[]> {
  const out = new Map<string, NormalizedResourceScope[]>();
  const push = (packageId: string, entry: NormalizedResourceScope) => {
    const existing = out.get(packageId);
    if (existing) existing.push(entry);
    else out.set(packageId, [entry]);
  };

  for (const row of rows) {
    const isOwn = actorUserId !== null && row.ownerUserId === actorUserId;
    // The actor's own connection is always personally theirs, whatever they
    // shared it as.
    if (isOwn) push(row.connectorPackageId, { locus: "personal" });

    const visibility = policies.get(row.id)?.runDataVisibility ?? "owner";
    if (visibility === "owner") continue; // owner-only: nothing beyond personal
    if (visibility === "workspace") continue; // broad grant — default view only
    if (visibility === "admin") {
      push(row.connectorPackageId, { locus: "workspace", adminOnly: true });
      continue;
    }
    if (visibility === "org") {
      // Legacy bare token: binds to the row's own org; null-org rows
      // contribute nothing (locusId undefined matches nothing — fail-closed).
      push(row.connectorPackageId, {
        locus: "organization",
        locusId: row.organizationId ?? undefined,
      });
      continue;
    }
    if (visibility.startsWith("org:")) {
      push(row.connectorPackageId, {
        locus: "organization",
        locusId: visibility.slice("org:".length),
      });
      continue;
    }
    if (visibility.startsWith("team:")) {
      push(row.connectorPackageId, {
        locus: "team",
        locusId: visibility.slice("team:".length),
      });
      continue;
    }
    if (visibility.startsWith("project:")) {
      push(row.connectorPackageId, {
        locus: "project",
        locusId: visibility.slice("project:".length),
      });
      continue;
    }
    // Unknown token shape: contribute nothing (fail-closed).
  }
  return out;
}
