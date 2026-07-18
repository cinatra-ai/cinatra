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
//   - ACTIVE dynamic types (`dynamic_object_types`, admin-approved only),
//   - the DB claim registry's winning claim per type for the org
//     (kind-over-scope arbitration in the pure policy leaf),
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

import { objectTypeRegistry, readActiveDynamicObjectTypes } from "@cinatra-ai/objects";
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

// ---------------------------------------------------------------------------
// Registry-internal object types (epic #1785 ruling, 2026-07-18).
//
// A small set of object types are INTERNAL platform concepts: they exist as
// registered runtime types (schema/identity enforcement) but must NEVER appear
// in the installed-type registry or any admin type surface. The epic ruling
// (2026-07-18) is explicit: registry provenance is installed extension claims
// and nothing else; the OKF (Object Knowledge Fabric) memory-concept type is
// exempt from that model AS AN INTERNAL CONCEPT — not as a visible registry
// row. This resolver is the single authority the registry surface
// (`/configuration/objects`, #1786) reads, so the exemption lives here: an
// internal type is filtered out of the resolved catalog in ONE documented
// place. The type stays registered and fully functional everywhere else (the
// memory sync/write path resolves it directly through `objectTypeRegistry`,
// never through this registry-facing catalog).
// ---------------------------------------------------------------------------

/** The OKF memory-concept type id. Mirrors `MEMORY_CONCEPT_TYPE_ID` in
 * `packages/objects/src/integration/register-types.ts` (kept as a local
 * literal to avoid widening this server-lib's import edges — the same idiom
 * `packages/objects/src/mcp/handlers.ts` uses for the same constant). */
const OKF_MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";

/** Object types that are INTERNAL platform concepts and are excluded from the
 * installed-type registry / every admin type surface (epic #1785 ruling). The
 * OKF memory-concept type is the sole member today. */
export const REGISTRY_INTERNAL_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  OKF_MEMORY_CONCEPT_TYPE_ID,
]);

/** True when `typeId` is an internal platform concept that must never surface
 * in the installed-type registry (the OKF memory-concept type today). Registry
 * consumers filter on this so an internal type is never shown as a registry
 * row (epic #1785). */
export function isRegistryInternalObjectTypeId(typeId: string): boolean {
  return REGISTRY_INTERNAL_OBJECT_TYPE_IDS.has(typeId);
}

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
  /** Where the entry came from: the static registry cache, the approved
   * dynamic-type table, or a claim on a type this process has no local
   * definition for (claims are DB state — a claimed type exists even when the
   * local registry never registered it). */
  source: "static" | "dynamic" | "claim";
  category: string | null;
  displayName: string | null;
  /** The org's winning claim for this type, iff the ACTOR is inside the
   * claiming install's access grants; otherwise null. */
  claim: EffectiveClaimInfo | null;
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
    });
  }

  // 2. ACTIVE (admin-approved) dynamic types. A dynamic id already present in
  // the static cache keeps its static entry (promotion path).
  for (const dyn of await readActiveDynamicObjectTypes()) {
    if (entries.has(dyn.type)) continue;
    entries.set(dyn.type, {
      typeId: dyn.type,
      entryKind: "row-type",
      source: "dynamic",
      category: dyn.inferredCategory ?? null,
      displayName: dyn.inferredName ?? null,
      claim: null,
    });
  }

  // 3. Winning claim per type for this org, gated per actor by the claiming
  // install's access grants.
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
    });
  }

  // INTERNAL-type exemption (epic #1785 ruling): drop registry-internal types
  // (the OKF memory-concept type) from every source before sorting — they are
  // never installed-type-registry rows. Filtering the final union covers a type
  // arriving from the static cache, the dynamic table, or a claim alike.
  return Array.from(entries.values())
    .filter((entry) => !isRegistryInternalObjectTypeId(entry.typeId))
    .sort((a, b) => a.typeId.localeCompare(b.typeId));
}
