/**
 * Behaviour + authorization proof for the two v1 ApprovalSource adapters.
 *
 * Agent-creation-requests source:
 *  - NON-ADMIN Inbox performs NO admin fetch and returns an empty ready
 *    envelope (no admin-data leak);
 *  - SINGLE-ADMIN self-approval BOTH cases: the sole eligible approver sees
 *    their OWN proposal in Inbox flagged isOwnRequest; when another admin
 *    exists the own proposal is Mine-only (excluded from Inbox), mirroring the
 *    decide primitive's SoD guard EXACTLY so Inbox never shows an unclearable
 *    row;
 *  - "Your requests" default window = in-flight + last-30-days decided, with a
 *    whitelisted ?status= history filter;
 *  - appliesTo gates direction WITHOUT a privileged fetch.
 *
 * Workflow legacy passthrough: Inbox-only; a Mine fetch is an empty ready
 * envelope; a decide call is a benign refusal (decided from the workflow page).
 *
 * The store / admin-count / connector-config / decision-helper / client-action
 * dependencies are mocked so the adapters are exercised with no DB and no React
 * render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ store: { rows: [] as Record<string, unknown>[] } }));

vi.mock("@/lib/agent-creation-requests-store", () => ({
  listAgentCreationRequests: vi.fn(
    (input: { orgId: string; authorId?: string; status?: string }) => {
      let out = h.store.rows;
      if (input.authorId) out = out.filter((r) => r.authorId === input.authorId);
      if (input.status && input.status !== "all") {
        out = out.filter((r) => r.status === input.status);
      }
      return out.map((r) => ({ ...r }));
    },
  ),
}));
vi.mock("@/lib/better-auth-db", () => ({ countOtherPlatformAdmins: vi.fn() }));
vi.mock("@/lib/database", () => ({ readConnectorConfigFromDatabase: () => ({}) }));
vi.mock("../agent-decision-actions", () => ({ AgentDecisionActions: () => null }));
vi.mock("@cinatra-ai/agents/mcp-handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({}),
}));
vi.mock("@cinatra-ai/workflows/store", () => ({
  listPendingApprovalsForOrg: vi.fn(async () => []),
  countPendingWorkflowApprovalsForOrg: vi.fn(async () => 0),
}));

import { listAgentCreationRequests } from "@/lib/agent-creation-requests-store";
import { countOtherPlatformAdmins } from "@/lib/better-auth-db";
import { agentCreationRequestsSource } from "../sources/agent-creation-requests";
import { workflowLegacyPassthroughSource } from "../sources/workflow-legacy-passthrough";
import type { ApprovalViewer } from "../sources/types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

const DAY = 24 * 60 * 60 * 1000;

function mkRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r-" + Math.random().toString(36).slice(2, 8),
    authorId: "u-other",
    packageSlug: "acme-agent",
    packageName: "acme-agent",
    packageVersion: "1.0.0",
    status: "proposed",
    createdAt: new Date().toISOString(),
    snapshotHash: "hash",
    decidedAt: null,
    rejectionReason: null,
    ...over,
  };
}

beforeEach(() => {
  h.store.rows = [];
  vi.mocked(listAgentCreationRequests).mockClear();
  vi.mocked(countOtherPlatformAdmins).mockReset();
});

describe("agentCreationRequestsSource.appliesTo (no privileged fetch)", () => {
  it("Inbox is admin-only; Mine is open to any author", () => {
    expect(agentCreationRequestsSource.appliesTo(admin, "inbox")).toBe(true);
    expect(agentCreationRequestsSource.appliesTo(member, "inbox")).toBe(false);
    expect(agentCreationRequestsSource.appliesTo(member, "mine")).toBe(true);
    expect(agentCreationRequestsSource.appliesTo(admin, "mine")).toBe(true);
  });
});

describe("agentCreationRequestsSource.fetchInbox", () => {
  it("a NON-ADMIN gets an empty ready envelope and NO admin fetch is issued (no leak)", async () => {
    h.store.rows = [mkRow({ authorId: "u-x", status: "proposed" })];
    const env = await agentCreationRequestsSource.fetchInbox(member);
    expect(env.availability).toBe("ready");
    expect(env.rows).toEqual([]);
    expect(vi.mocked(listAgentCreationRequests)).not.toHaveBeenCalled();
  });

  it("an admin sees OTHER authors' proposals (not own-flagged)", async () => {
    h.store.rows = [
      mkRow({ id: "r1", authorId: "u-other", status: "proposed" }),
      mkRow({ id: "r2", authorId: "u-other2", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(env.rows.every((r) => !r.isOwnRequest)).toBe(true);
    expect(env.rows[0].sourceId).toBe("agent-creation-requests");
  });

  it("SINGLE-ADMIN self-approval: the SOLE approver sees their OWN proposal in Inbox (isOwnRequest)", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ id: "own", authorId: "u-admin", status: "proposed" }),
      mkRow({ id: "other", authorId: "u-other", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    const own = env.rows.find((r) => r.id === "own");
    expect(own?.isOwnRequest).toBe(true);
    expect(env.rows.map((r) => r.id).sort()).toEqual(["other", "own"]);
    expect(vi.mocked(countOtherPlatformAdmins)).toHaveBeenCalledWith("u-admin");
  });

  it("SoD: when ANOTHER admin exists the own proposal is EXCLUDED from Inbox (Mine-only)", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(1);
    h.store.rows = [
      mkRow({ id: "own", authorId: "u-admin", status: "proposed" }),
      mkRow({ id: "other", authorId: "u-other", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id)).toEqual(["other"]);
  });
});

describe('agentCreationRequestsSource.fetchMine ("Your requests" window)', () => {
  beforeEach(() => {
    h.store.rows = [
      mkRow({ id: "p", authorId: "u-admin", status: "proposed", decidedAt: null }),
      mkRow({
        id: "recent",
        authorId: "u-admin",
        status: "rejected",
        decidedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      }),
      mkRow({
        id: "old",
        authorId: "u-admin",
        status: "rejected",
        decidedAt: new Date(Date.now() - 60 * DAY).toISOString(),
      }),
      mkRow({
        id: "oldapproved",
        authorId: "u-admin",
        status: "approved",
        decidedAt: new Date(Date.now() - 60 * DAY).toISOString(),
      }),
      // a different author's row must never appear in the viewer's Mine
      mkRow({ id: "stranger", authorId: "u-other", status: "proposed" }),
    ];
  });

  it("default window = in-flight + last-30-days decided (old decisions excluded)", async () => {
    const env = await agentCreationRequestsSource.fetchMine(admin);
    expect(env.rows.map((r) => r.id).sort()).toEqual(["p", "recent"]);
  });

  it("?status=all returns the full own history", async () => {
    const env = await agentCreationRequestsSource.fetchMine(admin, { status: "all" });
    expect(env.rows.map((r) => r.id).sort()).toEqual([
      "old",
      "oldapproved",
      "p",
      "recent",
    ]);
  });

  it("?status=rejected narrows to that status regardless of age", async () => {
    const env = await agentCreationRequestsSource.fetchMine(admin, { status: "rejected" });
    expect(env.rows.map((r) => r.id).sort()).toEqual(["old", "recent"]);
  });
});

describe("agentCreationRequestsSource.counts", () => {
  it("admin (sole approver) counts own + others' proposals; non-admin inbox is 0", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ authorId: "u-admin", status: "proposed" }),
      mkRow({ authorId: "u-other", status: "proposed" }),
    ];
    await expect(agentCreationRequestsSource.counts(admin)).resolves.toEqual({
      inbox: 2,
      mine: 1,
    });

    h.store.rows = [mkRow({ authorId: "u-member", status: "proposed" })];
    const c = await agentCreationRequestsSource.counts(member);
    expect(c.inbox).toBe(0);
    expect(c.mine).toBe(1);
  });
});

describe("workflowLegacyPassthroughSource", () => {
  it("is Inbox-only (no v1 'Your requests' view)", () => {
    expect(workflowLegacyPassthroughSource.appliesTo(member, "inbox")).toBe(true);
    expect(workflowLegacyPassthroughSource.appliesTo(admin, "mine")).toBe(false);
  });

  it("fetchMine is an empty ready envelope", async () => {
    const env = await workflowLegacyPassthroughSource.fetchMine(admin);
    expect(env).toMatchObject({ availability: "ready", rows: [], actions: [] });
  });

  it("decide is a benign refusal (decided from the workflow page)", async () => {
    const r = await workflowLegacyPassthroughSource.actions.decide(
      { rowId: "x", action: "approve" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "not_supported" });
  });
});
