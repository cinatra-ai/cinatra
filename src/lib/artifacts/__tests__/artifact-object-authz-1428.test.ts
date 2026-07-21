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
// Effective-identity resolver stubbed (no DB) — summaries get the floor
// identity; this suite exercises only the authz axis (cinatra#1426).
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
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

  // cinatra#1431 §III: the detail route must DISTINGUISH not-found from
  // read-denied so a list-visible-but-read-denied row opens the not-authorized
  // panel (never a bare 404, never its bytes).
  it("readArtifactForDetail: not-found when the store denies/omits the row (ownership filter → null)", async () => {
    const { readArtifactForDetail } = await import("../artifact-service");
    getObjectById.mockReturnValue(null);
    expect(
      readArtifactForDetail({ artifactId: "gone", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "not-found" });
  });

  it("readArtifactForDetail: not-found when the row is not an artifact type", async () => {
    const { readArtifactForDetail } = await import("../artifact-service");
    getObjectById.mockReturnValue(row({ type: "@cinatra-ai/email:send-attempt" }));
    expect(
      readArtifactForDetail({ artifactId: "a1", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "not-found" });
  });

  it("readArtifactForDetail: DENIED (not 404) when the row lists but object.read refuses — the spec's 'may list but not read'", async () => {
    const { readArtifactForDetail } = await import("../artifact-service");
    // The store returned the artifact row (ownership filter passed ⇒ the actor
    // can LIST it), but a ServiceAccount holds no object.read: the canonical
    // kernel refuses. This is DENIED, distinct from not-found.
    getObjectById.mockReturnValue(row());
    const svc = member({
      principalType: "ServiceAccount",
      principalId: "svc-1",
      orgRole: undefined,
    } as Partial<ActorContext>);
    expect(
      readArtifactForDetail({ artifactId: "a1", orgId: ORG, actor: svc }),
    ).toEqual({ kind: "denied" });
  });

  it("readArtifactForDetail: ok for an org member passing object.read", async () => {
    const { readArtifactForDetail } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    const res = readArtifactForDetail({ artifactId: "a1", orgId: ORG, actor: member() });
    expect(res.kind).toBe("ok");
    expect(res.kind === "ok" && res.artifact.artifactId).toBe("a1");
  });

  // cinatra#1892 B2 — a USER meaning assertion MUTATES the artifact identity,
  // so `readArtifactForMeaningWrite` must enforce canonical `object.update`
  // (WRITE authority), not merely `object.read`. A reader of a shared artifact
  // must NOT be able to write a meaning on it.
  it("readArtifactForMeaningWrite: DENIES a read-only member on a row they do NOT own (object.update is admin-tier)", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    // Org-owned row: the member can object.read (member policy) + LIST it, but
    // object.update is an org_admin-tier grant — a mere reader is denied WRITE.
    getObjectById.mockReturnValue(row());
    expect(
      readArtifactForMeaningWrite({ artifactId: "a1", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "denied" });
  });

  it("readArtifactForMeaningWrite: DENIES a member who can read someone ELSE'S user-owned artifact (shared reader, not owner)", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    // Row owned by user u-other; the acting member (u1) can list/read a shared
    // row but is neither owner nor admin ⇒ no object.update ⇒ WRITE denied.
    getObjectById.mockReturnValue(row({ ownerLevel: "user", ownerId: "u-other" }));
    expect(
      readArtifactForMeaningWrite({ artifactId: "a1", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "denied" });
  });

  it("readArtifactForMeaningWrite: owner short-circuit lets the UPLOADER write a meaning on their OWN user-owned artifact", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    // Uploader-owned (cinatra#1930): the user-owner short-circuit grants
    // object.update on their own row.
    getObjectById.mockReturnValue(row({ ownerLevel: "user", ownerId: "u1" }));
    const res = readArtifactForMeaningWrite({ artifactId: "a1", orgId: ORG, actor: member() });
    expect(res.kind).toBe("ok");
    expect(res.kind === "ok" && res.artifact.artifactId).toBe("a1");
  });

  it("readArtifactForMeaningWrite: org_admin passes object.update on an org-owned row (admin-tier grant)", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    const res = readArtifactForMeaningWrite({
      artifactId: "a1",
      orgId: ORG,
      actor: member({ principalId: "admin", orgRole: "org_admin" } as Partial<ActorContext>),
    });
    expect(res.kind).toBe("ok");
  });

  it("readArtifactForMeaningWrite: not-found when the store omits the row (ownership filter → null)", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    getObjectById.mockReturnValue(null);
    expect(
      readArtifactForMeaningWrite({ artifactId: "gone", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "not-found" });
  });

  it("readArtifactForMeaningWrite: not-found when the row is not an artifact type", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    getObjectById.mockReturnValue(row({ type: "@cinatra-ai/email:send-attempt" }));
    expect(
      readArtifactForMeaningWrite({ artifactId: "a1", orgId: ORG, actor: member() }),
    ).toEqual({ kind: "not-found" });
  });

  it("readArtifactForMeaningWrite: DENIED when the row lists but object.read refuses (read gate precedes the write gate)", async () => {
    const { readArtifactForMeaningWrite } = await import("../artifact-service");
    getObjectById.mockReturnValue(row());
    const svc = member({
      principalType: "ServiceAccount",
      principalId: "svc-1",
      orgRole: undefined,
    } as Partial<ActorContext>);
    expect(
      readArtifactForMeaningWrite({ artifactId: "a1", orgId: ORG, actor: svc }),
    ).toEqual({ kind: "denied" });
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
