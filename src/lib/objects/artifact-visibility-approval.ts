import "server-only";

// Org-scoped dynamic-type ARTIFACT-VISIBILITY read surface (cinatra#1433, epic
// #1424) — the review/list projection the admin /artifacts "Types & approvals"
// register reads.
//
// PREMISE. Dynamic types are globally keyed (`dynamic_object_types`, PK=type,
// no org column) and both MCP registration and package install mint them with
// `status='active'` directly (`ensureDynamicObjectType` in
// packages/agents/src/import-agent-core.ts / install-from-package.ts). An
// `status='active'` registration therefore does NOT by itself mean "this org
// wants these rows surfaced as artifacts" — artifact visibility is its own,
// org-scoped record.
//
// THE RECORD IS THE CLAIM. An approval record for (org, dynamicTypeId) is an
// org-scoped (`org:<id>`) DEFAULT-kind `artifact_type_claims` row that is not
// retired. This module PROJECTS those rows; it no longer WRITES them.
//
// FLOOR RETIREMENT (epic #1785 wave A5). @cinatra-ai/default-artifact — the
// "floor" extension that formerly HELD these default claims and the writer that
// reserved→activated them — is retired end-to-end (removed from the
// systemExtensions+requiredExtensions+lock triple; artifact-floor.ts deleted).
// The default-claim WRITE path (approve action, reserve/activate) is gone with
// it; only the read/list surface below survives, until the dynamic-type engine
// teardown (#1793) removes the #1433 machinery wholesale. A DEFAULT-kind claim
// IS the approval record regardless of a (now-retired) holder, so the record
// read matches org-scope + DEFAULT kind + non-retired without naming any
// extension. Business helpers return VALUES, never throw.

import { orgClaimScope, type ArtifactClaimStatus } from "@cinatra-ai/objects/claims";

import {
  readArtifactTypeClaimsForOrg,
  type ArtifactTypeClaimRow,
} from "@/lib/objects/artifact-claim-store";

/** The approval record, projected off the claim row. */
export interface DynamicTypeArtifactVisibilityApproval {
  orgId: string;
  objectTypeId: string;
  claimId: string;
  /** 'active' (covering) | 'dormant' (yielded to a dedicated claim) |
   * 'retiring' | 'reserved' (activation owed — see approvalAwaitsDecision). */
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

/** Injected in tests; production omits (real readers). */
export interface DynamicTypeVisibilityDeps {
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
}

async function resolveDeps(
  deps?: DynamicTypeVisibilityDeps,
): Promise<Required<DynamicTypeVisibilityDeps>> {
  // The dynamic-type readers live in the objects package (drizzle, async);
  // imported lazily so this module's static graph stays the claim-store leaf.
  const registrar = () => import("@cinatra-ai/objects/auto-registrar");
  return {
    readActiveDynamicObjectTypes:
      deps?.readActiveDynamicObjectTypes ??
      (async () => (await registrar()).readActiveDynamicObjectTypes()),
    readClaimsForOrg: deps?.readClaimsForOrg ?? readArtifactTypeClaimsForOrg,
  };
}

/** The claim row that constitutes an approval record for (org, type): the
 * org-scoped DEFAULT-kind claim that is not retired. At most one exists
 * (`artifact_type_claims_one_live_default`). The former floor extension held
 * these; its retirement leaves the DEFAULT kind itself as the record identity. */
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
 * owns that lifecycle — only an active type can carry artifact visibility).
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
 * crash between reserve and activate leaves an INACTIVE record that conveys no
 * coverage, so it stays actionable rather than reading as "already approved".
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
