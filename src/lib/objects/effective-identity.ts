import "server-only";

// ---------------------------------------------------------------------------
// Effective-identity resolver — the HOST half (epic #1785).
//
// Identity is now TYPE-DRIVEN (the pure @cinatra-ai/objects leaf): a row's
// effective identity is the namespace-defining extension of its object type,
// installed — no per-org claim arbitration, no binding/classic precedence, no
// install-scoped gating, no default-artifact floor. The host half therefore no
// longer reads `artifact_type_claims` or `installed_extension` for identity;
// it only reads `semantic_assertion` for the raw eligible-extension SUMMARY set
// (`eligibleExtensions`) the artifact surfaces still display. That table is
// KEPT legacy plumbing (the context-selection write path still persists rows)
// until the A6 purge.
//
// All reads are SYNC (runPostgresQueriesSync) so the artifact service's sync
// read paths can adopt the service without an async ripple.
// ---------------------------------------------------------------------------

import {
  resolveEffectiveIdentity,
  type EffectiveIdentity,
} from "@cinatra-ai/objects/effective-identity";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

export type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

/** Per-artifact identity enrichment the artifact surfaces consume: the
 * type-driven resolved identity plus the raw eligible-extension set (every
 * active eligible extension asserted for the row, read from
 * `semantic_assertion`). */
export interface ArtifactIdentityEnrichment {
  identity: EffectiveIdentity;
  eligibleExtensions: string[];
}

type Row = Record<string, unknown>;
const q = (): string => postgresSchema.replaceAll('"', '""');

/**
 * Resolve effective identity + enrichment for a page of artifact rows.
 * Identity is a pure per-row registry lookup (no DB); one batched
 * `semantic_assertion` query fetches the eligible-extension summary set for the
 * whole page (avoiding N+1). Empty input ⇒ empty map.
 */
export function resolveArtifactEffectiveIdentities(input: {
  orgId: string;
  rows: ReadonlyArray<{ id: string; type: string }>;
}): Map<string, ArtifactIdentityEnrichment> {
  const out = new Map<string, ArtifactIdentityEnrichment>();
  if (input.rows.length === 0) return out;
  ensurePostgresSchema();

  // Raw eligible-extension summary set for the whole page (bindings + classics;
  // eligible only — drafts and archived rows excluded). A read error FAILS
  // CLOSED to an empty set (the summary degrades to "no eligible extensions",
  // never throws through the read path).
  const eligibleByArtifact = new Map<string, string[]>();
  try {
    const r = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT artifact_id, extension
FROM "${q()}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = ANY($2::text[]) AND eligibility = 'eligible'
ORDER BY artifact_id, asserted_at, extension`,
          values: [input.orgId, input.rows.map((row) => row.id)],
        },
      ],
    });
    for (const row of (r?.[0]?.rows ?? []) as Row[]) {
      const artifactId = String(row.artifact_id);
      const list = eligibleByArtifact.get(artifactId);
      if (list) list.push(String(row.extension));
      else eligibleByArtifact.set(artifactId, [String(row.extension)]);
    }
  } catch {
    // fail-closed: no eligible-extension summary.
  }

  for (const row of input.rows) {
    out.set(row.id, {
      identity: resolveEffectiveIdentity(row.type),
      eligibleExtensions: eligibleByArtifact.get(row.id) ?? [],
    });
  }
  return out;
}

/** Singular convenience wrapper over the batched resolver. */
export function resolveArtifactEffectiveIdentity(input: {
  orgId: string;
  artifactId: string;
  baseType: string;
}): ArtifactIdentityEnrichment {
  const map = resolveArtifactEffectiveIdentities({
    orgId: input.orgId,
    rows: [{ id: input.artifactId, type: input.baseType }],
  });
  return (
    map.get(input.artifactId) ?? {
      identity: resolveEffectiveIdentity(input.baseType),
      eligibleExtensions: [],
    }
  );
}
