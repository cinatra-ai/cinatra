import { DEFAULT_ARTIFACT_EXTENSION } from "./generated/artifact-floor";

// ---------------------------------------------------------------------------
// Effective-identity resolution — the PURE truth-table leaf (cinatra#1426,
// epic #1424).
//
// ONE resolution function, total over base type × claim × binding × classic
// assertions × install status. The DB rows live in `semantic_assertion`
// (`assertion_basis` discriminant: 'binding' | 'classic'; bindings carry the
// claim-activation generation) and `artifact_type_claims`; the host resolver
// in src/lib/objects/effective-identity.ts reads them and calls this leaf.
// Zero React / DB / server-only imports — safe anywhere (mirrors ./claims).
//
// The settled truth table (issue cinatra#1426; binding > classic; identity
// requires an INSTALLED extension):
//
//   | Base type            | Claim?             | Binding?    | Installed eligible classic? | Effective identity            |
//   |----------------------|--------------------|-------------|-----------------------------|-------------------------------|
//   | artifact:object      | n/a (never)        | never       | yes (highest precedence)    | that classic extension        |
//   | artifact:object      | n/a (never)        | never       | none (floor only)           | default artifact (floor)      |
//   | claimed typed row    | yes (dedicated)    | yes (valid) | maybe (coexists)            | the binding's extension       |
//   | claimed typed row    | yes (dedicated)    | not yet     | —                           | claim's ext, BROWSE ONLY (activation barrier) |
//   | typed row            | retired/uninstalled| archived    | yes                         | that classic extension        |
//   | typed row (no default coverage) | retired/uninstalled | archived | none              | plain object                  |
//   | objects:object / approved dynamic | dedicated retired → default reactivates | never | floor assertion | default artifact |
//   | objects:object / approved dynamic | default claim    | never       | floor assertion             | default artifact              |
//   | proposed dynamic / unclaimed      | no               | no          | no                          | plain object                  |
//
// Transition safety: a binding is valid ONLY while its carried
// claim-activation generation is the current winner's generation AND the
// winning extension is installed; a stale binding is IGNORED and resolution
// falls through the table (never an error).
// ---------------------------------------------------------------------------

/** `semantic_assertion.assertion_basis` value set (mirrored by the DDL CHECK
 * `sa_basis_chk` — the migration/bootstrap contract test asserts sync). */
export const ASSERTION_BASES = ["binding", "classic"] as const;
export type AssertionBasis = (typeof ASSERTION_BASES)[number];

/** The ONE generic artifact base type. Mirrors
 * `SEMANTIC_ARTIFACT_OBJECT_TYPE` in `@cinatra-ai/artifacts` (this package
 * cannot depend on that one; the graphiti-projector precedent already names
 * the literal). The host-side parity test pins the two constants equal. */
export const GENERIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

/** The assertion fields identity resolution needs (a projection of an ACTIVE
 * — non-archived — `semantic_assertion` row). */
export interface IdentityAssertion {
  id: string;
  extension: string;
  /** 'user' | 'authoring_skill' | 'agent' | 'matcher' (a future 'system'
   * value ranks 0, like matcher — bindings do not use classic precedence). */
  assertedBy: string;
  /** 'eligible' | 'draft' (archived rows never reach this leaf). */
  eligibility: string;
  assertionBasis: AssertionBasis;
  /** The claim ROW a binding was written under (`artifact_type_claims.id`);
   * null for classic. Generations are per-claim-row counters that restart at
   * 1 on a fresh claim, so a binding is anchored to (claim id, generation) —
   * generation alone would let a retired claim's binding revalidate against a
   * NEW same-package claim that also sits at generation 1. */
  bindingClaimId: string | null;
  /** The claim-activation generation a binding carries; null for classic. */
  bindingGeneration: number | null;
  assertedAt: string;
}

/** The winning claim for the row's base type in the org's view — the output
 * of `resolveClaimWinner` over the org's scope chain (see ./claims). */
export interface IdentityClaimWinner {
  /** `artifact_type_claims.id` — binding validity anchors to it. */
  claimId: string;
  extensionPackage: string;
  claimKind: "dedicated" | "default";
  generation: number;
}

export interface EffectiveIdentityInput {
  /** `objects.type` of the row. */
  baseType: string;
  /** Org-arbitrated winning claim for `baseType`; null when none. Identity is
   * ORG-level truth — actor-visibility gating of claims is the effective type
   * catalog's job, never this leaf's. */
  claimWinner: IdentityClaimWinner | null;
  /** Whether a live install row governs the winner's extension for this org.
   * A claim whose extension has NO install row is INACTIVE for identity. */
  claimWinnerInstalled: boolean;
  /** ACTIVE (non-archived) assertions on the artifact — bindings + classics. */
  assertions: readonly IdentityAssertion[];
  /** Install predicate for classic-assertion extensions: identity requires an
   * INSTALLED extension (this REMOVES the "ungoverned = allowed" allowance of
   * artifact-extension-access for identity purposes). The default-artifact
   * floor extension is exempt at the call site — it is a system extension,
   * present in every universe. */
  isExtensionInstalled: (extensionPackage: string) => boolean;
}

/**
 * The resolved identity. `selectable` is the activation barrier: a
 * catalog-derived identity (claim without a landed binding) is browse-visible
 * but NOT selectable (context/pinning) until reconciliation lands a real
 * assertion id; selection plumbing requires `assertionId`.
 */
export type EffectiveIdentity =
  | {
      kind: "extension";
      extension: string;
      basis: "binding" | "classic";
      selectable: true;
      assertionId: string;
    }
  | {
      // Activation barrier (truth-table row 4): the claim's extension for
      // BROWSE only — no assertion id exists yet, so it cannot be selected.
      kind: "extension";
      extension: string;
      basis: "catalog";
      selectable: false;
      assertionId: null;
    }
  | {
      kind: "default-artifact";
      /** Selectable iff the floor assertion row exists (selection needs its id). */
      selectable: boolean;
      assertionId: string | null;
    }
  | { kind: "plain-object"; selectable: false; assertionId: null };

/** AC-3 helper: the assertion id a selectable-identity query may use — null
 * for every non-selectable identity (catalog browse-only, plain object,
 * floor-less default). Selection paths MUST route through this, never through
 * a raw extension id. */
export function selectableAssertionId(identity: EffectiveIdentity): string | null {
  return identity.selectable ? identity.assertionId : null;
}

// Classic precedence — mirrors the assertion store's RANK_SQL / the
// `semantic-assertion.test.ts` contract: user > authoring_skill > agent >
// everything else. Ties: newest assertedAt first, then lexicographic
// extension id (total order).
function classicRank(assertedBy: string): number {
  return assertedBy === "user" ? 3 : assertedBy === "authoring_skill" ? 2 : assertedBy === "agent" ? 1 : 0;
}

function bestInstalledClassic(
  assertions: readonly IdentityAssertion[],
  isExtensionInstalled: (ext: string) => boolean,
): IdentityAssertion | null {
  const candidates = assertions.filter(
    (a) =>
      a.assertionBasis !== "binding" &&
      a.eligibility === "eligible" &&
      a.extension !== DEFAULT_ARTIFACT_EXTENSION &&
      isExtensionInstalled(a.extension),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const r = classicRank(b.assertedBy) - classicRank(a.assertedBy);
    if (r !== 0) return r;
    if (a.assertedAt !== b.assertedAt) return a.assertedAt < b.assertedAt ? 1 : -1; // newer first
    return a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0;
  });
  return candidates[0]!;
}

function floorAssertion(assertions: readonly IdentityAssertion[]): IdentityAssertion | null {
  return (
    assertions.find(
      (a) =>
        a.assertionBasis !== "binding" &&
        a.eligibility === "eligible" &&
        a.extension === DEFAULT_ARTIFACT_EXTENSION,
    ) ?? null
  );
}

function defaultArtifactIdentity(assertions: readonly IdentityAssertion[]): EffectiveIdentity {
  const floor = floorAssertion(assertions);
  return { kind: "default-artifact", selectable: floor != null, assertionId: floor?.id ?? null };
}

/**
 * Resolve one artifact's effective identity. Total: every (base type, claim,
 * binding, classic, install) combination lands on exactly one row of the
 * truth table above — unknown/invalid states fall through to the weakest
 * identity, never throw.
 */
export function resolveEffectiveIdentity(input: EffectiveIdentityInput): EffectiveIdentity {
  const activeBinding =
    input.assertions.find((a) => a.assertionBasis === "binding") ?? null;

  // Rows 1–2: the generic artifact base type. Never claimed, never bound —
  // identity is the classic-assertion set: highest-precedence INSTALLED
  // non-default eligible classic, else the default-artifact floor.
  if (input.baseType === GENERIC_ARTIFACT_OBJECT_TYPE) {
    const best = bestInstalledClassic(input.assertions, input.isExtensionInstalled);
    if (best) {
      return { kind: "extension", extension: best.extension, basis: "classic", selectable: true, assertionId: best.id };
    }
    return defaultArtifactIdentity(input.assertions);
  }

  // Typed row. An uninstalled winner is INACTIVE (no install row = no
  // identity) — resolution falls through exactly like a retired claim.
  const winner = input.claimWinner != null && input.claimWinnerInstalled ? input.claimWinner : null;

  if (winner != null) {
    if (winner.claimKind === "dedicated") {
      // Row 3: a binding is valid ONLY for the current winner's exact claim
      // ROW at its carried activation generation (generations are per-claim
      // counters — see IdentityAssertion.bindingClaimId). Claim-row,
      // extension, or generation mismatch = STALE — ignored, the activation
      // barrier applies until reconciliation.
      if (
        activeBinding != null &&
        activeBinding.bindingClaimId === winner.claimId &&
        activeBinding.extension === winner.extensionPackage &&
        activeBinding.bindingGeneration === winner.generation
      ) {
        return {
          kind: "extension",
          extension: winner.extensionPackage,
          basis: "binding",
          selectable: true,
          assertionId: activeBinding.id,
        };
      }
      // Row 4: claim without a landed binding — browse-only (activation barrier).
      return { kind: "extension", extension: winner.extensionPackage, basis: "catalog", selectable: false, assertionId: null };
    }
    // Rows 7–8: default-claim coverage (objects:object / approved dynamic) —
    // the default artifact, selectable through the real floor assertion.
    return defaultArtifactIdentity(input.assertions);
  }

  // Rows 5–6, 9: no effective claim (none / retired / uninstalled). A stale
  // binding (if any) is ignored. Installed eligible classic wins; otherwise
  // the row is a plain object — a typed row has NO floor coverage without a
  // default claim, so a leftover default assertion grants nothing here.
  const best = bestInstalledClassic(input.assertions, input.isExtensionInstalled);
  if (best) {
    return { kind: "extension", extension: best.extension, basis: "classic", selectable: true, assertionId: best.id };
  }
  return { kind: "plain-object", selectable: false, assertionId: null };
}
