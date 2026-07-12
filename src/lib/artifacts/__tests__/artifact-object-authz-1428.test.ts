/**
 * cinatra#1428 — artifact surfaces enforce CANONICAL `object.*` authorization
 * (RBAC matrix) plus surface gating, and delete rides the canonical object
 * soft-delete path.
 *
 * Object store is mocked (no DB): these tests drive the SERVICE-level gates —
 * the kernel `object.read` post-filter on get/list and the `object.delete`
 * gate on tombstone — with the REAL authz kernel (`can()` + the shared sync
 * decision core), proving the artifact surface applies the same decision the
 * objects surface enforces via `enforceResourceAccess`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();
const retentionTombstone = vi.fn();

vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({
  tombstoneArtifact: (i: unknown) => retentionTombstone(i),
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
}));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
  listArtifactIdsForExtension: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));

import type { ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-A";
const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    type: ARTIFACT_TYPE,
    data: { artifactType: "file", title: "T", mime: "x/y", size: 1, originKind: "upload" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orgId: ORG,
    ownerLevel: "organization",
    ownerId: ORG,
    visibility: "org",
    projectId: null,
    ...over,
  };
}

function member(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: ORG,
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "test",
    ...over,
  } as ActorContext;
}

describe("cinatra#1428 artifact-surface canonical object authorization", () => {
  beforeEach(() => {
    listObjectsByFilter.mockReset();
    getObjectById.mockReset();
    retentionTombstone.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("getArtifact: org member passes object.read on an org-owned row", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    expect(
      getArtifact({ artifactId: "a1", orgId: ORG, actor: member() }),
    ).not.toBeNull();
  });

  it("getArtifact: role WITHOUT object.read (kernel denial) 404-hides the row even when the ownership filter passed", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    // ServiceAccount principals hold only {agent.execute, run.read} — no
    // object.read. The mocked store "returned" the row (data-axis pass);
    // the canonical kernel gate must still hide it, exactly like the
    // objects surface's enforceResourceAccess post-filter.
    const svc = member({
      principalType: "ServiceAccount",
      principalId: "svc-1",
      orgRole: undefined,
    } as Partial<ActorContext>);
    expect(getArtifact({ artifactId: "a1", orgId: ORG, actor: svc })).toBeNull();
  });

  it("getArtifact: OBO-confined actor outside its anchor is hidden (ceiling precedes short-circuits)", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row({ ownerLevel: "user", ownerId: "u1" }));
    const confined = member({
      oboCeiling: [{ tier: "team", id: "team-elsewhere" }],
    } as Partial<ActorContext>);
    expect(
      getArtifact({ artifactId: "a1", orgId: ORG, actor: confined }),
    ).toBeNull();
  });

  it("listArtifacts: kernel post-filter drops rows the objects surface would deny", async () => {
    const { listArtifacts } = await import("../artifact-service");
    listObjectsByFilter.mockReturnValue([
      row({ id: "keep" }),
      row({ id: "drop", orgId: "org-B", ownerId: "org-B" }), // cross-org
    ]);
    const out = listArtifacts({ orgId: ORG, actor: member() });
    expect(out.map((a) => a.artifactId)).toEqual(["keep"]);
  });

  it("tombstone: member is denied object.delete on an org-owned row (admin-tier grant)", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    expect(() =>
      tombstoneArtifact({ orgId: ORG, artifactId: "a1", actor: member() }),
    ).toThrow(/object\.delete denied/);
    expect(retentionTombstone).not.toHaveBeenCalled();
  });

  it("tombstone: org_admin passes object.delete; changeSetId is surfaced for Undo", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    retentionTombstone.mockReturnValue({
      referenced: false,
      pinCount: 0,
      changeSetId: "cs_legacy_x",
    });
    const res = tombstoneArtifact({
      orgId: ORG,
      artifactId: "a1",
      actor: member({ principalId: "admin", orgRole: "org_admin" } as Partial<ActorContext>),
      auditActor: "admin",
    });
    expect(res.changeSetId).toBe("cs_legacy_x");
    expect(retentionTombstone).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: "a1",
      actor: "admin",
      actorKind: "user",
    });
  });

  it("tombstone: owner short-circuit lets a member delete their OWN user-owned artifact", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(row({ ownerLevel: "user", ownerId: "u1" }));
    retentionTombstone.mockReturnValue({
      referenced: false,
      pinCount: 0,
      changeSetId: "cs_legacy_y",
    });
    expect(
      tombstoneArtifact({
        orgId: ORG,
        artifactId: "a1",
        actor: member(),
        auditActor: "u1",
      }).changeSetId,
    ).toBe("cs_legacy_y");
  });

  it("tombstone: visibility-filtered row (store returns null) 404s before any kernel decision", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(null);
    expect(() =>
      tombstoneArtifact({ orgId: ORG, artifactId: "hidden", actor: member() }),
    ).toThrow(/not found or not permitted/);
    expect(retentionTombstone).not.toHaveBeenCalled();
  });

  it("internal callers (no actor) keep the trusted path: no kernel gate, system attribution", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    retentionTombstone.mockReturnValue({
      referenced: false,
      pinCount: 0,
      changeSetId: null,
    });
    tombstoneArtifact({ orgId: ORG, artifactId: "a1" });
    expect(getObjectById).not.toHaveBeenCalled();
    expect(retentionTombstone).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: "a1",
      actor: null,
      actorKind: "system",
    });
  });
});
