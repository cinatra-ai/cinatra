/**
 * POST /api/auditor/apply — per-item accept over the immutable proposal
 * snapshot + single-use SoD receipt (cinatra#1625).
 *
 * Covers the trust-boundary invariants:
 *   - NEW envelope { acceptedPatchIds, dismissedPatchIds, excludedPromptIds }.
 *   - acceptedPatchIds MUST be a subset of the ONE snapshot's patch_ids (no
 *     union of retry rows); a non-snapshot id => 400.
 *   - a single-use receipt is consumed; a second apply / forged replay (no live
 *     receipt) => 403.
 *   - no snapshot for the run => 409 (fail closed).
 *   - patch CONTENT is sourced from the snapshot, never the request body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const bridge = vi.hoisted(() => ({ authed: true }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => bridge.authed,
}));
vi.mock("@/lib/auth-session", () => ({
  isPlatformAdmin: () => false,
  requireAuthSession: vi.fn(async () => null),
}));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: vi.fn(async () => ({ ok: true, runId: "run-1" })),
}));

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(async () => ({ id: "run-1", runBy: "u1", orgId: "o1" })),
  readRunCoOwners: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: store.readAgentRunById,
  readRunCoOwners: store.readRunCoOwners,
}));

const apply = vi.hoisted(() => ({
  applyAuditorPatches: vi.fn((data: unknown) => ({ ...(data as object), applied: true })),
}));
vi.mock("@cinatra-ai/agents/auditor-apply", () => ({
  applyAuditorPatches: apply.applyAuditorPatches,
  AuditorApplyError: class extends Error {},
}));

const snap = vi.hoisted(() => ({
  readProposalSnapshotForRun: vi.fn(),
  consumeApprovalReceipt: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/auditor-snapshot-store", () => ({
  readProposalSnapshotForRun: snap.readProposalSnapshotForRun,
  consumeApprovalReceipt: snap.consumeApprovalReceipt,
}));

const persist = vi.hoisted(() => ({ persistAcceptedAuditorSkill: vi.fn(async () => ({ persisted: true })) }));
vi.mock("@/lib/auditor/persist-accepted-skill", () => ({
  persistAcceptedAuditorSkill: persist.persistAcceptedAuditorSkill,
}));

import { POST } from "../route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/auditor/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SNAPSHOT = {
  id: "snap-1",
  agentRunId: "run-1",
  preview: { name: "s", description: "d", content: "c", patches: [] },
  patches: [
    { id: "p1", fieldPath: "/a", op: "replace", value: "1", message: "m" },
    { id: "p2", fieldPath: "/b", op: "replace", value: "2", message: "m" },
  ],
  patchIds: ["p1", "p2"],
  inputDataDigest: "digest",
  snapshotHash: "hash-1",
  edited: "edited",
  createdAt: new Date(),
};

function envelope(accepted: string[], dismissed: string[] = [], excluded: string[] = []): string {
  return JSON.stringify({
    acceptedPatchIds: accepted,
    dismissedPatchIds: dismissed,
    excludedPromptIds: excluded,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.authed = true;
  store.readAgentRunById.mockResolvedValue({ id: "run-1", runBy: "u1", orgId: "o1" });
  snap.readProposalSnapshotForRun.mockResolvedValue(SNAPSHOT);
  snap.consumeApprovalReceipt.mockResolvedValue({ id: "r1", snapshotHash: "hash-1" });
});

describe("POST /api/auditor/apply", () => {
  it("applies accepted subset, consumes the receipt, persists per-item", async () => {
    const res = await POST(
      makeReq({ agent_run_id: "run-1", parentPackageName: "@x/agent", data: { a: 0 }, reviewResult: envelope(["p1"]) }),
    );
    expect(res.status).toBe(200);
    expect(snap.consumeApprovalReceipt).toHaveBeenCalledWith({ agentRunId: "run-1", snapshotHash: "hash-1" });
    // patch content came from the snapshot, not the body
    expect(apply.applyAuditorPatches).toHaveBeenCalledWith({ a: 0 }, SNAPSHOT.patches, ["p1"]);
    expect(persist.persistAcceptedAuditorSkill).toHaveBeenCalled();
  });

  it("rejects a non-snapshot accepted id (400) before consuming any receipt", async () => {
    const res = await POST(makeReq({ agent_run_id: "run-1", data: {}, reviewResult: envelope(["p1", "ROGUE"]) }));
    expect(res.status).toBe(400);
    expect(snap.consumeApprovalReceipt).not.toHaveBeenCalled();
  });

  it("rejects when there is no live receipt (403) — second apply / forged replay", async () => {
    snap.consumeApprovalReceipt.mockResolvedValue(null);
    const res = await POST(makeReq({ agent_run_id: "run-1", data: {}, reviewResult: envelope(["p1"]) }));
    expect(res.status).toBe(403);
    expect(apply.applyAuditorPatches).not.toHaveBeenCalled();
  });

  it("fails closed (409) when there is no snapshot for the run", async () => {
    snap.readProposalSnapshotForRun.mockResolvedValue(null);
    const res = await POST(makeReq({ agent_run_id: "run-1", data: {}, reviewResult: envelope(["p1"]) }));
    expect(res.status).toBe(409);
  });

  it("rejects a malformed reviewResult envelope (400)", async () => {
    const res = await POST(makeReq({ agent_run_id: "run-1", data: {}, reviewResult: "not json" }));
    expect(res.status).toBe(400);
  });

  it("rejects the legacy envelope shape (acceptedIds) (400)", async () => {
    const res = await POST(
      makeReq({ agent_run_id: "run-1", data: {}, reviewResult: JSON.stringify({ acceptedIds: ["p1"], dismissedIds: [] }) }),
    );
    expect(res.status).toBe(400);
  });
});
