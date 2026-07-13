import { z } from "zod";

// ---------------------------------------------------------------------------
// Artifact-type claims — the PURE policy leaf (cinatra#1425, epic #1424).
//
// Claims are DB state (`artifact_type_claims`, written by the host claim
// store in src/lib/objects/artifact-claim-store.ts); THIS module holds the
// side-effect-free vocabulary + arbitration the store and the effective
// type catalog resolver share:
//
//   - the status / kind / scope value sets (a schema contract mirrored by the
//     DDL in src/lib/artifact-claim-schema.ts — the schema test asserts they
//     stay in sync),
//   - the dispositions payload validator (a strict discriminated union),
//   - kind-over-scope precedence and winner resolution
//     (dedicated-org > dedicated-platform > default-org > default-platform),
//   - the default-claim domination rule behind dormancy/reactivation.
//
// Zero React / DB / server-only imports — safe anywhere.
// ---------------------------------------------------------------------------

export const ARTIFACT_CLAIM_KINDS = ["dedicated", "default"] as const;
export type ArtifactClaimKind = (typeof ARTIFACT_CLAIM_KINDS)[number];

export const ARTIFACT_CLAIM_STATUSES = [
  "reserved",
  "active",
  "dormant",
  "retiring",
  "retired",
] as const;
export type ArtifactClaimStatus = (typeof ARTIFACT_CLAIM_STATUSES)[number];

export const ARTIFACT_CLAIM_EVENTS = [
  "reserve",
  "activate",
  "retire",
  "winner-change",
] as const;
export type ArtifactClaimEvent = (typeof ARTIFACT_CLAIM_EVENTS)[number];

/** `'platform'` or `org:<id>` — the two claim-bearing owner levels. */
export type ArtifactClaimScope = string;

export const PLATFORM_CLAIM_SCOPE = "platform";
export const ORG_CLAIM_SCOPE_PREFIX = "org:";

export function orgClaimScope(orgId: string): string {
  return `${ORG_CLAIM_SCOPE_PREFIX}${orgId}`;
}

export function isValidClaimScope(scope: string): boolean {
  return (
    scope === PLATFORM_CLAIM_SCOPE ||
    (scope.startsWith(ORG_CLAIM_SCOPE_PREFIX) && scope.length > ORG_CLAIM_SCOPE_PREFIX.length)
  );
}

// ---------------------------------------------------------------------------
// Dispositions — claim payload, validated as a strict union.
//
// The projection discriminant decides the member shape: a claim whose rows
// never project (`projection: "none"`) cannot be pinnable (context pinning
// snapshots at resolution time — nothing to snapshot for a never-projected
// type). The snapshotPolicy / sensitivity vocabularies are the FOUNDATION
// set; the pinning + projection sub-issues consume (and may extend) them.
// Strict objects: an unknown key is a validation error, never silently
// carried (fail-closed — dispositions gate write/serving behavior).
// ---------------------------------------------------------------------------

const sharedDispositionFields = {
  snapshotPolicy: z.enum(["content", "metadata", "none"]).default("none"),
  redactionPolicyVersion: z.string().min(1).optional(),
  sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
};

export const claimDispositionsSchema = z.discriminatedUnion("projection", [
  z.strictObject({
    projection: z.literal("raw"),
    pinnable: z.boolean().default(false),
    ...sharedDispositionFields,
  }),
  z.strictObject({
    projection: z.literal("artifact-safe"),
    pinnable: z.boolean().default(false),
    ...sharedDispositionFields,
  }),
  z.strictObject({
    projection: z.literal("none"),
    // Never-projected rows cannot be pinned into context.
    pinnable: z.literal(false).default(false),
    ...sharedDispositionFields,
  }),
]);

export type ClaimDispositions = z.infer<typeof claimDispositionsSchema>;

/**
 * Validate a dispositions payload. Returns the parsed value or an error list
 * (never throws) — reserve-time validation fails the claim write; read-time
 * validation (the catalog resolver) fails closed to `null`.
 */
export function parseClaimDispositions(
  value: unknown,
): { ok: true; dispositions: ClaimDispositions } | { ok: false; errors: string[] } {
  const parsed = claimDispositionsSchema.safeParse(value);
  if (parsed.success) return { ok: true, dispositions: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

// ---------------------------------------------------------------------------
// Manifest `objectTypes` claim entries (cinatra#1432).
//
// A `kind:"artifact"` extension declares claims over TYPED object rows in its
// manifest: `cinatra.artifact.objectTypes` is an array of these entries. The
// ENTRY schema lives here in the pure policy leaf so the canonical semantic
// manifest (packages/objects/src/semantic-manifest.ts) and the extensions
// handler's byte-mirrored descriptor copy
// (packages/extensions/src/artifact-handler.ts) both consume ONE schema —
// the mirrored field line referencing it is pinned byte-identical by the
// lock-step test. Strict objects, fail-closed: claims gate install/serving
// behavior, so an unknown key is a validation error, never carried.
// ---------------------------------------------------------------------------

/** `@scope/package:local-id` — mirrors OBJECT_TYPE_NAMESPACE_RE
 * (./namespace.ts) without importing the registry-adjacent module so this
 * leaf keeps zero non-zod imports. The namespace test pins the two regexes
 * equal. */
export const CLAIMED_OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

export const artifactObjectTypeClaimManifestSchema = z.strictObject({
  /** The claimed object type id (`@scope/package:local-id`). */
  type: z.string().regex(CLAIMED_OBJECT_TYPE_ID_RE, {
    message: "claimed object type must be a namespaced id (@scope/package:local-id)",
  }),
  /** Claim kind — arbitration is kind-over-scope (see claimPrecedenceRank). */
  claim: z.enum(ARTIFACT_CLAIM_KINDS),
  /** Per-claim disposition payload (projection/pinnable/snapshot/redaction/
   * sensitivity) — the same strict union the claim registry validates at
   * reserve time. Optional: an absent payload defers to platform defaults. */
  dispositions: claimDispositionsSchema.optional(),
  /** Inline JSON Schema for the claimed type's rows — REQUIRED unless the
   * claimant itself registers the type or declares a manifest dependency on
   * the registering extension (validateObjectTypeClaimSchemaSources). */
  schema: z.record(z.string(), z.unknown()).optional(),
});

export type ArtifactObjectTypeClaimManifest = z.infer<
  typeof artifactObjectTypeClaimManifestSchema
>;

/** The package that REGISTERS a claimed type: the namespace of its id
 * (`@scope/pkg:slug` → `@scope/pkg`). */
export function claimedTypeRegisteringPackage(objectTypeId: string): string | null {
  const idx = objectTypeId.indexOf(":");
  if (idx <= 0) return null;
  const pkg = objectTypeId.slice(0, idx);
  return /^@[\w-]+\/[\w-]+$/.test(pkg) ? pkg : null;
}

/**
 * The third-party schema-source rule (cinatra#1432 AC-4, fail-closed): every
 * claimed type must have a resolvable row schema at validation time — an
 * inline JSON Schema shipped IN the claim, OR the claimant IS the registering
 * package (self-namespaced type), OR the manifest declares a dependency on
 * the registering extension (`cinatra.dependencies` — the same edges the
 * production acquisition lock set already carries). A claim with none of the
 * three is rejected. Pure: callers pass the declared dependency package
 * names; no fs/DB here.
 */
export function validateObjectTypeClaimSchemaSources(input: {
  packageName: string;
  claims: readonly Pick<ArtifactObjectTypeClaimManifest, "type" | "schema">[];
  dependencyPackageNames: readonly string[];
}): string[] {
  const errors: string[] = [];
  const deps = new Set(input.dependencyPackageNames);
  for (const claim of input.claims) {
    if (claim.schema !== undefined) continue;
    const registrant = claimedTypeRegisteringPackage(claim.type);
    if (registrant == null) {
      errors.push(`objectTypes claim '${claim.type}': not a namespaced object type id`);
      continue;
    }
    if (registrant === input.packageName) continue; // self-registered type
    if (deps.has(registrant)) continue; // registering extension is a declared dependency
    errors.push(
      `objectTypes claim '${claim.type}' has no schema source: ship a JSON Schema in the claim ` +
        `or declare a cinatra.dependencies entry on the type-registering extension '${registrant}'`,
    );
  }
  return errors;
}

/**
 * Validate a manifest `objectTypes` array (structure only — the schema-source
 * rule needs the dependency list and runs separately). Returns parsed entries
 * or a flat error list (never throws). Duplicate claimed types within one
 * manifest are rejected: one extension never races itself for a type.
 */
export function parseArtifactObjectTypeClaims(
  value: unknown,
): { ok: true; claims: ArtifactObjectTypeClaimManifest[] } | { ok: false; errors: string[] } {
  const parsed = z.array(artifactObjectTypeClaimManifestSchema).min(1).safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const seen = new Set<string>();
  for (const claim of parsed.data) {
    if (seen.has(claim.type)) {
      return { ok: false, errors: [`duplicate objectTypes claim for '${claim.type}'`] };
    }
    seen.add(claim.type);
  }
  return { ok: true, claims: parsed.data };
}

// ---------------------------------------------------------------------------
// Arbitration — kind-over-scope precedence.
// ---------------------------------------------------------------------------

/** The claim fields arbitration needs (a projection of an artifact_type_claims row). */
export interface ArbitrableClaim {
  id: string;
  scope: ArtifactClaimScope;
  objectTypeId: string;
  claimKind: ArtifactClaimKind;
  status: ArtifactClaimStatus;
  extensionPackage: string;
  extensionVersion: string;
  generation: number;
  dispositions?: unknown;
}

/**
 * Precedence rank for an org's view — LOWER wins. Kind dominates scope:
 *   0 dedicated-org > 1 dedicated-platform > 2 default-org > 3 default-platform.
 * Returns null when the claim is out of the org's scope chain (another org's
 * claim never ranks).
 */
export function claimPrecedenceRank(
  claim: Pick<ArbitrableClaim, "claimKind" | "scope">,
  orgId: string,
): number | null {
  const isOrg = claim.scope === orgClaimScope(orgId);
  const isPlatform = claim.scope === PLATFORM_CLAIM_SCOPE;
  if (!isOrg && !isPlatform) return null;
  if (claim.claimKind === "dedicated") return isOrg ? 0 : 1;
  return isOrg ? 2 : 3;
}

/** A claim currently occupies its scope's winner slot while active or winding
 * down ('retiring' keeps the current generation the winner until 'retired' —
 * epic #1424 transition safety). */
export function isWinnerEligible(status: ArtifactClaimStatus): boolean {
  return status === "active" || status === "retiring";
}

/**
 * Resolve the winning claim for one object type in one org's view.
 * Deterministic: within the org's scope chain at most ONE winner-eligible
 * claim exists per rank — the one-live-claimant partial unique indexes
 * (`artifact_type_claims_one_live_dedicated` /
 * `..._one_live_default`) forbid two live same-kind claims at one scope key,
 * and a rank encodes (kind, scope-class), so a same-rank overlap is
 * structurally impossible. The generation/id fallback below is pure
 * defense-in-depth determinism for data that violates those invariants
 * (e.g. a hand-edited registry), never a load-bearing tie-break.
 */
export function resolveClaimWinner<T extends ArbitrableClaim>(
  claims: readonly T[],
  input: { orgId: string; objectTypeId: string },
): T | null {
  let winner: T | null = null;
  let winnerRank = Number.POSITIVE_INFINITY;
  for (const claim of claims) {
    if (claim.objectTypeId !== input.objectTypeId) continue;
    if (!isWinnerEligible(claim.status)) continue;
    const rank = claimPrecedenceRank(claim, input.orgId);
    if (rank == null) continue;
    if (
      rank < winnerRank ||
      (rank === winnerRank &&
        winner != null &&
        (claim.generation > winner.generation ||
          (claim.generation === winner.generation && claim.id < winner.id)))
    ) {
      winner = claim;
      winnerRank = rank;
    }
  }
  return winner;
}

/**
 * The domination rule behind default-claim dormancy (the SQL in the claim
 * store mirrors this — kept here as the single documented statement):
 *
 *   - a DEFAULT claim at `platform` is totally dominated only by a live
 *     dedicated claim at `platform` (an org-scoped dedicated claim shadows it
 *     for that org only — the platform default still serves every other org);
 *   - a DEFAULT claim at `org:X` is totally dominated by a live dedicated
 *     claim at `org:X` OR at `platform`.
 *
 * "Live" here = winner-eligible ('active' | 'retiring'). Only a TOTALLY
 * dominated default claim transitions to 'dormant'; it reactivates (new
 * generation) when the dominating dedicated claim retires.
 */
export function isDefaultClaimDominated(
  defaultClaim: Pick<ArbitrableClaim, "scope" | "objectTypeId" | "claimKind">,
  claims: readonly ArbitrableClaim[],
): boolean {
  if (defaultClaim.claimKind !== "default") return false;
  return claims.some(
    (c) =>
      c.objectTypeId === defaultClaim.objectTypeId &&
      c.claimKind === "dedicated" &&
      isWinnerEligible(c.status) &&
      (c.scope === defaultClaim.scope ||
        (defaultClaim.scope !== PLATFORM_CLAIM_SCOPE && c.scope === PLATFORM_CLAIM_SCOPE)),
  );
}
