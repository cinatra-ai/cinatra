/**
 * Behaviour + authorization proof for the two v1 ApprovalSource adapters.
 *
 * Agent-creation-requests source:
 *  - NON-ADMIN Inbox performs NO admin fetch and returns an empty ready
 *    envelope (no admin-data leak);
 *  - a proposal the viewer AUTHORED is never Inbox work — it is excluded from
 *    the Inbox (and its count) under EVERY admin configuration, sole approver
 *    or not; it lives only under "Your requests";
 *  - on "Your requests" a pending own row gains the inline decide affordance
 *    (raw.decidableOwn) EXACTLY when the viewer may approve their own (sole
 *    platform admin OR allowSelfApproval); a decided own row never does, and a
 *    row renders the decide control iff decidableOwn. The decide handler's
 *    server-side authorization is untouched — this is a surfacing change only;
 *  - "Your requests" default window = in-flight + last-30-days decided, with a
 *    whitelisted ?status= history filter;
 *  - appliesTo gates direction WITHOUT a privileged fetch.
 *
 * Workflow legacy passthrough: Inbox-only; a Mine fetch is an empty ready
 * envelope; a decide call is a benign refusal (decided from the workflow page).
 *
 * The store / admin-count / connector-config / decision-helper dependencies are
 * mocked so the adapters are exercised with no DB. AgentDecisionActions is
 * mocked to an identifiable sentinel so a render proves WHICH rows carry the
 * inline decide control (vs a plain Details link).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  store: { rows: [] as Record<string, unknown>[] },
  config: {} as Record<string, unknown>,
}));

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
vi.mock("@/lib/database", () => ({ readConnectorConfigFromDatabase: () => h.config }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require("react");
    return React.createElement("a", { href }, children as never);
  },
}));
vi.mock("../agent-decision-actions", () => ({
  AgentDecisionActions: (props: { rowId: string; expectedVersion: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require("react");
    return React.createElement(
      "button",
      { "data-decide": props.rowId, "data-expected-version": props.expectedVersion },
      "Approve",
    );
  },
}));
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
import type { ApprovalRow, ApprovalViewer, Direction } from "../sources/types";

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

/** Read the adapter-private decidableOwn flag stashed on a row's raw payload. */
function decidableOwn(row: ApprovalRow): boolean {
  return Boolean((row.raw as { decidableOwn?: boolean } | undefined)?.decidableOwn);
}

beforeEach(() => {
  h.store.rows = [];
  h.config = {};
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

describe("agentCreationRequestsSource.fetchInbox — own is Your-requests-only", () => {
  it("a NON-ADMIN gets an empty ready envelope and NO admin fetch is issued (no leak)", async () => {
    h.store.rows = [mkRow({ authorId: "u-x", status: "proposed" })];
    const env = await agentCreationRequestsSource.fetchInbox(member);
    expect(env.availability).toBe("ready");
    expect(env.rows).toEqual([]);
    expect(vi.mocked(listAgentCreationRequests)).not.toHaveBeenCalled();
  });

  it("an admin sees OTHER authors' proposals", async () => {
    h.store.rows = [
      mkRow({ id: "r1", authorId: "u-other", status: "proposed" }),
      mkRow({ id: "r2", authorId: "u-other2", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(env.rows[0].sourceId).toBe("agent-creation-requests");
  });

  it("the SOLE approver's OWN proposal is EXCLUDED from Inbox (never inbox work)", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ id: "own", authorId: "u-admin", status: "proposed" }),
      mkRow({ id: "other", authorId: "u-other", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id)).toEqual(["other"]);
  });

  it("with allowSelfApproval configured the OWN proposal is STILL excluded from Inbox", async () => {
    h.config = { allowSelfApproval: true };
    h.store.rows = [
      mkRow({ id: "own", authorId: "u-admin", status: "proposed" }),
      mkRow({ id: "other", authorId: "u-other", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id)).toEqual(["other"]);
  });

  it("when ANOTHER admin exists the own proposal is EXCLUDED from Inbox", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(1);
    h.store.rows = [
      mkRow({ id: "own", authorId: "u-admin", status: "proposed" }),
      mkRow({ id: "other", authorId: "u-other", status: "proposed" }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows.map((r) => r.id)).toEqual(["other"]);
  });
});

describe("agentCreationRequestsSource — human-readable row title (owner #1302 ask 1)", () => {
  it("uses the OAS display name (`oas.name`), NEVER the @scope/package identifier", async () => {
    h.store.rows = [
      mkRow({
        id: "d1",
        authorId: "u-other",
        status: "proposed",
        packageName: "@acme/meeting-summarizer-agent",
        packageVersion: "0.1.0",
        packageSlug: "meeting-summarizer-agent",
        proposalSnapshot: {
          oas: { name: "Meeting Summarizer" },
          packageJson: { name: "@acme/meeting-summarizer-agent" },
        },
      }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows[0].title).toBe("Meeting Summarizer");
    expect(env.rows[0].title).not.toContain("@acme");
    expect(env.rows[0].title).not.toContain("0.1.0");
  });

  it("falls back to the packageJson manifest displayName when the OAS has no name", async () => {
    h.store.rows = [
      mkRow({
        id: "d2",
        authorId: "u-other",
        status: "proposed",
        packageName: "@acme/lead-enrichment-agent",
        proposalSnapshot: {
          oas: {},
          packageJson: { name: "@acme/lead-enrichment-agent", cinatra: { displayName: "Lead Enrichment" } },
        },
      }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows[0].title).toBe("Lead Enrichment");
  });

  it("last-resort fallback humanizes the slug (never the raw packageName)", async () => {
    h.store.rows = [
      mkRow({
        id: "d3",
        authorId: "u-other",
        status: "proposed",
        packageName: "@acme/chat-support-triage-agent",
        packageSlug: "chat-support-triage-agent",
        // no snapshot metadata at all
        proposalSnapshot: undefined,
      }),
    ];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    expect(env.rows[0].title).toBe("Chat Support Triage Agent");
    expect(env.rows[0].title).not.toContain("@acme");
  });
});

describe('agentCreationRequestsSource.fetchMine ("Your requests" window)', () => {
  beforeEach(() => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(1); // window tests: not decidable
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
    expect(env.rows.map((r) => r.id).sort()).toEqual(["old", "oldapproved", "p", "recent"]);
  });

  it("?status=rejected narrows to that status regardless of age", async () => {
    const env = await agentCreationRequestsSource.fetchMine(admin, { status: "rejected" });
    expect(env.rows.map((r) => r.id).sort()).toEqual(["old", "recent"]);
  });
});

describe("agentCreationRequestsSource.fetchMine — self-decide affordance (viewerMayApproveOwn)", () => {
  it("SOLE admin: the pending own row is decidable, a decided own row is NOT", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ id: "p", authorId: "u-admin", status: "proposed", decidedAt: null }),
      mkRow({
        id: "recent",
        authorId: "u-admin",
        status: "rejected",
        decidedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      }),
    ];
    const env = await agentCreationRequestsSource.fetchMine(admin);
    expect(decidableOwn(env.rows.find((r) => r.id === "p")!)).toBe(true);
    expect(decidableOwn(env.rows.find((r) => r.id === "recent")!)).toBe(false);
  });

  it("allowSelfApproval configured: pending own row is decidable EVEN with other admins", async () => {
    h.config = { allowSelfApproval: true };
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(3);
    h.store.rows = [mkRow({ id: "p", authorId: "u-admin", status: "proposed", decidedAt: null })];
    const env = await agentCreationRequestsSource.fetchMine(admin);
    expect(decidableOwn(env.rows.find((r) => r.id === "p")!)).toBe(true);
    // allowSelfApproval short-circuits, so the admin-count is never consulted.
    expect(vi.mocked(countOtherPlatformAdmins)).not.toHaveBeenCalled();
  });

  it("another admin exists + no override: the pending own row is NOT decidable", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(1);
    h.store.rows = [mkRow({ id: "p", authorId: "u-admin", status: "proposed", decidedAt: null })];
    const env = await agentCreationRequestsSource.fetchMine(admin);
    expect(decidableOwn(env.rows.find((r) => r.id === "p")!)).toBe(false);
  });

  it("a non-admin author's pending own row is NOT decidable (other admins exist)", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(2);
    h.store.rows = [mkRow({ id: "p", authorId: "u-member", status: "proposed", decidedAt: null })];
    const env = await agentCreationRequestsSource.fetchMine(member);
    expect(decidableOwn(env.rows.find((r) => r.id === "p")!)).toBe(false);
  });

  it("a non-admin author is NEVER decidable even with allowSelfApproval (admin-first gate)", async () => {
    // allowSelfApproval short-circuits viewerMayApproveOwn to true regardless of
    // role, but the decide primitive rejects a non-admin actor first — so the
    // control must NOT render for a non-admin, and the eligibility helper (which
    // would say "true") is never even consulted.
    h.config = { allowSelfApproval: true };
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [mkRow({ id: "p", authorId: "u-member", status: "proposed", decidedAt: null })];
    const env = await agentCreationRequestsSource.fetchMine(member);
    expect(decidableOwn(env.rows.find((r) => r.id === "p")!)).toBe(false);
    expect(vi.mocked(countOtherPlatformAdmins)).not.toHaveBeenCalled();
  });

  it("no eligibility check runs when there is nothing pending to decide", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({
        id: "recent",
        authorId: "u-admin",
        status: "rejected",
        decidedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      }),
    ];
    const env = await agentCreationRequestsSource.fetchMine(admin);
    expect(decidableOwn(env.rows.find((r) => r.id === "recent")!)).toBe(false);
    expect(vi.mocked(countOtherPlatformAdmins)).not.toHaveBeenCalled();
  });
});

describe("agentCreationRequestsSource.rowRenderer — decide control vs Details", () => {
  function render(row: ApprovalRow, direction: Direction): string {
    return renderToStaticMarkup(
      agentCreationRequestsSource.rowRenderer(row, { direction }) as never,
    );
  }

  async function mineRow(
    id: string,
    over: Record<string, unknown>,
    viewer = admin,
  ): Promise<ApprovalRow> {
    h.store.rows = [mkRow({ id, authorId: viewer.userId, ...over })];
    const env = await agentCreationRequestsSource.fetchMine(viewer);
    return env.rows.find((r) => r.id === id)!;
  }

  it("an Inbox row ALWAYS renders the inline decide control (someone else's request)", async () => {
    h.store.rows = [mkRow({ id: "other", authorId: "u-other", status: "proposed" })];
    const env = await agentCreationRequestsSource.fetchInbox(admin);
    const html = render(env.rows[0], "inbox");
    expect(html).toContain('data-decide="other"');
    expect(html).toContain('data-expected-version="hash"'); // CAS token wired for decide
    expect(html).not.toContain("your own request");
  });

  it("a decidable Your-requests row renders the decide control wired with its CAS token", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    const row = await mineRow("p", { status: "proposed", snapshotHash: "cas-42" });
    const html = render(row, "mine");
    expect(html).toContain('data-decide="p"');
    expect(html).toContain('data-expected-version="cas-42"');
    expect(html).not.toContain("Details");
    expect(html).not.toContain("your own request");
  });

  it("a NON-decidable Your-requests pending row renders a Details link, no decide control", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(1); // another admin → not decidable
    const row = await mineRow("p", { status: "proposed" });
    const html = render(row, "mine");
    expect(html).not.toContain("data-decide=");
    expect(html).toContain("Details");
  });

  it("a decided Your-requests row renders a Details link even for the sole admin", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    const row = await mineRow("recent", {
      status: "rejected",
      decidedAt: new Date(Date.now() - 2 * DAY).toISOString(),
    });
    const html = render(row, "mine");
    expect(html).not.toContain("data-decide=");
    expect(html).toContain("Details");
  });
});

describe("agentCreationRequestsSource.counts", () => {
  it("admin inbox counts OTHERS' proposals only (own excluded); mine counts own pending", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ authorId: "u-admin", status: "proposed" }),
      mkRow({ authorId: "u-other", status: "proposed" }),
    ];
    await expect(agentCreationRequestsSource.counts(admin)).resolves.toEqual({
      inbox: 1,
      mine: 1,
    });

    h.store.rows = [mkRow({ authorId: "u-member", status: "proposed" })];
    const c = await agentCreationRequestsSource.counts(member);
    expect(c.inbox).toBe(0);
    expect(c.mine).toBe(1);
  });

  it("own proposals never inflate the Inbox count even for the sole approver", async () => {
    vi.mocked(countOtherPlatformAdmins).mockResolvedValue(0);
    h.store.rows = [
      mkRow({ authorId: "u-admin", status: "proposed" }),
      mkRow({ authorId: "u-admin", status: "proposed" }),
      mkRow({ authorId: "u-other", status: "proposed" }),
    ];
    await expect(agentCreationRequestsSource.counts(admin)).resolves.toEqual({
      inbox: 1,
      mine: 2,
    });
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
