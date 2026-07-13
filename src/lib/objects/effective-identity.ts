import "server-only";

// ---------------------------------------------------------------------------
// Effective-identity resolver — the HOST half (cinatra#1426, epic #1424).
//
// Reads the DB state one artifact identity depends on and hands it to the
// PURE truth-table leaf (@cinatra-ai/objects/effective-identity):
//   - `semantic_assertion` ACTIVE rows (bindings + classics, batched),
//   - the org's claim registry rows → `resolveClaimWinner` per base type
//     (read ONLY when a non-generic base type appears — the generic artifact
//     type is never claimed, so plain artifact list/get never touches the
//     claim registry),
//   - live `installed_extension` rows for every extension the resolution
//     might name (identity requires an INSTALLED extension — the "ungoverned
//     = allowed" allowance of artifact-extension-access does NOT apply to
//     identity; cinatra#1426).
//
// Install semantics are TWO-TIERED, mirroring the #1425 access gates:
//   - a CLASSIC assertion's extension is installed iff a live
//     (`active`|`locked`) kind:'artifact' row governs the org — org-owned or
//     ambient (organizationId IS NULL) — the package-level check
//     (`canAccessArtifactExtension`'s row pick, minus the actor half);
//   - a CLAIM WINNER is installed iff its CLAIM-SCOPED install governs
//     (mirrors `canActorAccessClaimedArtifactExtension` row selection): a
//     claim BOUND to an install (`installId`) validates ONLY through that
//     exact live row when it governs the claim's scope; an UNBOUND claim
//     needs a live row governing its exact scope (`org:<id>` → that org's
//     row; `platform` → an ambient row). A sibling install can never
//     re-activate a claim whose bound install is gone (no cross-scope bleed).
//
// Identity is ORG-level truth (the winner never varies per actor); actor
// visibility of claims stays the effective type catalog's job. All reads are
// SYNC (runPostgresQueriesSync) so the artifact service's sync read paths can
// adopt the service without an async ripple.
// ---------------------------------------------------------------------------

import { resolveClaimWinner } from "@cinatra-ai/objects/claims";
import {
  GENERIC_ARTIFACT_OBJECT_TYPE,
  resolveEffectiveIdentity,
  type AssertionBasis,
  type EffectiveIdentity,
  type IdentityAssertion,
} from "@cinatra-ai/objects/effective-identity";
// Pure-data floor constant — the ONE exemption from the install requirement:
// the default-artifact floor is a system extension, present in every universe.
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import {
  readArtifactTypeClaimsForOrg,
  type ArtifactTypeClaimRow,
} from "@/lib/objects/artifact-claim-store";

export type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

/** Per-artifact identity enrichment the artifact surfaces consume: the
 * resolved identity plus the raw eligible-extension set (unchanged summary
 * semantics — every active eligible extension, floor included). */
export interface ArtifactIdentityEnrichment {
  identity: EffectiveIdentity;
  eligibleExtensions: string[];
}

type Row = Record<string, unknown>;
const q = (): string => postgresSchema.replaceAll('"', '""');

function toIdentityAssertion(r: Row): IdentityAssertion & { artifactId: string } {
  return {
    artifactId: String(r.artifact_id),
    id: String(r.id),
    extension: String(r.extension),
    assertedBy: String(r.asserted_by),
    eligibility: String(r.eligibility),
    assertionBasis: String(r.assertion_basis) as AssertionBasis,
    bindingClaimId: r.binding_claim_id == null ? null : String(r.binding_claim_id),
    bindingGeneration: r.binding_generation == null ? null : Number(r.binding_generation),
    assertedAt: String(r.asserted_at),
  };
}

interface LiveInstallRow {
  id: string;
  packageName: string;
  organizationId: string | null;
}

/**
 * One batched live-install read for every candidate package: live
 * (`active`|`locked`) `kind:'artifact'` rows that are org-owned or ambient
 * (a row belonging to a DIFFERENT org can never govern this org's identity,
 * so it is filtered at the SQL). A read error FAILS CLOSED to "no live rows"
 * (identity degrades to the floor / plain object, never to an unproven
 * extension identity).
 */
function readLiveArtifactInstallRows(orgId: string, packages: readonly string[]): LiveInstallRow[] {
  if (packages.length === 0) return [];
  try {
    const r = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT id, package_name, organization_id FROM "${q()}"."installed_extension"
WHERE package_name = ANY($1::text[]) AND kind = 'artifact'
  AND status IN ('active','locked')
  AND (organization_id = $2 OR organization_id IS NULL)`,
          values: [packages, orgId],
        },
      ],
    });
    return ((r?.[0]?.rows ?? []) as Row[]).map((row) => ({
      id: String(row.id),
      packageName: String(row.package_name),
      organizationId: row.organization_id == null ? null : String(row.organization_id),
    }));
  } catch {
    return []; // fail-closed: cannot prove installed ⇒ INACTIVE for identity.
  }
}

/** Package-level install check for CLASSIC assertions: any live row governing
 * the org (org-owned or ambient). The floor extension is exempt. */
function classicInstalled(rows: readonly LiveInstallRow[], pkg: string): boolean {
  return pkg === DEFAULT_ARTIFACT_EXTENSION || rows.some((r) => r.packageName === pkg);
}

/** CLAIM-SCOPED install check for the winner (mirrors
 * `canActorAccessClaimedArtifactExtension` row selection, minus the actor
 * half): bound claim → the exact live row, and only while it governs the
 * claim's scope; unbound claim → a live row governing the exact scope. */
function claimWinnerInstalled(rows: readonly LiveInstallRow[], winner: ArtifactTypeClaimRow): boolean {
  if (winner.extensionPackage === DEFAULT_ARTIFACT_EXTENSION) return true; // system extension.
  const live = rows.filter((r) => r.packageName === winner.extensionPackage);
  const scopeOrgId = winner.scope.startsWith("org:") ? winner.scope.slice("org:".length) : null;
  const governsClaimScope = (r: LiveInstallRow): boolean =>
    scopeOrgId != null ? r.organizationId === scopeOrgId : r.organizationId == null;
  if (winner.installId) {
    const bound = live.find((r) => r.id === winner.installId) ?? null;
    return bound != null && governsClaimScope(bound);
  }
  return live.some(governsClaimScope);
}

/**
 * Resolve effective identity + enrichment for a page of artifact rows.
 * Batched: ONE assertion query, ONE claim-registry read (only when a
 * non-generic base type appears — the generic artifact type is never
 * claimed), ONE install query. Empty input ⇒ empty map.
 */
export function resolveArtifactEffectiveIdentities(input: {
  orgId: string;
  rows: ReadonlyArray<{ id: string; type: string }>;
}): Map<string, ArtifactIdentityEnrichment> {
  const out = new Map<string, ArtifactIdentityEnrichment>();
  if (input.rows.length === 0) return out;
  ensurePostgresSchema();

  // 1. ACTIVE assertions for the whole page (bindings + classics + drafts;
  // the pure leaf ignores drafts for identity, the enrichment filters to
  // eligible for the summary set).
  const r = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation, asserted_at
FROM "${q()}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = ANY($2::text[]) AND eligibility <> 'archived'
ORDER BY artifact_id, asserted_at`,
        values: [input.orgId, input.rows.map((row) => row.id)],
      },
    ],
  });
  const byArtifact = new Map<string, Array<IdentityAssertion & { artifactId: string }>>();
  for (const row of (r?.[0]?.rows ?? []) as Row[]) {
    const rec = toIdentityAssertion(row);
    const list = byArtifact.get(rec.artifactId);
    if (list) list.push(rec);
    else byArtifact.set(rec.artifactId, [rec]);
  }

  // 2. Claim winners per distinct NON-GENERIC base type (org-level
  // arbitration in the pure claims leaf). The generic artifact type is never
  // claimed, so a page of plain artifacts never touches the claim registry.
  const claimedTypes = Array.from(
    new Set(input.rows.map((row) => row.type).filter((t) => t !== GENERIC_ARTIFACT_OBJECT_TYPE)),
  );
  const winnerByType = new Map<string, ArtifactTypeClaimRow | null>();
  if (claimedTypes.length > 0) {
    const claims = readArtifactTypeClaimsForOrg(input.orgId);
    for (const typeId of claimedTypes) {
      winnerByType.set(typeId, resolveClaimWinner(claims, { orgId: input.orgId, objectTypeId: typeId }));
    }
  }

  // 3. One install read covering every extension the resolution might name:
  // classic-assertion extensions + claim-winner packages. The floor extension
  // is exempt (system extension) and never queried.
  const packagesToCheck = new Set<string>();
  for (const list of byArtifact.values()) {
    for (const a of list) {
      if (a.extension !== DEFAULT_ARTIFACT_EXTENSION) packagesToCheck.add(a.extension);
    }
  }
  for (const winner of winnerByType.values()) {
    if (winner && winner.extensionPackage !== DEFAULT_ARTIFACT_EXTENSION) {
      packagesToCheck.add(winner.extensionPackage);
    }
  }
  const installRows = readLiveArtifactInstallRows(input.orgId, Array.from(packagesToCheck));

  // 4. Pure truth-table resolution per row.
  for (const row of input.rows) {
    const assertions = byArtifact.get(row.id) ?? [];
    const winner = winnerByType.get(row.type) ?? null;
    const identity = resolveEffectiveIdentity({
      baseType: row.type,
      claimWinner: winner
        ? {
            claimId: winner.id,
            extensionPackage: winner.extensionPackage,
            claimKind: winner.claimKind,
            generation: winner.generation,
          }
        : null,
      claimWinnerInstalled: winner != null && claimWinnerInstalled(installRows, winner),
      assertions,
      isExtensionInstalled: (ext) => classicInstalled(installRows, ext),
    });
    out.set(row.id, {
      identity,
      eligibleExtensions: assertions
        .filter((a) => a.eligibility === "eligible")
        .map((a) => a.extension),
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
      identity: { kind: "default-artifact", selectable: false, assertionId: null },
      eligibleExtensions: [],
    }
  );
}
