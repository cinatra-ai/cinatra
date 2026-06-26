// [Security][High] Non-admin users can create or overwrite global external MCP
// servers via createExternalMcpServerAction.
//
// Root cause: createExternalMcpServerAction mapped any non-"user" scope (incl.
// the default) to "global" and only required a session for the user path — no
// admin guard on the global write. Global external MCP rows are injected into
// every LLM call's MCP toolbox with requireApproval:"never", so a non-admin who
// invokes the server action directly could register or (via ON CONFLICT id
// overwrite) hijack an attacker-controlled global MCP endpoint. The delete path
// had no authz guard at all.
//
// Fix asserts:
//   - negative: non-admin crafted scope=global (and the missing-scope default)
//     is rejected before any registry write;
//   - negative: a user-scope upsert reusing an existing GLOBAL row id is
//     rejected (no ON CONFLICT overwrite of a global row);
//   - negative: a user-scope upsert reusing ANOTHER user's row id is rejected;
//   - negative: a non-admin / non-owner delete is rejected;
//   - positive: an admin can create a global row;
//   - positive: an authenticated user can create + manage their own user row.

import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuthSession = vi.fn();
const requireAdminSession = vi.fn();
const isPlatformAdmin = vi.fn();

const upsertExternalMcpServer = vi.fn();
const deleteExternalMcpServer = vi.fn();
const getExternalMcpServerById = vi.fn();

const redirect = vi.fn((url: string) => {
  // next/navigation redirect throws a control-flow signal (NEXT_REDIRECT) in
  // real Next; mirror that so the action body halts at the redirect line.
  throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
});

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  requireAdminSession: () => requireAdminSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
  getActorContext: vi.fn(),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  upsertExternalMcpServer: (...a: unknown[]) => upsertExternalMcpServer(...a),
  deleteExternalMcpServer: (...a: unknown[]) => deleteExternalMcpServer(...a),
  getExternalMcpServerById: (...a: unknown[]) => getExternalMcpServerById(...a),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

// Real predicate so the mocked session role string drives owner/admin checks
// the same way production code does.
function realIsPlatformAdmin(session: { user?: { role?: string | null } | null } | null) {
  return String(session?.user?.role ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .includes("admin");
}

function adminRedirect() {
  // requireAdminSession redirects non-admins to /not-authorized (throws).
  throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: "/not-authorized" });
}

beforeEach(() => {
  vi.clearAllMocks();
  redirect.mockImplementation((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
  });
  isPlatformAdmin.mockImplementation((s) => realIsPlatformAdmin(s as never));
  getExternalMcpServerById.mockReturnValue(null);
});

describe("external MCP server actions — authorization boundary", () => {
  // --- NEGATIVE: non-admin global create rejected ---------------------------

  it("rejects a non-admin crafted scope=global create (no global row written)", async () => {
    // A non-admin reaches the admin guard, which redirects to /not-authorized.
    requireAdminSession.mockImplementation(adminRedirect);

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("label", "evil");
    form.set("serverUrl", "https://attacker.example/mcp");
    form.set("scope", "global");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(requireAdminSession).toHaveBeenCalled();
    expect(upsertExternalMcpServer).not.toHaveBeenCalled();
  });

  it("rejects the missing-scope default (which maps to global) for a non-admin", async () => {
    requireAdminSession.mockImplementation(adminRedirect);

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("label", "evil-default");
    form.set("serverUrl", "https://attacker.example/mcp");
    // no scope field — defaults to "global"

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(requireAdminSession).toHaveBeenCalled();
    expect(upsertExternalMcpServer).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: id-overwrite guard ----------------------------------------

  it("rejects a user-scope upsert that reuses an existing GLOBAL row id (no ON CONFLICT global overwrite)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    // First requireAdminSession is the existing-global-id branch → reject.
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerById.mockReturnValue({
      id: "global-row-1",
      scope: "global",
      userId: null,
    });

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "global-row-1");
    form.set("label", "hijack");
    form.set("serverUrl", "https://attacker.example/mcp");
    form.set("scope", "user");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(upsertExternalMcpServer).not.toHaveBeenCalled();
  });

  it("rejects a user-scope upsert that reuses ANOTHER user's row id (cross-actor)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerById.mockReturnValue({
      id: "victim-row",
      scope: "user",
      userId: "u_victim",
    });

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "victim-row");
    form.set("label", "steal");
    form.set("serverUrl", "https://attacker.example/mcp");
    form.set("scope", "user");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/not-authorized");
    expect(upsertExternalMcpServer).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: delete guard ----------------------------------------------

  it("rejects a non-admin delete of a global row", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerById.mockReturnValue({
      id: "global-row-1",
      scope: "global",
      userId: null,
    });

    const { deleteExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "global-row-1");

    await expect(deleteExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteExternalMcpServer).not.toHaveBeenCalled();
  });

  it("rejects a non-owner non-admin delete of another user's row (cross-actor)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    getExternalMcpServerById.mockReturnValue({
      id: "victim-row",
      scope: "user",
      userId: "u_victim",
    });

    const { deleteExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "victim-row");

    await expect(deleteExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/not-authorized");
    expect(deleteExternalMcpServer).not.toHaveBeenCalled();
  });

  // --- POSITIVE: authorized paths still work --------------------------------

  it("allows an admin to create a global external MCP row", async () => {
    requireAdminSession.mockResolvedValue({ user: { id: "u_admin", role: "admin" } });

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("label", "ops-global");
    form.set("serverUrl", "https://ops.example/mcp");
    form.set("scope", "global");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/configuration/llm");
    expect(upsertExternalMcpServer).toHaveBeenCalledTimes(1);
    const arg = upsertExternalMcpServer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.scope).toBe("global");
    expect(arg.userId).toBeNull();
  });

  it("allows an authenticated user to create their own user-scoped row bound to their userId", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_self", role: "user" } });

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("label", "my-mcp");
    form.set("serverUrl", "https://self.example/mcp");
    form.set("scope", "user");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/configuration/llm");
    expect(requireAdminSession).not.toHaveBeenCalled();
    expect(upsertExternalMcpServer).toHaveBeenCalledTimes(1);
    const arg = upsertExternalMcpServer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.scope).toBe("user");
    expect(arg.userId).toBe("u_self");
  });

  it("allows a user to overwrite + delete their OWN user-scoped row", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_self", role: "user" } });
    getExternalMcpServerById.mockReturnValue({
      id: "self-row",
      scope: "user",
      userId: "u_self",
    });

    const actions = await import("@/app/campaigns/actions");

    const upForm = new FormData();
    upForm.set("id", "self-row");
    upForm.set("label", "renamed");
    upForm.set("serverUrl", "https://self.example/mcp2");
    upForm.set("scope", "user");
    await expect(actions.createExternalMcpServerAction(upForm)).rejects.toThrow("NEXT_REDIRECT");
    expect(upsertExternalMcpServer).toHaveBeenCalledTimes(1);

    const delForm = new FormData();
    delForm.set("id", "self-row");
    await expect(actions.deleteExternalMcpServerAction(delForm)).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteExternalMcpServer).toHaveBeenCalledTimes(1);
    expect(deleteExternalMcpServer).toHaveBeenCalledWith("self-row");
  });
});
