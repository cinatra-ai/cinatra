/**
 * author-decide-DENY (Part of #1549; #1552 AC5/AC7).
 *
 * #1552 loosens the DETAIL ROUTE to author-or-admin READ, but the DECIDE server
 * actions must keep rejecting a non-admin actor server-side even when invoked
 * directly — the UI gating is an affordance only. This already holds today via
 * the per-action `isPlatformAdmin(session)` check; this test PINS it so the
 * read-access change can never silently regress the decide guard.
 *
 * Behavioral: imports the real server actions with mocked auth/navigation and a
 * spy MCP-handler factory, and asserts a non-admin AUTHOR session is redirected
 * to ?error=unauthorized BEFORE any decide/retry primitive runs. A positive
 * admin control proves the denial is specific to the admin gate, not a broken
 * test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthSession = vi.fn();
const decideHandler = vi.fn(async (_req: unknown) => ({}) as { error?: string });
const retryHandler = vi.fn(async (_req: unknown) => ({}) as { error?: string });

const redirect = vi.fn((url: string) => {
  // next/navigation redirect throws a control-flow signal (NEXT_REDIRECT) in
  // real Next; mirror that so the action body halts at the redirect line.
  throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  // Faithful reproduction of the real comma-split predicate (not a hardcoded
  // false), so the test exercises the actual admin-gate logic.
  isPlatformAdmin: (s: { user?: { role?: string | null } | null } | null | undefined) =>
    String(s?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
}));

vi.mock("@cinatra-ai/agents/mcp-handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({
    agent_creation_request_decide: (req: unknown) => decideHandler(req as never),
    agent_creation_request_retry_publish: (req: unknown) => retryHandler(req as never),
  }),
}));

import {
  approveAgentCreationRequest,
  rejectAgentCreationRequest,
  retryPublishAgentCreationRequest,
} from "../actions";

const AUTHOR_SESSION = {
  user: { id: "author-1", role: "user" },
  session: { activeOrganizationId: "org-1" },
};
const ADMIN_SESSION = {
  user: { id: "admin-1", role: "user,admin" },
  session: { activeOrganizationId: "org-1" },
};

function decideForm(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "req-1");
  fd.set("snapshotHash", "hash-1");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("author-decide-DENY: a non-admin AUTHOR is rejected server-side (#1552 AC5)", () => {
  it("approveAgentCreationRequest redirects unauthorized and never runs the decide primitive", async () => {
    getAuthSession.mockResolvedValue(AUTHOR_SESSION);
    await expect(approveAgentCreationRequest(decideForm())).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=unauthorized",
    });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("rejectAgentCreationRequest (with a reason) redirects unauthorized and never runs the decide primitive", async () => {
    getAuthSession.mockResolvedValue(AUTHOR_SESSION);
    await expect(
      rejectAgentCreationRequest(decideForm({ reason: "not allowed" })),
    ).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=unauthorized",
    });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("retryPublishAgentCreationRequest redirects unauthorized and never runs the retry primitive", async () => {
    getAuthSession.mockResolvedValue(AUTHOR_SESSION);
    await expect(retryPublishAgentCreationRequest(decideForm())).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=unauthorized",
    });
    expect(retryHandler).not.toHaveBeenCalled();
  });
});

describe("admin control: the decide gate admits an admin (#1552 AC6)", () => {
  it("approveAgentCreationRequest runs the decide primitive as platform_admin and redirects approved", async () => {
    getAuthSession.mockResolvedValue(ADMIN_SESSION);
    await expect(approveAgentCreationRequest(decideForm())).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?status=approved",
    });
    expect(decideHandler).toHaveBeenCalledTimes(1);
    expect(decideHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        primitiveName: "agent_creation_request_decide",
        actor: expect.objectContaining({ platformRole: "platform_admin", userId: "admin-1" }),
      }),
    );
  });
});
