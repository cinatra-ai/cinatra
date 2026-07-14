/**
 * Grant-candidate server-action tests (cinatra#1505 / #1509 §4.2).
 *
 * Truths locked here:
 *  - all three candidate actions are gated on the grantProjectAccessAction
 *    authority (project admin/owner via projectGrants, or platform admin —
 *    the customers/actions.ts assertProjectAdmin precedent); a non-admin gets
 *    `forbidden` and NO candidate data,
 *  - a missing project raises the IDENTICAL `forbidden` (no existence oracle),
 *  - the boundary is the PROJECT's organizationId, never the viewer's active
 *    org (codex F6 — candidates must not depend on viewer memberships),
 *  - the user search has NO owner/co-owner exclusion (they are legitimate
 *    grant principals; already-granted rows are excluded client-side),
 *  - ILIKE patterns reach the query escaped, and the limit stays 20,
 *  - an org-less project fails closed to empty candidates without querying.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (module factories — the connection-grant-write-gate pattern)
// ---------------------------------------------------------------------------

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const resolveOrgRoleForSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
  resolveOrgRoleForSession: (...a: unknown[]) => resolveOrgRoleForSession(...a),
}));

const readProjectById = vi.fn();
vi.mock("@/lib/projects-store-dao", () => ({
  readProjectById: (...a: unknown[]) => readProjectById(...a),
}));

const readProjectCoOwners = vi.fn(async (..._a: unknown[]) => []);
vi.mock("@/lib/project-co-owners-store", () => ({
  addProjectCoOwner: vi.fn(),
  readProjectCoOwners: (...a: unknown[]) => readProjectCoOwners(...a),
  removeProjectCoOwner: vi.fn(),
}));

vi.mock("@/lib/authz/build-actor-context", () => ({ actorFromSession: vi.fn() }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn(),
}));
vi.mock("@cinatra-ai/projects", () => ({ handlers: {} }));

// Chainable drizzle recorder: every `.select()` starts a recorded query; the
// terminal `.limit()` resolves `nextRows`. Real drizzle TABLE objects come
// from the actual module (lazy proxies — no connection at import) so the
// recorded `eq`/`ilike` expressions are real SQL trees we can walk for params.
type RecordedQuery = {
  innerJoin?: unknown[];
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
};
const recordedQueries: RecordedQuery[] = [];
let nextRows: unknown[] = [];
function startChain() {
  const rec: RecordedQuery = {};
  recordedQueries.push(rec);
  const chain = {
    from: () => chain,
    innerJoin: (...a: unknown[]) => {
      rec.innerJoin = a;
      return chain;
    },
    where: (w: unknown) => {
      rec.where = w;
      return chain;
    },
    orderBy: (...a: unknown[]) => {
      rec.orderBy = a;
      return chain;
    },
    limit: (n: number) => {
      rec.limit = n;
      return Promise.resolve(nextRows);
    },
  };
  return chain;
}

const readProjectGrantsForUser = vi.fn();
const readTeamsForUser = vi.fn(async (..._a: unknown[]) => []);
const listTeamsForOrg = vi.fn();
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/better-auth-db")>();
  return {
    ...actual,
    betterAuthDb: { select: () => startChain() },
    readProjectGrantsForUser: (...a: unknown[]) => readProjectGrantsForUser(...a),
    readTeamsForUser: (...a: unknown[]) => readTeamsForUser(...a),
    listTeamsForOrg: (...a: unknown[]) => listTeamsForOrg(...a),
  };
});

import {
  listProjectGrantTeamCandidates,
  readProjectGrantOrgCandidate,
  searchProjectGrantUserCandidates,
} from "../actions";

// Deep-walk an expression tree (drizzle SQL objects: cyclic, symbol-keyed) for
// an exact string value — how we assert which org id bound the query.
function containsValue(root: unknown, target: string): boolean {
  const seen = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (node === target) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    for (const key of Reflect.ownKeys(node)) {
      let value: unknown;
      try {
        value = (node as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(root);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-1";
const PROJECT_ORG = "org-project";
const VIEWER_ORG = "org-viewer"; // ≠ PROJECT_ORG — proves the boundary choice
const ADMIN = "user-admin";
const OWNER = "user-owner";

const project = {
  id: PROJECT_ID,
  name: "Demo project",
  ownerLevel: "user",
  ownerId: OWNER,
  organizationId: PROJECT_ORG,
};

function primeSession() {
  requireAuthSession.mockResolvedValue({
    user: { id: ADMIN },
    session: { activeOrganizationId: VIEWER_ORG },
  });
}
function primeProjectAdmin() {
  readProjectGrantsForUser.mockResolvedValue([
    { projectId: PROJECT_ID, effectiveRole: "admin" },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedQueries.length = 0;
  nextRows = [];
  isPlatformAdmin.mockReturnValue(false);
  resolveOrgRoleForSession.mockResolvedValue(null);
  readTeamsForUser.mockResolvedValue([]);
  readProjectGrantsForUser.mockResolvedValue([]);
  readProjectById.mockResolvedValue(project);
  primeSession();
});

// ---------------------------------------------------------------------------
// Authority gate
// ---------------------------------------------------------------------------

describe("authority gate (assertProjectGrantAuthority)", () => {
  it("non-admin viewers get forbidden from all three actions — no data", async () => {
    readProjectGrantsForUser.mockResolvedValue([
      { projectId: PROJECT_ID, effectiveRole: "write" }, // write < admin
    ]);
    expect(await searchProjectGrantUserCandidates(PROJECT_ID, "a")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await readProjectGrantOrgCandidate(PROJECT_ID)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(recordedQueries).toHaveLength(0);
    expect(listTeamsForOrg).not.toHaveBeenCalled();
  });

  it("a missing session fails closed as forbidden — the redirect sentinel is never swallowed into the payload", async () => {
    // `requireAuthSession` throws Next's redirect sentinel when unauthenticated;
    // the searchWorkspaceUsersForProject precedent coerces it to a typed
    // failure instead of leaking `err.message` through the generic catch.
    requireAuthSession.mockRejectedValue(new Error("NEXT_REDIRECT"));
    expect(await searchProjectGrantUserCandidates(PROJECT_ID, "a")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await readProjectGrantOrgCandidate(PROJECT_ID)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(recordedQueries).toHaveLength(0);
  });

  it("a missing project raises the IDENTICAL forbidden — no existence oracle", async () => {
    readProjectById.mockResolvedValue(null);
    primeProjectAdmin();
    expect(await searchProjectGrantUserCandidates("proj-missing", "a")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(recordedQueries).toHaveLength(0);
  });

  it("a non-platform-admin viewer without an active org is forbidden", async () => {
    requireAuthSession.mockResolvedValue({
      user: { id: ADMIN },
      session: { activeOrganizationId: null },
    });
    primeProjectAdmin();
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("a platform admin passes WITHOUT an active org (independent authority)", async () => {
    requireAuthSession.mockResolvedValue({
      user: { id: ADMIN },
      session: { activeOrganizationId: null },
    });
    isPlatformAdmin.mockReturnValue(true);
    listTeamsForOrg.mockResolvedValue([{ id: "team-1", name: "Platform" }]);
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: true,
      teams: [{ id: "team-1", name: "Platform" }],
    });
    // The boundary stays the PROJECT's org even with no viewer org at all.
    expect(listTeamsForOrg).toHaveBeenCalledWith(PROJECT_ORG);
  });

  it("a project admin (effectiveRole via projectGrants) passes", async () => {
    primeProjectAdmin();
    listTeamsForOrg.mockResolvedValue([{ id: "team-1", name: "Platform" }]);
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: true,
      teams: [{ id: "team-1", name: "Platform" }],
    });
  });

  it("a project owner passes; a platform admin passes without any grant", async () => {
    readProjectGrantsForUser.mockResolvedValue([
      { projectId: PROJECT_ID, effectiveRole: "owner" },
    ]);
    listTeamsForOrg.mockResolvedValue([]);
    expect((await listProjectGrantTeamCandidates(PROJECT_ID)).ok).toBe(true);

    readProjectGrantsForUser.mockResolvedValue([]);
    isPlatformAdmin.mockReturnValue(true);
    expect((await listProjectGrantTeamCandidates(PROJECT_ID)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchProjectGrantUserCandidates
// ---------------------------------------------------------------------------

describe("searchProjectGrantUserCandidates", () => {
  beforeEach(primeProjectAdmin);

  it("binds the member join to the PROJECT's org, not the viewer's active org", async () => {
    nextRows = [{ id: "u-2", name: "Bea", email: "bea@example.com", image: null }];
    const r = await searchProjectGrantUserCandidates(PROJECT_ID, "bea");
    expect(r).toEqual({
      ok: true,
      results: [{ id: "u-2", name: "Bea", email: "bea@example.com", image: null }],
    });
    expect(recordedQueries).toHaveLength(1);
    const rec = recordedQueries[0]!;
    expect(rec.innerJoin).toBeDefined();
    expect(containsValue(rec.innerJoin, PROJECT_ORG)).toBe(true);
    expect(containsValue(rec.innerJoin, VIEWER_ORG)).toBe(false);
    expect(containsValue(rec.where, VIEWER_ORG)).toBe(false);
    expect(rec.limit).toBe(20);
  });

  it("has NO owner/co-owner exclusion — they are legitimate grant principals", async () => {
    nextRows = [{ id: OWNER, name: "Owner", email: "owner@example.com", image: null }];
    const r = await searchProjectGrantUserCandidates(PROJECT_ID, "owner");
    expect(r.ok).toBe(true);
    // The owner id never appears in the query (no notInArray exclusion) and
    // the co-owner store is never consulted by the candidate search.
    expect(containsValue(recordedQueries[0]!.where, OWNER)).toBe(false);
    expect(readProjectCoOwners).not.toHaveBeenCalled();
  });

  it("escapes ILIKE wildcards + the escape char in the pattern", async () => {
    await searchProjectGrantUserCandidates(PROJECT_ID, "50%_\\");
    expect(containsValue(recordedQueries[0]!.where, "%50\\%\\_\\\\%")).toBe(true);
  });

  it("a blank query searches without a name/email predicate", async () => {
    nextRows = [{ id: "u-3", name: null, email: "c@example.com", image: null }];
    const r = await searchProjectGrantUserCandidates(PROJECT_ID, "   ");
    expect(r).toEqual({
      ok: true,
      // name falls back email-first, mirroring the co-owner search shape
      results: [{ id: "u-3", name: "c@example.com", email: "c@example.com", image: null }],
    });
    expect(recordedQueries[0]!.where).toBeUndefined();
  });

  it("an org-less project fails closed to empty results without querying", async () => {
    readProjectById.mockResolvedValue({ ...project, organizationId: null });
    expect(await searchProjectGrantUserCandidates(PROJECT_ID, "a")).toEqual({
      ok: true,
      results: [],
    });
    expect(recordedQueries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listProjectGrantTeamCandidates / readProjectGrantOrgCandidate
// ---------------------------------------------------------------------------

describe("listProjectGrantTeamCandidates", () => {
  beforeEach(primeProjectAdmin);

  it("lists the PROJECT org's teams (not viewer memberships)", async () => {
    listTeamsForOrg.mockResolvedValue([
      { id: "team-1", name: "Platform" },
      { id: "team-2", name: "Research" },
    ]);
    const r = await listProjectGrantTeamCandidates(PROJECT_ID);
    expect(r).toEqual({
      ok: true,
      teams: [
        { id: "team-1", name: "Platform" },
        { id: "team-2", name: "Research" },
      ],
    });
    expect(listTeamsForOrg).toHaveBeenCalledWith(PROJECT_ORG);
  });

  it("an org-less project yields no team candidates (fail closed)", async () => {
    readProjectById.mockResolvedValue({ ...project, organizationId: null });
    expect(await listProjectGrantTeamCandidates(PROJECT_ID)).toEqual({
      ok: true,
      teams: [],
    });
    expect(listTeamsForOrg).not.toHaveBeenCalled();
  });
});

describe("readProjectGrantOrgCandidate", () => {
  beforeEach(primeProjectAdmin);

  it("returns the project's own org by name (the fixed row)", async () => {
    nextRows = [{ id: PROJECT_ORG, name: "Acme Corp" }];
    const r = await readProjectGrantOrgCandidate(PROJECT_ID);
    expect(r).toEqual({
      ok: true,
      organization: { id: PROJECT_ORG, name: "Acme Corp" },
    });
    expect(containsValue(recordedQueries[0]!.where, PROJECT_ORG)).toBe(true);
    expect(containsValue(recordedQueries[0]!.where, VIEWER_ORG)).toBe(false);
  });

  it("org-less project / deleted org resolve to organization: null", async () => {
    readProjectById.mockResolvedValue({ ...project, organizationId: null });
    expect(await readProjectGrantOrgCandidate(PROJECT_ID)).toEqual({
      ok: true,
      organization: null,
    });

    readProjectById.mockResolvedValue(project);
    nextRows = [];
    expect(await readProjectGrantOrgCandidate(PROJECT_ID)).toEqual({
      ok: true,
      organization: null,
    });
  });
});
