// cinatra#1433 AC-2 — the org-scoped dynamic-type artifact-visibility approval
// ladder (deps-injected; the real-DB composition is proven in
// default-dynamic-coverage.integration.test.ts). Refusals are VALUES and every
// branch is fail-closed: an unknown / proposed / archived type never gains a
// claim, a double approval refuses, and a reserve-time constraint conflict
// surfaces as 'claim_conflict', never a throw.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseClaimDispositions } from "@cinatra-ai/objects/claims";
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";

import { ArtifactClaimConflictError, type ArtifactTypeClaimRow } from "@/lib/objects/artifact-claim-store";
import {
  CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
  UNKNOWN_FLOOR_VERSION,
  approvalAwaitsDecision,
  approveDynamicTypeArtifactVisibility,
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
    extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
    extensionVersion: "0.1.0",
    generation: 1,
    dispositions: CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
    installId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

function deps(over: DynamicTypeVisibilityDeps = {}): DynamicTypeVisibilityDeps {
  return {
    readDynamicObjectTypeByType: vi.fn(async () => ({ type: TYPE, status: "active" })),
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
    reserveClaim: vi.fn(() => "claim-new"),
    activateClaim: vi.fn(() => ({ changed: true })),
    readInstalledFloorVersion: vi.fn(async () => "0.1.0"),
    ...over,
  };
}

describe("CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS", () => {
  it("parses against the strict dispositions union (never a permissive drift)", () => {
    const parsed = parseClaimDispositions(CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dispositions.projection).toBe("artifact-safe");
      expect(parsed.dispositions.pinnable).toBe(false);
      expect(parsed.dispositions.snapshotPolicy).toBe("none");
      expect(parsed.dispositions.sensitivity).toBe("normal");
    }
  });
});

describe("approveDynamicTypeArtifactVisibility — refusal ladder (fail-closed)", () => {
  it("refuses 'not_found' for an unregistered type (no claim write)", async () => {
    const d = deps({ readDynamicObjectTypeByType: vi.fn(async () => null) });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(d.reserveClaim).not.toHaveBeenCalled();
    expect(d.activateClaim).not.toHaveBeenCalled();
  });

  it.each(["proposed", "archived"] as const)(
    "refuses 'not_active' for a %s type — the GLOBAL review gate stays prerequisite",
    async (status) => {
      const d = deps({
        readDynamicObjectTypeByType: vi.fn(async () => ({ type: TYPE, status })),
      });
      const res = await approveDynamicTypeArtifactVisibility(
        { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
        d,
      );
      expect(res).toMatchObject({ ok: false, code: "not_active" });
      expect(d.reserveClaim).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "dormant", "retiring"] as const)(
    "refuses 'already_approved' when a live (%s) org default claim exists",
    async (status) => {
      const d = deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status })]) });
      const res = await approveDynamicTypeArtifactVisibility(
        { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
        d,
      );
      expect(res).toMatchObject({ ok: false, code: "already_approved" });
      expect(d.reserveClaim).not.toHaveBeenCalled();
    },
  );

  it("a RETIRED claim is not an approval — re-approval reserves a fresh record", async () => {
    const d = deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "retired" })]) });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toMatchObject({ ok: true, claimId: "claim-new" });
  });

  it("self-heals a 'reserved' claim (crash between reserve and activate): activates, no second reserve", async () => {
    const d = deps({ readClaimsForOrg: vi.fn(() => [claimRow({ status: "reserved" })]) });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toEqual({ ok: true, claimId: "claim-1", repairedReservedClaim: true });
    expect(d.reserveClaim).not.toHaveBeenCalled();
    expect(d.activateClaim).toHaveBeenCalledWith({ claimId: "claim-1", actor: "admin-1" });
  });

  it("maps a reserve-time constraint conflict to 'claim_conflict' (a concurrent approval raced)", async () => {
    const d = deps({
      reserveClaim: vi.fn(() => {
        throw new ArtifactClaimConflictError(`org:${ORG}`, TYPE);
      }),
    });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toMatchObject({ ok: false, code: "claim_conflict" });
    expect(d.activateClaim).not.toHaveBeenCalled();
  });

  it("rethrows a non-conflict infra error (never swallowed into a refusal)", async () => {
    const d = deps({
      reserveClaim: vi.fn(() => {
        throw new Error("connection refused");
      }),
    });
    await expect(
      approveDynamicTypeArtifactVisibility(
        { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
        d,
      ),
    ).rejects.toThrow("connection refused");
  });

  it("maps an ACTIVATE-time constraint conflict to 'claim_conflict' on the fresh path (never a throw)", async () => {
    const d = deps({
      activateClaim: vi.fn(() => {
        throw new ArtifactClaimConflictError(`org:${ORG}`, TYPE);
      }),
    });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toMatchObject({ ok: false, code: "claim_conflict" });
  });

  it("maps an ACTIVATE-time constraint conflict to 'claim_conflict' on the reserved self-heal path (never a throw)", async () => {
    const d = deps({
      readClaimsForOrg: vi.fn(() => [claimRow({ status: "reserved" })]),
      activateClaim: vi.fn(() => {
        throw new ArtifactClaimConflictError(`org:${ORG}`, TYPE);
      }),
    });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toMatchObject({ ok: false, code: "claim_conflict" });
    expect(d.reserveClaim).not.toHaveBeenCalled();
  });

  it("rethrows a non-conflict ACTIVATE-time infra error (never swallowed into a refusal)", async () => {
    const d = deps({
      activateClaim: vi.fn(() => {
        throw new Error("connection reset");
      }),
    });
    await expect(
      approveDynamicTypeArtifactVisibility(
        { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
        d,
      ),
    ).rejects.toThrow("connection reset");
  });

  it("activate CAS no-op ({changed:false}) + re-read shows the SAME claim live ⇒ ok (a racer completed THIS activation)", async () => {
    // Fresh path: reserve succeeds, our activate loses the CAS because a
    // concurrent self-heal decide activated 'claim-new' first — the approval
    // record is live, so this decide reports success, not a phantom conflict.
    const reads = vi
      .fn<() => ArtifactTypeClaimRow[]>()
      .mockReturnValueOnce([]) // ladder step 3: no existing record
      .mockReturnValue([claimRow({ id: "claim-new", status: "active" })]); // post-CAS re-read
    const d = deps({
      readClaimsForOrg: reads,
      activateClaim: vi.fn(() => ({ changed: false })),
    });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toEqual({ ok: true, claimId: "claim-new", repairedReservedClaim: false });
  });

  it.each<[string, ArtifactTypeClaimRow[]]>([
    ["the claim VANISHED", []],
    ["the claim is STILL 'reserved'", [claimRow({ id: "claim-new", status: "reserved" })]],
    ["a DIFFERENT claim occupies the slot", [claimRow({ id: "claim-other", status: "active" })]],
  ])(
    "activate CAS no-op ({changed:false}) + %s ⇒ 'claim_conflict', never a silent ok",
    async (_label, postCasRows) => {
      const reads = vi
        .fn<() => ArtifactTypeClaimRow[]>()
        .mockReturnValueOnce([]) // ladder step 3: no existing record
        .mockReturnValue(postCasRows);
      const d = deps({
        readClaimsForOrg: reads,
        activateClaim: vi.fn(() => ({ changed: false })),
      });
      const res = await approveDynamicTypeArtifactVisibility(
        { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
        d,
      );
      expect(res).toMatchObject({ ok: false, code: "claim_conflict" });
    },
  );

  it("self-heal path: {changed:false} + the reserved claim went live via the racer ⇒ ok with repairedReservedClaim", async () => {
    const reads = vi
      .fn<() => ArtifactTypeClaimRow[]>()
      .mockReturnValueOnce([claimRow({ status: "reserved" })]) // ladder step 3
      .mockReturnValue([claimRow({ status: "dormant" })]); // post-CAS re-read (dominated is still an approval)
    const d = deps({
      readClaimsForOrg: reads,
      activateClaim: vi.fn(() => ({ changed: false })),
    });
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toEqual({ ok: true, claimId: "claim-1", repairedReservedClaim: true });
    expect(d.reserveClaim).not.toHaveBeenCalled();
  });
});

describe("approveDynamicTypeArtifactVisibility — the approval write", () => {
  it("reserves an org-scoped DEFAULT floor claim with the conservative dispositions, then activates it", async () => {
    const d = deps();
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(res).toEqual({ ok: true, claimId: "claim-new", repairedReservedClaim: false });
    expect(d.reserveClaim).toHaveBeenCalledWith({
      scope: `org:${ORG}`,
      objectTypeId: TYPE,
      claimKind: "default",
      extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
      extensionVersion: "0.1.0",
      installId: null,
      dispositions: CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
      actor: "admin-1",
    });
    expect(d.activateClaim).toHaveBeenCalledWith({ claimId: "claim-new", actor: "admin-1" });
  });

  it("falls back to the UNKNOWN_FLOOR_VERSION sentinel when no live floor install row is readable", async () => {
    const d = deps({ readInstalledFloorVersion: vi.fn(async () => null) });
    await approveDynamicTypeArtifactVisibility(
      { orgId: ORG, objectTypeId: TYPE, approvedBy: "admin-1" },
      d,
    );
    expect(d.reserveClaim).toHaveBeenCalledWith(
      expect.objectContaining({ extensionVersion: UNKNOWN_FLOOR_VERSION }),
    );
  });
});

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

  it("ignores claim rows that are not the org-scoped floor DEFAULT claim (other org / kind / claimant)", async () => {
    const noise: ArtifactTypeClaimRow[] = [
      claimRow({ id: "c-platform", scope: "platform" }),
      claimRow({ id: "c-dedicated", claimKind: "dedicated", extensionPackage: "@vendor/x-artifact" }),
      claimRow({ id: "c-other-ext", extensionPackage: "@vendor/y-artifact" }),
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
    // A crash between reserve and activate must never make the row vanish
    // from the Inbox — deciding it again routes into the approve self-heal.
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
