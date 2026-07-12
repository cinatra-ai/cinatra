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
 * Deterministic: within the org's scope chain at most one winner-eligible
 * claim exists per rank (the partial-unique ACTIVE index guarantees one
 * active claim per scope key; kinds at the same scope share that slot).
 * Ties (transiently possible while a retiring claim overlaps a newly active
 * one at the same rank) break by lower generation age — newest activation
 * wins — then by id for total determinism.
 */
export function resolveClaimWinner(
  claims: readonly ArbitrableClaim[],
  input: { orgId: string; objectTypeId: string },
): ArbitrableClaim | null {
  let winner: ArbitrableClaim | null = null;
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
