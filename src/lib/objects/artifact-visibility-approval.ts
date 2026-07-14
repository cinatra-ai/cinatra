import "server-only";

// Org-scoped dynamic-type ARTIFACT-VISIBILITY approval (cinatra#1433, epic
// #1424) — the admin decision that lets an ACTIVE dynamic object type join
// DEFAULT artifact coverage for ONE org.
//
// PREMISE. Dynamic types are globally keyed (`dynamic_object_types`, PK=type,
// no org column) and both MCP registration and package install mint them with
// `status='active'` directly (`ensureDynamicObjectType` in
// packages/agents/src/import-agent-core.ts / install-from-package.ts),
// bypassing the global `approveDynamicObjectType` admin gate. `status='active'`
// therefore CANNOT mean "this org wants these rows surfaced as artifacts" —
// artifact visibility needs its own, org-scoped approval.
//
// THE RECORD IS THE CLAIM. The approval record for (org, dynamicTypeId) is an
// org-scoped (`org:<id>`) DEFAULT-kind `artifact_type_claims` row held by the
// default-artifact floor extension, written through the already-landed claim
// primitives (reserve → activate, cinatra#1425). No new table: the claim
// registry's own lifecycle IS the record's persistence story —
//   - approval provenance (who/when) is the claim's append-only event log;
//   - a dedicated claimant arriving later makes the claim 'dormant' (the
//     #1425 domination rule) WITHOUT erasing the approval — retirement of the
//     dedicated claim reactivates it with a NEW generation, so rows fall back
//     to default coverage with NO re-approval (issue AC-3);
//   - the one-live-default partial unique index makes double-approval a
//     constraint-backed conflict, never a duplicate record.
// This action is the ONLY writer of org-scoped default claims for the floor
// extension on dynamic types — distinct from the GLOBAL status flip
// (`approveDynamicObjectType`, which admits a 'proposed' type into the
// classifier catalog and stays prerequisite: only an 'active' type can gain
// artifact visibility here).
//
// Consumed by the `dynamic-type-artifact-visibility` ApprovalSource (the
// unified /configuration/approvals Inbox + the `approvals_*` MCP tools ride
// the same registry — the cinatra#1391 hostPortGrantsSource precedent).
// Business refusals are VALUES (`{ ok:false, code, ... }`), never throws.

import {
  orgClaimScope,
  type ArtifactClaimStatus,
  type ClaimDispositions,
} from "@cinatra-ai/objects/claims";
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";

import {
  ArtifactClaimConflictError,
  activateArtifactTypeClaim,
  readArtifactTypeClaimsForOrg,
  reserveArtifactTypeClaim,
  type ArtifactTypeClaimRow,
} from "@/lib/objects/artifact-claim-store";

/**
 * The conservative disposition an org-approved dynamic type joins default
 * coverage with (issue #1433: "a conservative disposition"): projectable
 * through artifact-safe surfaces only, never pinnable, no content snapshots,
 * normal sensitivity. Default-claimed rows never carry bindings, so the
 * snapshot path can never mint for them regardless — this payload states the
 * policy explicitly instead of leaning on absent-payload defaults.
 */
export const CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS = {
  projection: "artifact-safe",
  pinnable: false,
  snapshotPolicy: "none",
  sensitivity: "normal",
} as const satisfies ClaimDispositions;

/** Version recorded on the claim when no live default-artifact install row is
 * readable — the floor is a system extension (present in every universe), so
 * version provenance is best-effort, never a gate. */
export const UNKNOWN_FLOOR_VERSION = "0.0.0";

/** The approval record, projected off the claim row. */
export interface DynamicTypeArtifactVisibilityApproval {
  orgId: string;
  objectTypeId: string;
  claimId: string;
  /** 'active' (covering) | 'dormant' (yielded to a dedicated claim) |
   * 'retiring' | 'reserved' (activation owed — see the approve self-heal). */
  status: ArtifactClaimStatus;
  generation: number;
  approvedAt: string | null;
}

/** One review row for the approvals surface: an ACTIVE dynamic type with its
 * org approval state (`approval: null` ⇒ awaiting decision — the Inbox set). */
export interface DynamicTypeVisibilityReviewRow {
  objectTypeId: string;
  displayName: string;
  category: string;
  /** Where the type was minted ('classifier' | 'mcp' | 'install' | 'admin' | null). */
  mintedBy: string | null;
  createdAt: string;
  approval: DynamicTypeArtifactVisibilityApproval | null;
}

export type ApproveDynamicTypeVisibilityResult =
  | { ok: true; claimId: string; repairedReservedClaim: boolean }
  | {
      ok: false;
      code: "not_found" | "not_active" | "already_approved" | "claim_conflict";
      message: string;
    };

/** Injected in tests; production omits (real readers/writers). */
export interface DynamicTypeVisibilityDeps {
  readDynamicObjectTypeByType?: (
    type: string,
  ) => Promise<{ type: string; status: string } | null>;
  readActiveDynamicObjectTypes?: () => Promise<
    {
      type: string;
      inferredName: string;
      inferredCategory: string;
      source: string | null;
      createdAt: Date;
    }[]
  >;
  readClaimsForOrg?: typeof readArtifactTypeClaimsForOrg;
  reserveClaim?: typeof reserveArtifactTypeClaim;
  activateClaim?: typeof activateArtifactTypeClaim;
  /** Live default-artifact version governing the org (org-owned or ambient). */
  readInstalledFloorVersion?: (orgId: string) => Promise<string | null>;
}

async function resolveDeps(
  deps?: DynamicTypeVisibilityDeps,
): Promise<Required<DynamicTypeVisibilityDeps>> {
  // The dynamic-type readers live in the objects package (drizzle, async);
  // imported lazily so this module's static graph stays the claim-store leaf.
  const registrar = () => import("@cinatra-ai/objects/auto-registrar");
  return {
    readDynamicObjectTypeByType:
      deps?.readDynamicObjectTypeByType ??
      (async (type) => (await registrar()).readDynamicObjectTypeByType(type)),
    readActiveDynamicObjectTypes:
      deps?.readActiveDynamicObjectTypes ??
      (async () => (await registrar()).readActiveDynamicObjectTypes()),
    readClaimsForOrg: deps?.readClaimsForOrg ?? readArtifactTypeClaimsForOrg,
    reserveClaim: deps?.reserveClaim ?? reserveArtifactTypeClaim,
    activateClaim: deps?.activateClaim ?? activateArtifactTypeClaim,
    readInstalledFloorVersion:
      deps?.readInstalledFloorVersion ?? defaultReadInstalledFloorVersion,
  };
}

/** Best-effort read of the live default-artifact install version governing the
 * org (org-owned row preferred over ambient). Unreadable ⇒ null (the caller
 * records {@link UNKNOWN_FLOOR_VERSION}); the floor is a system extension, so
 * a missing row never blocks the approval. */
async function defaultReadInstalledFloorVersion(orgId: string): Promise<string | null> {
  try {
    const { readInstalledExtensionsByPackageName } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const rows = await readInstalledExtensionsByPackageName(DEFAULT_ARTIFACT_EXTENSION);
    const live = rows.filter(
      (r) =>
        (r.status === "active" || r.status === "locked") &&
        ((r.organizationId ?? null) === orgId || r.organizationId == null),
    );
    live.sort((a, b) =>
      (a.organizationId == null ? 1 : 0) - (b.organizationId == null ? 1 : 0),
    );
    return live[0]?.version ?? null;
  } catch {
    return null;
  }
}

/** The claim rows that constitute an approval record for (org, type): the
 * floor extension's org-scoped DEFAULT claims that are not retired. At most
 * one exists (`artifact_type_claims_one_live_default`). */
function approvalClaim(
  claims: readonly ArtifactTypeClaimRow[],
  orgId: string,
  objectTypeId: string,
): ArtifactTypeClaimRow | null {
  return (
    claims.find(
      (c) =>
        c.scope === orgClaimScope(orgId) &&
        c.objectTypeId === objectTypeId &&
        c.claimKind === "default" &&
        c.extensionPackage === DEFAULT_ARTIFACT_EXTENSION &&
        c.status !== "retired",
    ) ?? null
  );
}

function toApproval(row: ArtifactTypeClaimRow, orgId: string): DynamicTypeArtifactVisibilityApproval {
  return {
    orgId,
    objectTypeId: row.objectTypeId,
    claimId: row.id,
    status: row.status,
    generation: row.generation,
    approvedAt: row.createdAt,
  };
}

/** The org's approval record for one dynamic type, or null. */
export async function readDynamicTypeArtifactVisibilityApproval(
  input: { orgId: string; objectTypeId: string },
  depsOverride?: DynamicTypeVisibilityDeps,
): Promise<DynamicTypeArtifactVisibilityApproval | null> {
  const deps = await resolveDeps(depsOverride);
  const row = approvalClaim(deps.readClaimsForOrg(input.orgId), input.orgId, input.objectTypeId);
  return row ? toApproval(row, input.orgId) : null;
}

/**
 * Every ACTIVE dynamic type with its org approval state — the review surface.
 * `approval === null` rows are the Inbox set (awaiting the org decision);
 * 'proposed'/'archived' dynamic types never appear (the GLOBAL admin review
 * owns that lifecycle — only an active type can gain artifact visibility).
 */
export async function listDynamicTypeVisibilityReviewRows(
  input: { orgId: string },
  depsOverride?: DynamicTypeVisibilityDeps,
): Promise<DynamicTypeVisibilityReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  const [types, claims] = await Promise.all([
    deps.readActiveDynamicObjectTypes(),
    Promise.resolve(deps.readClaimsForOrg(input.orgId)),
  ]);
  return types.map((t) => {
    const claim = approvalClaim(claims, input.orgId, t.type);
    return {
      objectTypeId: t.type,
      displayName: t.inferredName,
      category: t.inferredCategory,
      mintedBy: t.source,
      createdAt: t.createdAt.toISOString(),
      approval: claim ? toApproval(claim, input.orgId) : null,
    };
  });
}

/**
 * Whether a review row still needs an admin decision — the Inbox/count
 * predicate. A missing record obviously does; so does a 'reserved' claim: a
 * crash between reserve and activate leaves an INACTIVE record that conveys
 * no coverage, so it must stay actionable (deciding it again routes into the
 * approve self-heal below) rather than vanish as "already approved".
 */
export function approvalAwaitsDecision(
  approval: DynamicTypeArtifactVisibilityApproval | null,
): boolean {
  return approval == null || approval.status === "reserved";
}

/** The Inbox count: ACTIVE dynamic types still awaiting the org decision. */
export async function countUnapprovedDynamicTypes(
  input: { orgId: string },
  depsOverride?: DynamicTypeVisibilityDeps,
): Promise<number> {
  const rows = await listDynamicTypeVisibilityReviewRows(input, depsOverride);
  return rows.filter((r) => approvalAwaitsDecision(r.approval)).length;
}

/**
 * The org-scoped artifact-visibility APPROVAL action (admin-only — the caller
 * enforces the gate; the ApprovalSource decide and any server action wrap this
 * with the viewer's admin check). Ladder, fail-closed:
 *
 *   1. unknown dynamic type            → 'not_found'
 *   2. status ≠ 'active'               → 'not_active' (a 'proposed' type must
 *      pass the GLOBAL approveDynamicObjectType review first; 'archived' never
 *      gains coverage)
 *   3. approval record already exists  → 'already_approved' — EXCEPT a
 *      'reserved' claim (a crash between reserve and activate), which is
 *      completed here (idempotent activate; the CAS re-checks 'reserved')
 *   4. reserve → activate the org-scoped default claim (conservative
 *      dispositions). A concurrent approval racing to the same slot hits the
 *      one-live-default index inside reserve → 'claim_conflict'.
 *
 * Activation may legally land 'dormant' (a dedicated claimant already governs
 * the type — #1425 domination): the approval record exists from this moment
 * and coverage engages automatically when the dedicated claim retires.
 */
export async function approveDynamicTypeArtifactVisibility(
  input: { orgId: string; objectTypeId: string; approvedBy: string },
  depsOverride?: DynamicTypeVisibilityDeps,
): Promise<ApproveDynamicTypeVisibilityResult> {
  const deps = await resolveDeps(depsOverride);

  const dyn = await deps.readDynamicObjectTypeByType(input.objectTypeId);
  if (!dyn) {
    return {
      ok: false,
      code: "not_found",
      message: `No dynamic object type '${input.objectTypeId}' is registered.`,
    };
  }
  if (dyn.status !== "active") {
    return {
      ok: false,
      code: "not_active",
      message:
        `Dynamic type '${input.objectTypeId}' is '${dyn.status}', not active — ` +
        "it must pass the global dynamic-type review before it can gain artifact coverage.",
    };
  }

  const existing = approvalClaim(
    deps.readClaimsForOrg(input.orgId),
    input.orgId,
    input.objectTypeId,
  );
  if (existing) {
    if (existing.status === "reserved") {
      // Crash-window self-heal: the record exists but activation is owed —
      // complete it (the store's CAS makes a lost race a no-op).
      deps.activateClaim({ claimId: existing.id, actor: input.approvedBy });
      return { ok: true, claimId: existing.id, repairedReservedClaim: true };
    }
    return {
      ok: false,
      code: "already_approved",
      message: `Dynamic type '${input.objectTypeId}' already has artifact coverage approval for this organization.`,
    };
  }

  const version = (await deps.readInstalledFloorVersion(input.orgId)) ?? UNKNOWN_FLOOR_VERSION;
  let claimId: string;
  try {
    claimId = deps.reserveClaim({
      scope: orgClaimScope(input.orgId),
      objectTypeId: input.objectTypeId,
      claimKind: "default",
      extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
      extensionVersion: version,
      installId: null,
      dispositions: CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
      actor: input.approvedBy,
    });
  } catch (error) {
    if (error instanceof ArtifactClaimConflictError) {
      return {
        ok: false,
        code: "claim_conflict",
        message: `A live default claim already occupies '${input.objectTypeId}' for this organization (a concurrent approval likely won).`,
      };
    }
    throw error;
  }
  deps.activateClaim({ claimId, actor: input.approvedBy });
  return { ok: true, claimId, repairedReservedClaim: false };
}
