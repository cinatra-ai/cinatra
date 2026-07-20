import "server-only";

// ---------------------------------------------------------------------------
// Effective type catalog resolver (cinatra#1425, epic #1424 foundation).
//
// ONE resolution point for "which object types exist here, and who claims
// them": the union of
//   - STATIC registry types (the in-memory objectTypeRegistry — the epic
//     demotes it to a render/schema cache; #1425 ships this authority
//     surface and later sub-issues cut consumers over), split by entry
//     kind: plain `row-type` vs `artifact-extension-descriptor` (an entry
//     carrying `isArtifact`),
//   - the DB claim registry's winning claim per type for the org
//     (kind-over-scope arbitration in the pure policy leaf),
// The former ACTIVE-dynamic-types axis (`dynamic_object_types`) was removed
// with the dynamic-types engine teardown (epic cinatra#1785 entry 95; #1793):
// types now exist only as an explicit installed-extension definition (static
// registry) or a DB claim, never as an admin-approved dynamic row.
// resolved per ORG and per ACTOR: a claim is visible to an actor only when
// the claiming extension install's access grants admit that actor (standard
// install-time access scope; dev-install default = workspace) — an actor
// outside the grant sees NO claim (the entry itself stays; claim-gated
// behavior downstream then treats the row as unclaimed for that actor).
//
// Dispositions are claim payload validated against the strict union in the
// policy leaf; a payload that fails validation resolves to `null`
// (fail-closed — never a permissive fallback), with a warn.
// ---------------------------------------------------------------------------

import {
  objectTypeRegistry,
  resolveTypeProjectionDisposition,
  type TypeDispositions,
  type TypeProjectionDisposition,
} from "@cinatra-ai/objects";
import {
  parseClaimDispositions,
  resolveClaimWinner,
  type ArtifactClaimKind,
  type ArtifactClaimStatus,
  type ClaimDispositions,
} from "@cinatra-ai/objects/claims";

import { canActorAccessClaimedArtifactExtension } from "@/lib/artifacts/artifact-extension-access";
import type { ActorContext } from "@/lib/authz/actor-context";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";

export type EffectiveTypeEntryKind = "row-type" | "artifact-extension-descriptor";

export interface EffectiveClaimInfo {
  claimId: string;
  scope: string;
  claimKind: ArtifactClaimKind;
  status: ArtifactClaimStatus;
  extensionPackage: string;
  extensionVersion: string;
  generation: number;
  /** Validated claim payload; null when absent or invalid (fail-closed). */
  dispositions: ClaimDispositions | null;
}

export interface EffectiveTypeCatalogEntry {
  typeId: string;
  entryKind: EffectiveTypeEntryKind;
  /** Where the entry came from: the static registry cache, or a claim on a
   * type this process has no local definition for (claims are DB state — a
   * claimed type exists even when the local registry never registered it). */
  source: "static" | "claim";
  category: string | null;
  displayName: string | null;
  /** The org's winning claim for this type, iff the ACTOR is inside the
   * claiming install's access grants; otherwise null. */
  claim: EffectiveClaimInfo | null;
  /** The type-driven DECLARED disposition payload (epic #1785), read from the
   * registered type — the single disposition authority the retirement cuts this
   * catalog (and the projector / rebuild / recall) over to, replacing the
   * DB-claim arbitration. Null for a type with no local registration (a
   * dynamic- or claim-sourced entry) or one that declares none (a plain data
   * object). Distinct from `claim.dispositions`, which is per-actor access
   * provenance, not the governing disposition. */
  declaredDispositions: TypeDispositions | null;
  /** The resolved projection for this type via the shared registry resolver:
   * the declared projection, `artifact-safe` when installed but undeclared, or
   * `none` when the defining extension is not installed (fail closed). */
  projectionDisposition: TypeProjectionDisposition;
}

function claimInfoFrom(winner: {
  id: string;
  scope: string;
  claimKind: ArtifactClaimKind;
  status: ArtifactClaimStatus;
  extensionPackage: string;
  extensionVersion: string;
  generation: number;
  dispositions?: unknown;
}): EffectiveClaimInfo {
  let dispositions: ClaimDispositions | null = null;
  if (winner.dispositions != null) {
    const parsed = parseClaimDispositions(winner.dispositions);
    if (parsed.ok) {
      dispositions = parsed.dispositions;
    } else {
      console.warn(
        `[effective-type-catalog] claim ${winner.id} carries invalid dispositions — resolving to null (fail-closed): ${parsed.errors.join("; ")}`,
      );
    }
  }
  return {
    claimId: winner.id,
    scope: winner.scope,
    claimKind: winner.claimKind,
    status: winner.status,
    extensionPackage: winner.extensionPackage,
    extensionVersion: winner.extensionVersion,
    generation: winner.generation,
    dispositions,
  };
}

/**
 * Resolve the effective type catalog for one org as seen by one actor.
 * Sorted by typeId for a stable surface.
 */
export async function resolveEffectiveTypeCatalog(input: {
  orgId: string;
  actor: ActorContext | null;
}): Promise<EffectiveTypeCatalogEntry[]> {
  const entries = new Map<string, EffectiveTypeCatalogEntry>();

  // 1. Static registry types (render/schema cache).
  for (const def of objectTypeRegistry.list()) {
    entries.set(def.type, {
      typeId: def.type,
      entryKind: def.isArtifact ? "artifact-extension-descriptor" : "row-type",
      source: "static",
      category: def.category,
      displayName: null,
      claim: null,
      declaredDispositions: def.dispositions ?? null,
      projectionDisposition: resolveTypeProjectionDisposition(def.type),
    });
  }

  // 2. Winning claim per type for this org, gated per actor by the claiming
  // install's access grants. (The former ACTIVE-dynamic-types axis was removed
  // with the engine teardown — epic cinatra#1785 entry 95, #1793.)
  //
  // WINNER-BEFORE-AUTHORIZATION is deliberate: arbitration is ORG-level truth
  // — the winner is the claim that governs the org's rows and drives binding
  // reconciliation, so it never varies per actor. Access only decides whether
  // THIS actor sees the claim; an actor outside the winner's grant does NOT
  // fall back to a lower-ranked claim (that would fork effective identity
  // per actor, which the binding write path cannot honor).
  const claims = readArtifactTypeClaimsForOrg(input.orgId);
  const typeIds = new Set(claims.map((c) => c.objectTypeId));
  for (const objectTypeId of typeIds) {
    const winner = resolveClaimWinner(claims, { orgId: input.orgId, objectTypeId });
    if (!winner) continue;
    // Claim-scoped, FAIL-CLOSED gate (never the disk-artifact "ungoverned"
    // allowance): no live install row governing the claim's exact scope (or
    // its bound installId) → the claim is invisible.
    const actorSeesClaim = await canActorAccessClaimedArtifactExtension(
      {
        extensionPackage: winner.extensionPackage,
        installId: winner.installId,
        scope: winner.scope,
      },
      input.actor,
      "read",
    );
    if (!actorSeesClaim) continue; // entry (if any) stays claimless; a
    // claim-only type is NOT surfaced at all — no existence leak.
    const existing = entries.get(objectTypeId);
    if (existing) {
      existing.claim = claimInfoFrom(winner);
      continue;
    }
    // A claim over a type with no local definition: the claim itself
    // establishes the catalog entry (DB state outranks the process cache) —
    // only for actors the claim's install grants admit.
    entries.set(objectTypeId, {
      typeId: objectTypeId,
      entryKind: "row-type",
      source: "claim",
      category: null,
      displayName: null,
      claim: claimInfoFrom(winner),
      // A claim-only type has no local registration; the type-driven disposition
      // authority (the registry) declares none — fail closed to 'none'.
      declaredDispositions: null,
      projectionDisposition: resolveTypeProjectionDisposition(objectTypeId),
    });
  }

  return Array.from(entries.values()).sort((a, b) => a.typeId.localeCompare(b.typeId));
}
