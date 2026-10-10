import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn(), access: vi.fn(), gate: vi.fn(), artifact: vi.fn(), member: vi.fn() }));
vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => db }));
vi.mock("@/lib/postgres-config", () => ({ getPostgresConnectionString: () => "unused", postgresSchema: "cinatra" }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
import { readRevisionImagePrompt } from "@/lib/artifacts/materialization-ledger";
const pin = { orgId: "org", artifactId: "artifact", representationRevisionId: "pinned-old-revision" };
beforeEach(() => { vi.clearAllMocks(); });
describe("approved app-artifact-review §VI pinned producer words", () => {
  it("binds org, artifact and the pinned revision, excludes unfinalized rows and preserves exact producer words", async () => {
    db.query.mockResolvedValue({ rows: [{ image_prompt: "  a red fox in snow  " }] });
    expect(await readRevisionImagePrompt(pin)).toBe("  a red fox in snow  ");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("phase = 'finalized'"), ["org", "artifact", "pinned-old-revision"]);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3");
    expect(sql).not.toContain("current_revision");
  });
  for (const rows of [[], [{ image_prompt: null }], [{ image_prompt: 42 }], [{ image_prompt: "  " }], [{ image_prompt: "one" }, { image_prompt: "other" }]]) {
    it(`does not invent words from absent, malformed or ambiguous finalized evidence: ${JSON.stringify(rows)}`, async () => {
      db.query.mockResolvedValue({ rows }); expect(await readRevisionImagePrompt(pin)).toBeNull();
    });
  }
  it("does not reuse the prior organization's read or swap to a live revision", async () => {
    db.query.mockResolvedValue({ rows: [] });
    await readRevisionImagePrompt(pin);
    await readRevisionImagePrompt({ ...pin, orgId: "other-org", representationRevisionId: "other-pin" });
    expect(db.query.mock.calls[1][1]).toEqual(["other-org", "artifact", "other-pin"]);
  });
});

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({ enforceReviewRunAccess: db.access, readReviewGateState: db.gate, readGatePinnedTargets: vi.fn(), readReviewGate: vi.fn(), commitReviewDecision: vi.fn() }));
vi.mock("@cinatra-ai/agents/lifecycle-review-changes-requested", () => ({ recordReviewSurfaceChangesRequested: vi.fn() }));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({ readRepairBySuccessorGateId: vi.fn() }));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({ readPinnedPreviewCaptures: vi.fn() }));
vi.mock("@/app/artifacts/[id]/review-target-prepare", () => ({ bindArtifactReviewPorts: () => ({ readArtifact: db.artifact, revisionMember: db.member }), prepareArtifactReviewTargets: vi.fn() }));
import { readReviewGateRecordedPrompt } from "../review-gate-ports";
const actorCtx = { orgId: "org", actor: { actorType: "human" as const, source: "route" as const, userId: "reader" }, roleHints: { actorOrganizationId: "org" } };
describe("§VI genuine prompt binder enforces read and pinned revision membership", () => {
  beforeEach(() => {
    db.access.mockResolvedValue({ ok: true }); db.gate.mockResolvedValue({ status: "pending", targets: [{ artifactId: "artifact", representationRevisionId: "pinned-old-revision" }] });
    db.artifact.mockResolvedValue({ kind: "ok", artifact: {} }); db.member.mockResolvedValue({ mime: "image/png" }); db.query.mockResolvedValue({ rows: [{ image_prompt: "producer words" }] });
  });
  it("only authorized, org-scoped, pinned finalized words reach the floor", async () => {
    expect(await readReviewGateRecordedPrompt({ runId: "run", reviewTaskId: "task", actorCtx })).toBe("producer words");
    expect(db.access).toHaveBeenCalledWith("run", actorCtx.actor, "read", actorCtx.roleHints);
    expect(db.member).toHaveBeenCalledWith("artifact", "pinned-old-revision");
    expect(db.query.mock.calls[0][1]).toEqual(["org", "artifact", "pinned-old-revision"]);
    expect(db.access.mock.invocationCallOrder[0]).toBeLessThan(db.gate.mock.invocationCallOrder[0]);
    expect(db.member.mock.invocationCallOrder[0]).toBeLessThan(db.query.mock.invocationCallOrder[0]);
  });
  it("denied reader cannot discover gate or words", async () => {
    db.access.mockResolvedValue({ ok: false }); expect(await readReviewGateRecordedPrompt({ runId: "run", reviewTaskId: "task", actorCtx })).toBeNull();
    expect(db.gate).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  });
  it("a foreign or unavailable artifact cannot read the ledger", async () => {
    db.artifact.mockResolvedValue({ kind: "not-authorized" }); expect(await readReviewGateRecordedPrompt({ runId: "run", reviewTaskId: "task", actorCtx })).toBeNull(); expect(db.member).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  });
  it("substituted/unlinked revision and multi-target legacy gate cannot provide a prefill", async () => {
    db.member.mockResolvedValue(null); expect(await readReviewGateRecordedPrompt({ runId: "run", reviewTaskId: "task", actorCtx })).toBeNull(); expect(db.query).not.toHaveBeenCalled();
    db.gate.mockResolvedValue({ status: "pending", targets: [{}, {}] }); expect(await readReviewGateRecordedPrompt({ runId: "run", reviewTaskId: "task", actorCtx })).toBeNull(); expect(db.query).not.toHaveBeenCalled();
  });
});
