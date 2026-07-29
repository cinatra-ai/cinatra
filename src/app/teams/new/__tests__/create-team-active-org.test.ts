/**
 * createTeamAction — active-organization destination guard (#1495).
 *
 * /teams is ACTIVE-org scoped, but a team can be created in ANY org the caller
 * owns/administers. After a successful create the action must switch the
 * session's active organization to the new team's org (via Better Auth's
 * server-side set-active endpoint) so the freshly-created team is visible on
 * /teams. The switch must be:
 *   (a) performed when the chosen org is NOT the active org,
 *   (b) skipped when the chosen org IS already the active org (no-op), and
 *   (c) never reached when team creation fails.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  readTeamCreatableOrganizationsForUser: vi.fn(),
  transaction: vi.fn(),
  setActiveOrganization: vi.fn(async () => ({})),
  headers: vi.fn(async () => new Headers()),
  // Default TRUE: the provisioned world (cinatra#1566) — the creator's
  // membership insert carries role='admin'. The degrade case flips it.
  teamMemberRoleColumnExists: vi.fn(async () => true),
  // cinatra#1939 wave 3 Stage D seam spies: the action now mints a session
  // authority and runs its transaction through guardOrgMutation. This suite's
  // concern is the ACTIVE-ORG DESTINATION flow, so the kernel guard is a
  // pass-through here (its refusal semantics are the kernel's own test
  // suite's concern); the spies still let us assert the wiring.
  verifySessionAuthority: vi.fn(async (userId: string, orgId: string) => ({
    orgId,
    can: () => true,
  })),
  guardOrgMutation: vi.fn(
    async (
      db: { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _req: unknown,
      fn: (tx: unknown, permit: unknown) => Promise<unknown>,
    ) => db.transaction(async (tx) => fn(tx, {})),
  ),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: h.requireAuthSession,
}));

vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: h.verifySessionAuthority,
}));

vi.mock("@cinatra-ai/org-write-kernel", () => ({
  guardOrgMutation: h.guardOrgMutation,
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { transaction: h.transaction },
  readTeamCreatableOrganizationsForUser: h.readTeamCreatableOrganizationsForUser,
  teamMemberRoleColumnExists: h.teamMemberRoleColumnExists,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { setActiveOrganization: h.setActiveOrganization } },
}));

vi.mock("next/headers", () => ({ headers: h.headers }));

vi.mock("next/navigation", () => ({
  // Next's redirect() throws to unwind; mirror that so we can assert the
  // destination and prove control flow stopped at the redirect.
  redirect: vi.fn((url: string) => {
    throw new Error("REDIRECT:" + url);
  }),
}));

import { createTeamAction } from "../actions";

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const OTHER_ORG = "org-other";

/** A tx.execute() stub whose INSERT ... RETURNING returns `rows`. */
function txWithRows(rows: Array<{ id: string }>) {
  return { execute: vi.fn(async (_sql: unknown) => ({ rows })) };
}

/** Concatenated static text of a recorded drizzle `sql` tree (best-effort —
 *  the team-member-actions walker; drizzle SQL objects are cyclic and
 *  symbol-keyed, so JSON.stringify would throw). */
function sqlText(root: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    for (const key of Reflect.ownKeys(node as object)) {
      let value: unknown;
      try {
        value = (node as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      walk(value);
    }
  };
  walk(root);
  return parts.join(" ");
}

/** Run the action and return the redirect destination it unwound to. */
async function runAndCaptureRedirect(formData: FormData): Promise<string> {
  try {
    await createTeamAction(formData);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.startsWith("REDIRECT:")) {
      return message.slice("REDIRECT:".length);
    }
    throw err;
  }
  throw new Error("createTeamAction did not redirect");
}

function formFor(organizationId: string): FormData {
  const fd = new FormData();
  fd.set("name", "UAT Detail Team");
  fd.set("organizationId", organizationId);
  return fd;
}

function mockSession(activeOrganizationId: string | null) {
  h.requireAuthSession.mockResolvedValue({
    user: { id: USER_ID, role: "user" },
    session: { activeOrganizationId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.setActiveOrganization.mockResolvedValue({});
  h.headers.mockResolvedValue(new Headers());
  h.teamMemberRoleColumnExists.mockImplementation(async () => true);
  // Both orgs are in the caller's creatable (owner/admin) set.
  h.readTeamCreatableOrganizationsForUser.mockResolvedValue([
    { id: ACTIVE_ORG, name: "Active", slug: "active" },
    { id: OTHER_ORG, name: "Other", slug: "other" },
  ]);
  // Happy path: the first slug candidate inserts cleanly.
  h.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txWithRows([{ id: "team-1" }])),
  );
});

describe("createTeamAction active-org destination guard", () => {
  it("switches the active org to the created team's org when it is NOT active, then redirects to /teams", async () => {
    mockSession(ACTIVE_ORG);

    const dest = await runAndCaptureRedirect(formFor(OTHER_ORG));

    expect(dest).toBe("/teams");
    expect(h.setActiveOrganization).toHaveBeenCalledTimes(1);
    expect(h.setActiveOrganization).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { organizationId: OTHER_ORG },
    });
  });

  it("switches when the session has no active org yet", async () => {
    mockSession(null);

    const dest = await runAndCaptureRedirect(formFor(OTHER_ORG));

    expect(dest).toBe("/teams");
    expect(h.setActiveOrganization).toHaveBeenCalledTimes(1);
    expect(h.setActiveOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ body: { organizationId: OTHER_ORG } }),
    );
  });

  it("does NOT switch when the created team's org is already active (no-op), still redirects to /teams", async () => {
    mockSession(ACTIVE_ORG);

    const dest = await runAndCaptureRedirect(formFor(ACTIVE_ORG));

    expect(dest).toBe("/teams");
    expect(h.setActiveOrganization).not.toHaveBeenCalled();
  });

  it("does NOT switch when team creation fails (slug exhausted): redirects to the error page", async () => {
    mockSession(ACTIVE_ORG);
    // Every insert conflicts → allocatedSlug stays null → result.ok === false.
    h.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(txWithRows([])),
    );

    const dest = await runAndCaptureRedirect(formFor(OTHER_ORG));

    expect(dest).toBe("/teams/new?error=slug-conflict");
    expect(h.setActiveOrganization).not.toHaveBeenCalled();
  });

  it("does NOT switch when the chosen org is not in the caller's creatable set (authz redirect)", async () => {
    mockSession(ACTIVE_ORG);
    h.readTeamCreatableOrganizationsForUser.mockResolvedValue([
      { id: ACTIVE_ORG, name: "Active", slug: "active" },
    ]);

    const dest = await runAndCaptureRedirect(formFor(OTHER_ORG));

    expect(dest).toBe("/not-authorized");
    expect(h.setActiveOrganization).not.toHaveBeenCalled();
  });

  it("inserts the creator's membership with role='admin' when the role column is provisioned (#1566)", async () => {
    mockSession(ACTIVE_ORG);
    const tx = txWithRows([{ id: "team-1" }]);
    h.transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));

    await runAndCaptureRedirect(formFor(ACTIVE_ORG));

    // 2 statements: the team insert, then the creator membership insert.
    expect(tx.execute).toHaveBeenCalledTimes(2);
    const memberInsert = sqlText(tx.execute.mock.calls[1]?.[0]);
    expect(memberInsert).toContain('"role"');
    expect(memberInsert).toContain("'admin'");
  });

  it("falls back to the roleless membership insert when the role column is absent (degrade; the migration backfill promotes the creator later)", async () => {
    mockSession(ACTIVE_ORG);
    h.teamMemberRoleColumnExists.mockImplementation(async () => false);
    const tx = txWithRows([{ id: "team-1" }]);
    h.transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));

    await runAndCaptureRedirect(formFor(ACTIVE_ORG));

    expect(tx.execute).toHaveBeenCalledTimes(2);
    const memberInsert = sqlText(tx.execute.mock.calls[1]?.[0]);
    expect(memberInsert).not.toContain('"role"');
    expect(memberInsert).not.toContain("'admin'");
  });

  it("runs the create through guardOrgMutation with membership.write + a session authority minted for the CHOSEN org (#1939 Stage D)", async () => {
    mockSession(ACTIVE_ORG);

    await runAndCaptureRedirect(formFor(OTHER_ORG));

    expect(h.verifySessionAuthority).toHaveBeenCalledWith(USER_ID, OTHER_ORG);
    expect(h.guardOrgMutation).toHaveBeenCalledTimes(1);
    const [, req] = h.guardOrgMutation.mock.calls[0]!;
    expect(req).toMatchObject({ orgId: OTHER_ORG, capability: "membership.write" });
  });

  it("fails visibly when the switch rejects post-create (no silent /teams redirect)", async () => {
    // Deliberate policy: if set-active fails (e.g. membership revoked between
    // create and switch), surface the error rather than landing on a /teams
    // page that would not show the just-created team.
    mockSession(ACTIVE_ORG);
    h.setActiveOrganization.mockRejectedValue(new Error("FORBIDDEN"));

    await expect(createTeamAction(formFor(OTHER_ORG))).rejects.toThrow("FORBIDDEN");
    expect(h.setActiveOrganization).toHaveBeenCalledTimes(1);
  });
});
