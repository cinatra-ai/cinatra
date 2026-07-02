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

// TOCTOU hardening (Refs cinatra#658): the action now authorizes against a FRESH
// read (`getExternalMcpServerByIdFresh`, bypassing the registry's 30s TTL cache)
// and writes CONDITIONALLY — a brand-new id via `insertExternalMcpServerStrict`,
// an existing id via `updateExternalMcpServerGuarded`, delete via
// `deleteExternalMcpServerGuarded` — each of which throws
// `ExternalMcpServerWriteConflictError` when the row no longer matches the
// witnessed scope+owner. A conflict maps to a fail-closed /not-authorized redirect.
const insertExternalMcpServerStrict = vi.fn();
const updateExternalMcpServerGuarded = vi.fn();
const deleteExternalMcpServerGuarded = vi.fn();
const getExternalMcpServerByIdFresh = vi.fn();

class ExternalMcpServerWriteConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ExternalMcpServerWriteConflictError";
  }
}

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
  ExternalMcpServerWriteConflictError,
  insertExternalMcpServerStrict: (...a: unknown[]) => insertExternalMcpServerStrict(...a),
  updateExternalMcpServerGuarded: (...a: unknown[]) => updateExternalMcpServerGuarded(...a),
  deleteExternalMcpServerGuarded: (...a: unknown[]) => deleteExternalMcpServerGuarded(...a),
  getExternalMcpServerByIdFresh: (...a: unknown[]) => getExternalMcpServerByIdFresh(...a),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

// External-MCP UI moved to the "MCP Servers" connector setup page (cinatra#612);
// the host actions redirect back there after a successful write. Stub the
// catalog href resolver so the unit asserts a stable target.
const MCP_SERVER_SETUP_HREF = "/connectors/cinatra-ai/mcp-server-connector/setup";
vi.mock("@/lib/connectors-registry.server", () => ({
  getConnectorSetupHref: (slug: string) =>
    slug === "mcp-server-connector" ? MCP_SERVER_SETUP_HREF : null,
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
  getExternalMcpServerByIdFresh.mockReturnValue(null);
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
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
    expect(updateExternalMcpServerGuarded).not.toHaveBeenCalled();
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
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
    expect(updateExternalMcpServerGuarded).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: id-overwrite guard ----------------------------------------

  it("rejects a user-scope upsert that reuses an existing GLOBAL row id (no guarded global overwrite)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    // First requireAdminSession is the existing-global-id branch → reject.
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerByIdFresh.mockReturnValue({
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
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
    expect(updateExternalMcpServerGuarded).not.toHaveBeenCalled();
  });

  it("rejects a user-scope upsert that reuses ANOTHER user's row id (cross-actor)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerByIdFresh.mockReturnValue({
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
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
    expect(updateExternalMcpServerGuarded).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: delete guard ----------------------------------------------

  it("rejects a non-admin delete of a global row", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    requireAdminSession.mockImplementation(adminRedirect);
    getExternalMcpServerByIdFresh.mockReturnValue({
      id: "global-row-1",
      scope: "global",
      userId: null,
    });

    const { deleteExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "global-row-1");

    await expect(deleteExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteExternalMcpServerGuarded).not.toHaveBeenCalled();
  });

  it("rejects a non-owner non-admin delete of another user's row (cross-actor)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_attacker", role: "user" } });
    getExternalMcpServerByIdFresh.mockReturnValue({
      id: "victim-row",
      scope: "user",
      userId: "u_victim",
    });

    const { deleteExternalMcpServerAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("id", "victim-row");

    await expect(deleteExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/not-authorized");
    expect(deleteExternalMcpServerGuarded).not.toHaveBeenCalled();
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
    expect(redirect).toHaveBeenCalledWith(`${MCP_SERVER_SETUP_HREF}?saved=1`);
    // A brand-new row (no id supplied) goes through the strict INSERT, never the
    // ON-CONFLICT-clobbering path.
    expect(insertExternalMcpServerStrict).toHaveBeenCalledTimes(1);
    expect(updateExternalMcpServerGuarded).not.toHaveBeenCalled();
    const arg = insertExternalMcpServerStrict.mock.calls[0][0] as Record<string, unknown>;
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
    expect(redirect).toHaveBeenCalledWith(`${MCP_SERVER_SETUP_HREF}?saved=1`);
    expect(requireAdminSession).not.toHaveBeenCalled();
    expect(insertExternalMcpServerStrict).toHaveBeenCalledTimes(1);
    const arg = insertExternalMcpServerStrict.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.scope).toBe("user");
    expect(arg.userId).toBe("u_self");
  });

  it("allows a user to overwrite + delete their OWN user-scoped row (guarded compare-and-write)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_self", role: "user" } });
    getExternalMcpServerByIdFresh.mockReturnValue({
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
    // An EXISTING id overwrites via the guarded UPDATE, never the strict INSERT.
    expect(updateExternalMcpServerGuarded).toHaveBeenCalledTimes(1);
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
    const upArg = updateExternalMcpServerGuarded.mock.calls[0];
    // The write row preserves the owner, and the guard is the witnessed scope+owner.
    expect((upArg[0] as Record<string, unknown>).userId).toBe("u_self");
    expect(upArg[1]).toEqual({ scope: "user", userId: "u_self" });

    const delForm = new FormData();
    delForm.set("id", "self-row");
    await expect(actions.deleteExternalMcpServerAction(delForm)).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteExternalMcpServerGuarded).toHaveBeenCalledTimes(1);
    expect(deleteExternalMcpServerGuarded).toHaveBeenCalledWith("self-row", {
      scope: "user",
      userId: "u_self",
    });
  });

  // --- TOCTOU race (Refs cinatra#658) --------------------------------------
  // The authz read sees the actor's OWN user row (passes owner checks), but the
  // guarded write throws a conflict because the underlying row was promoted to
  // global under the actor (cross-worker cache staleness). The action must
  // fail-closed to /not-authorized — never best-effort apply the write.

  it("REFUSES an overwrite when the guarded write reports a scope/owner conflict (stale-cache race)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_self", role: "user" } });
    // Stale authz view: the actor owns a user row → owner checks pass.
    getExternalMcpServerByIdFresh.mockReturnValue({
      id: "raced-row",
      scope: "user",
      userId: "u_self",
    });
    // Underlying row flipped to global → the guarded UPDATE refuses.
    updateExternalMcpServerGuarded.mockImplementation(() => {
      throw new ExternalMcpServerWriteConflictError();
    });

    const { createExternalMcpServerAction } = await import("@/app/campaigns/actions");
    const form = new FormData();
    form.set("id", "raced-row");
    form.set("label", "hijack");
    form.set("serverUrl", "https://attacker.example/mcp");
    form.set("scope", "user");

    await expect(createExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/not-authorized");
    expect(insertExternalMcpServerStrict).not.toHaveBeenCalled();
  });

  it("REFUSES a delete when the guarded delete reports a scope/owner conflict (stale-cache race)", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u_self", role: "user" } });
    getExternalMcpServerByIdFresh.mockReturnValue({
      id: "raced-row",
      scope: "user",
      userId: "u_self",
    });
    deleteExternalMcpServerGuarded.mockImplementation(() => {
      throw new ExternalMcpServerWriteConflictError();
    });

    const { deleteExternalMcpServerAction } = await import("@/app/campaigns/actions");
    const form = new FormData();
    form.set("id", "raced-row");

    await expect(deleteExternalMcpServerAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/not-authorized");
  });
});
