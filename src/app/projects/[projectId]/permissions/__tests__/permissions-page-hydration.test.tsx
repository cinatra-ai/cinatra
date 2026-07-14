/**
 * `/projects/[projectId]/permissions` selection hydration (cinatra#1508 /
 * #1509 §4.1, codex F5):
 *   - a team referenced by the project's stored access state that the VIEWER
 *     is not a member of is name-resolved server-side, bounded by the
 *     PROJECT's org (`readTeamsByIdsForOrg(ids, project.organizationId)`)
 *   - team ids come ONLY from the access expression + project_access rows
 *   - ids the org-bounded lookup does not return (other-org / deleted teams)
 *     keep the explicit "Unknown team" rendering
 *   - nothing is looked up when the access state references no unknown teams
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(),
  readProjectCoOwners: vi.fn().mockResolvedValue([]),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/projects/proj-1/permissions",
}));
// The `project.read` 404-hide gate is covered by permissions-page.test.tsx;
// these tests exercise the post-gate hydration path (e.g. a co-owner viewing
// a team-owned project whose team they are not in), so the gate passes here.
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/better-auth-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/better-auth-db")>()),
  readOrgsWithTeamsForUser: vi.fn(),
  readProjectsForUser: vi.fn().mockResolvedValue([]),
  readTeamsByIdsForOrg: vi.fn(),
}));
vi.mock("../actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../actions")>()),
  listProjectAccessAction: vi.fn(),
}));

const ORG_A = "org-A";
const VIEWER = "user-owner";
const TEAM_X = "team-x";

const teamOwnedProject = {
  id: "proj-1",
  name: "Demo project",
  ownerLevel: "team",
  ownerId: TEAM_X,
  organizationId: ORG_A,
};

async function arrange(opts: {
  project: Record<string, unknown>;
  viewerTeams?: Array<{ id: string; name: string }>;
  resolvedTeams?: Array<{ id: string; name: string }>;
  accessRows?: Array<Record<string, unknown>>;
  isAdmin?: boolean;
}) {
  const { requireAuthSession } = await import("@/lib/auth-session");
  (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: VIEWER },
    session: { activeOrganizationId: ORG_A },
  });

  const projectsStore = (await import("@/lib/projects-store")) as unknown as {
    readProjectById: ReturnType<typeof vi.fn>;
  };
  projectsStore.readProjectById.mockResolvedValue(opts.project);

  const db = (await import("@/lib/better-auth-db")) as unknown as {
    readOrgsWithTeamsForUser: ReturnType<typeof vi.fn>;
    readTeamsByIdsForOrg: ReturnType<typeof vi.fn>;
  };
  db.readOrgsWithTeamsForUser.mockResolvedValue([
    { id: ORG_A, name: "Acme", teams: opts.viewerTeams ?? [] },
  ]);
  db.readTeamsByIdsForOrg.mockResolvedValue(opts.resolvedTeams ?? []);

  const actions = (await import("../actions")) as unknown as {
    listProjectAccessAction: ReturnType<typeof vi.fn>;
  };
  actions.listProjectAccessAction.mockResolvedValue(
    opts.accessRows
      ? { ok: true, items: opts.accessRows }
      : { ok: false, error: "unavailable" },
  );

  const { default: PermissionsPage } = await import("../page");
  const ui = (await PermissionsPage({
    params: Promise.resolve({ projectId: opts.project.id }),
  } as never)) as ReactElement;
  return { html: renderToStaticMarkup(ui), db };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("permissions page — access-team selection hydration (#1508)", () => {
  it("resolves a non-member owning team via the PROJECT-org-bounded lookup and renders its name", async () => {
    const { html, db } = await arrange({
      project: teamOwnedProject,
      viewerTeams: [],
      resolvedTeams: [{ id: TEAM_X, name: "Growth Guild" }],
    });

    // Permission-bound contract: the CLOSED server-derived id set, bounded by
    // the project's own org — never the viewer's org, never a client id.
    expect(db.readTeamsByIdsForOrg).toHaveBeenCalledTimes(1);
    expect(db.readTeamsByIdsForOrg).toHaveBeenCalledWith([TEAM_X], ORG_A);
    // The selection now hydrates: the trigger shows the team name.
    expect(html).toContain("Growth Guild");
    expect(html).not.toContain("Unknown team");
  });

  it("keeps 'Unknown team' when the org-bounded lookup does not return the id (other org / deleted)", async () => {
    const { html, db } = await arrange({
      project: teamOwnedProject,
      viewerTeams: [],
      resolvedTeams: [],
    });

    expect(db.readTeamsByIdsForOrg).toHaveBeenCalledWith([TEAM_X], ORG_A);
    expect(html).toContain("Unknown team");
  });

  it("feeds team-level project_access rows into the hydration set (user/org/workspace rows excluded)", async () => {
    const { db } = await arrange({
      project: { ...teamOwnedProject, ownerLevel: "user", ownerId: VIEWER },
      viewerTeams: [],
      accessRows: [
        { principalLevel: "user", principalId: VIEWER, role: "owner" },
        { principalLevel: "team", principalId: "team-y", role: "read" },
        { principalLevel: "workspace", principalId: "__workspace__", role: "read" },
      ],
      resolvedTeams: [{ id: "team-y", name: "Ops" }],
    });

    expect(db.readTeamsByIdsForOrg).toHaveBeenCalledTimes(1);
    expect(db.readTeamsByIdsForOrg).toHaveBeenCalledWith(["team-y"], ORG_A);
  });

  it("skips the lookup entirely when every referenced team is already in the viewer's scopes", async () => {
    const { html, db } = await arrange({
      project: teamOwnedProject,
      viewerTeams: [{ id: TEAM_X, name: "Revenue" }],
    });

    expect(db.readTeamsByIdsForOrg).not.toHaveBeenCalled();
    expect(html).toContain("Revenue");
  });
});
