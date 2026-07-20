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

// ---------------------------------------------------------------------------
// Mutability class — the per-claim disposition that names HOW a claimed type's
// rows may change (cinatra#1449, epic #1448 principle 4). This leaf owns the
// VOCABULARY only; the disposition-enforcing write policy (trusted transition
// commands, the draftable draft→scheduled→published state machine + publish
// receipts, the external linked→stale→dangling reference lifecycle) lives at
// the object write path and its owners — the publication-operation ledger
// (#1450) and the connectorRef external-pointer lifecycle (#1451) — which
// CONSUME this vocabulary and the narrowing rule below.
//
//   - draftable: cinatra-authored; content edits (new revisions / ref-swap)
//     are allowed only while a row is a draft, then it locks. Publishing rides
//     the publication-operation ledger and never rewrites the type into the
//     external entity. There is no direct draft→published edge.
//   - record: create-only, self-contained, immutable — any post-create update
//     to a claimed row is rejected.
//   - external: a connector-owned pointer to third-party-canonical content;
//     rows are written by connector sync only and are never pinnable (pin the
//     snapshot record instead — enforced on the disposition union below).
// ---------------------------------------------------------------------------
export const ARTIFACT_MUTABILITY_CLASSES = ["draftable", "record", "external"] as const;
export type ArtifactMutability = (typeof ARTIFACT_MUTABILITY_CLASSES)[number];

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
// The optional `mutability` class (cinatra#1449) is a second, orthogonal
// disposition: it names how the claimed rows may change (see
// ARTIFACT_MUTABILITY_CLASSES) and carries one cross-field invariant enforced
// on the union — `external` rows are never pinnable.
// Strict objects: an unknown key is a validation error, never silently
// carried (fail-closed — dispositions gate write/serving behavior).
// ---------------------------------------------------------------------------

const sharedDispositionFields = {
  snapshotPolicy: z.enum(["content", "metadata", "none"]).default("none"),
  redactionPolicyVersion: z.string().min(1).optional(),
  sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
  // Per-claim mutability class (cinatra#1449). OPTIONAL: an absent value imposes
  // no claim-level narrowing — the registering type's own lifecycle.mutableBy
  // governs unchanged. A present class may only NARROW that baseline, never
  // widen it (validateMutabilityNarrowsBaseline). See ARTIFACT_MUTABILITY_CLASSES
  // above for the per-class semantics; enforcement is the write path's concern.
  mutability: z.enum(ARTIFACT_MUTABILITY_CLASSES).optional(),
};

export const claimDispositionsSchema = z
  .discriminatedUnion("projection", [
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
  ])
  .superRefine((val, ctx) => {
    // An `external` claim points at live third-party-canonical content; the
    // pointer is never pinned — pin the immutable snapshot record instead
    // (epic #1448 principle 4). `projection:"none"` already forces
    // pinnable:false; this closes the raw / artifact-safe external case.
    if (val.mutability === "external" && val.pinnable !== false) {
      ctx.addIssue({
        code: "custom",
        path: ["pinnable"],
        message:
          "external mutability requires pinnable:false — pin the snapshot record, not the live pointer",
      });
    }
  });

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
// Baseline-narrowing rule (cinatra#1449) — the SINGLE pure statement of "a claim
// disposition may only NARROW the registering type's lifecycle.mutableBy, never
// widen it". The object write path consumes both helpers (it is the enforcer;
// this leaf is side-effect-free). `mutableBy` is the (agent|user) vocabulary
// from ObjectLifecycle in ./types — restated inline here so this leaf keeps its
// zero-import purity (the same reason ArtifactObjectTypeClaim restates the claim
// shape structurally rather than importing this schema).
// ---------------------------------------------------------------------------

/** The (agent|user) principals ObjectLifecycle.mutableBy enumerates. */
export type ObjectMutator = "agent" | "user";

/**
 * The effective post-create mutable-principal ceiling a mutability class imposes
 * on the registering type's baseline `mutableBy`:
 *   - record / external → [] (no agent/user post-create mutation; an external
 *     row changes only via connector sync, a channel outside this vocabulary),
 *   - draftable, or no class declared → the baseline unchanged (its principals
 *     may edit — the write path additionally gates draftable edits to the draft
 *     state; that STATE gating is not encoded here).
 * The result is always a subset of `baselineMutableBy`, so a mutability class can
 * only ever remove principals, never add one. Pure — no I/O.
 */
export function effectiveMutableBy(
  mutability: ArtifactMutability | undefined,
  baselineMutableBy: readonly ObjectMutator[],
): ObjectMutator[] {
  if (mutability === "record" || mutability === "external") return [];
  return [...baselineMutableBy];
}

/**
 * Validate that a mutability class NARROWS (never widens) the registering type's
 * baseline `mutableBy`. `record` / `external` narrow every baseline (their
 * ceiling is empty). `draftable` adds no principal, but declaring it over a
 * fully-immutable type (`mutableBy: []`) would widen — draftable grants
 * draft-state edits a create-only type forbids — so that pairing is rejected.
 * Returns a human-readable violation string, or null when the class is a legal
 * narrowing. Pure — the caller (write path) supplies the type's baseline.
 */
export function validateMutabilityNarrowsBaseline(
  mutability: ArtifactMutability,
  baselineMutableBy: readonly ObjectMutator[],
): string | null {
  if (mutability === "draftable" && baselineMutableBy.length === 0) {
    return (
      "mutability 'draftable' widens an immutable type (mutableBy: []) — " +
      "draftable permits draft-state edits the type baseline forbids"
    );
  }
  return null;
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

// ---------------------------------------------------------------------------
// PERMANENT namespace tombstones (cinatra#1789, epic #1785). The two retired
// dynamic prefixes — INLINED (not imported from ./namespace) so this policy
// leaf keeps its zero-non-zod-imports invariant, the same reason
// CLAIMED_OBJECT_TYPE_ID_RE mirrors OBJECT_TYPE_NAMESPACE_RE. The namespace
// test (`namespace-tombstones.test.ts`) pins this array byte-equal to
// TOMBSTONED_OBJECT_TYPE_ID_PREFIXES in ./namespace (the single canonical
// declaration), so the mirror can never silently diverge.
// ---------------------------------------------------------------------------

/** The permanently-tombstoned object-type id prefixes (mirror of ./namespace
 * `TOMBSTONED_OBJECT_TYPE_ID_PREFIXES`, pinned equal by test). Prefix-exact —
 * a look-alike scope like `@dynamics/...` is NOT tombstoned. */
export const TOMBSTONED_CLAIMED_TYPE_PREFIXES = [
  "@dynamic/types:",
  "@cinatra-ai/dynamic:",
] as const;

/** True when a claimed/registered object-type id is under a permanently-
 * tombstoned dynamic namespace (mirrors `isTombstonedObjectTypeId` in
 * ./namespace). The manifest claim schema below, the registration bridge, and
 * the claim-store write path all reject on this. */
export function isTombstonedClaimedTypeId(id: string): boolean {
  return (
    typeof id === "string" &&
    TOMBSTONED_CLAIMED_TYPE_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}

/** The canonical named rejection for a tombstoned claimed/registered type —
 * emitted identically by the manifest-validation refine and the claim-store
 * write guard so every caller sees the same named error. */
export function tombstonedClaimedTypeMessage(id: string): string {
  return (
    `tombstoned object type '${id}': the '@dynamic/types:' and legacy ` +
    `'@cinatra-ai/dynamic:' namespaces are permanently retired (cinatra#1789) ` +
    `and can never be claimed or registered`
  );
}

export const artifactObjectTypeClaimManifestSchema = z.strictObject({
  /** The claimed object type id (`@scope/package:local-id`). Rejected when it
   * falls under a permanently-tombstoned dynamic namespace (cinatra#1789) — a
   * well-formed id like `@dynamic/types:invoice` passes the regex but is a
   * retired namespace, so the refine names the tombstone. */
  type: z
    .string()
    .regex(CLAIMED_OBJECT_TYPE_ID_RE, {
      message: "claimed object type must be a namespaced id (@scope/package:local-id)",
    })
    .superRefine((id, ctx) => {
      if (isTombstonedClaimedTypeId(id)) {
        ctx.addIssue({ code: "custom", message: tombstonedClaimedTypeMessage(id) });
      }
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
 * Map a resolved WINNING claim to its projection disposition, with the
 * fail-closed semantics for claim-backed binding (cinatra#1427/#1436) — the
 * single statement of "how does a winning CLAIM project" for the claim-based
 * host-type binding path, so that path can never encode a different fail-closed
 * default:
 *   - dispositions == null  -> 'artifact-safe' (the default)
 *   - VALID dispositions     -> the parsed `projection`
 *   - INVALID dispositions   -> 'artifact-safe' (fail closed DOWN to the
 *     metadata-only projection, never UP to raw)
 * Pure — no winner resolution, no I/O.
 *
 * Retained past the epic#1785 wave-A5 retirement: still consumed live by the
 * host-type claim binding path (resolve-bound-artifact-type) — see the deviation
 * note. The four graphiti/recall disposition consumers no longer compose this;
 * they read the type-driven registry resolver (A1). The now-dead
 * projection-arbitration wrapper that composed this with resolveClaimWinner
 * (`resolveClaimProjectionDisposition`) was deleted in A5.
 */
export function claimWinnerProjectionDisposition(
  winner: Pick<ArbitrableClaim, "dispositions">,
): "raw" | "artifact-safe" | "none" {
  if (winner.dispositions == null) return "artifact-safe";
  const parsed = parseClaimDispositions(winner.dispositions);
  return parsed.ok ? parsed.dispositions.projection : "artifact-safe";
}
