// cinatra#1433 AC-2 — the org-scoped dynamic-type artifact-visibility READ
// surface (deps-injected). The default-artifact floor that once WROTE these
// approval records is retired (epic #1785 wave A5); the reserve→activate write
// path and its admin Approve action are gone, so only the read/list projection
// survives here. An approval record is a non-retired, org-scoped DEFAULT-kind
// `artifact_type_claims` row regardless of its (now-retired) holder.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type ArtifactTypeClaimRow } from "@/lib/objects/artifact-claim-store";
import {
  approvalAwaitsDecision,
  countUnapprovedDynamicTypes,
  listDynamicTypeVisibilityReviewRows,
  readDynamicTypeArtifactVisibilityApproval,
  type DynamicTypeVisibilityDeps,
} from "@/lib/objects/artifact-visibility-approval";

const ORG = "org-1";
const TYPE = "@cinatra-ai/dynamic:competitor-profile";

function claimRow(over: Partial<ArtifactTypeClaimRow> = {}): ArtifactTypeClaimRow {
  return {
    id: "claim-1",
    scope: `org:${ORG}`,
    objectTypeId: TYPE,
    claimKind: "default",
    status: "active",
    // Historical holder — a pre-retirement default claim was minted by the
    // floor extension. The read no longer filters on the holder.
    extensionPackage: "@cinatra-ai/default-artifact",
    extensionVersion: "0.1.0",
    generation: 1,
    dispositions: {
      projection: "artifact-safe",
      pinnable: false,
      snapshotPolicy: "none",
      sensitivity: "normal",
    },
    installId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

function deps(over: DynamicTypeVisibilityDeps = {}): DynamicTypeVisibilityDeps {
  return {
    readActiveDynamicObjectTypes: vi.fn(async () => [
      {
        type: TYPE,
        inferredName: "Competitor profile",
        inferredCategory: "profile",
        source: "mcp",
        createdAt: new Date("2026-07-14T00:00:00.000Z"),
      },
    ]),
    readClaimsForOrg: vi.fn(() => []),
    ...over,
  };
}

describe("read surface", () => {
  it("readDynamicTypeArtifactVisibilityApproval projects the live claim; retired ⇒ null", async () => {
    const approved = await readDynamicTypeArtifactVisibilityApproval(
      { orgId: ORG, objectTypeId: TYPE },
      deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "dormant", generation: 2 })]) }),
    );
    expect(approved).toMatchObject({
      orgId: ORG,
      objectTypeId: TYPE,
      claimId: "claim-1",
      status: "dormant",
      generation: 2,
    });
    const retired = await readDynamicTypeArtifactVisibilityApproval(
      { orgId: ORG, objectTypeId: TYPE },
      deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "retired" })]) }),
    );
    expect(retired).toBeNull();
  });

  it("matches the org-scoped DEFAULT-kind claim regardless of the (retired) holder; ignores other scope / kind / type", async () => {
    // Holder-agnostic post floor retirement: a DEFAULT-kind claim IS the
    // approval record whatever package once held it.
    const held = await readDynamicTypeArtifactVisibilityApproval(
      { orgId: ORG, objectTypeId: TYPE },
      deps({ readClaimsForOrg: vi.fn(() => [claimRow({ id: "c-any", extensionPackage: "@vendor/x-artifact" })]) }),
    );
    expect(held).toMatchObject({ claimId: "c-any", status: "active" });

    const noise: ArtifactTypeClaimRow[] = [
      claimRow({ id: "c-platform", scope: "platform" }),
      claimRow({ id: "c-dedicated", claimKind: "dedicated", extensionPackage: "@vendor/x-artifact" }),
      claimRow({ id: "c-other-type", objectTypeId: "@cinatra-ai/dynamic:other" }),
    ];
    const res = await readDynamicTypeArtifactVisibilityApproval(
      { orgId: ORG, objectTypeId: TYPE },
      deps({ readClaimsForOrg: vi.fn(() => noise) }),
    );
    expect(res).toBeNull();
  });

  it("listDynamicTypeVisibilityReviewRows pairs ACTIVE dynamic types with their approval state; count = unapproved", async () => {
    const d = deps({
      readActiveDynamicObjectTypes: vi.fn(async () => [
        {
          type: TYPE,
          inferredName: "Competitor profile",
          inferredCategory: "profile",
          source: "mcp",
          createdAt: new Date("2026-07-14T00:00:00.000Z"),
        },
        {
          type: "@cinatra-ai/dynamic:pending-one",
          inferredName: "Pending one",
          inferredCategory: "content",
          source: "install",
          createdAt: new Date("2026-07-14T01:00:00.000Z"),
        },
      ]),
      readClaimsForOrg: vi.fn(() => [claimRow()]),
    });
    const rows = await listDynamicTypeVisibilityReviewRows({ orgId: ORG }, d);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      objectTypeId: TYPE,
      displayName: "Competitor profile",
      category: "profile",
      mintedBy: "mcp",
      approval: { claimId: "claim-1", status: "active" },
    });
    expect(rows[1].approval).toBeNull();
    expect(await countUnapprovedDynamicTypes({ orgId: ORG }, d)).toBe(1);
  });

  it("a stranded 'reserved' record still AWAITS a decision (stays actionable, counts as pending)", async () => {
    expect(approvalAwaitsDecision(null)).toBe(true);
    const reserved = await readDynamicTypeArtifactVisibilityApproval(
      { orgId: ORG, objectTypeId: TYPE },
      deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "reserved" })]) }),
    );
    expect(reserved?.status).toBe("reserved");
    expect(approvalAwaitsDecision(reserved)).toBe(true);
    for (const status of ["active", "dormant", "retiring"] as const) {
      const a = await readDynamicTypeArtifactVisibilityApproval(
        { orgId: ORG, objectTypeId: TYPE },
        deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status })]) }),
      );
      expect(approvalAwaitsDecision(a)).toBe(false);
    }
    const d = deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "reserved" })]) });
    expect(await countUnapprovedDynamicTypes({ orgId: ORG }, d)).toBe(1);
  });
});
