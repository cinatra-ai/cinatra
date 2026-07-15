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
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: h.requireAuthSession,
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  betterAuthDb: { transaction: h.transaction },
  readTeamCreatableOrganizationsForUser: h.readTeamCreatableOrganizationsForUser,
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
  return { execute: vi.fn(async () => ({ rows })) };
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
