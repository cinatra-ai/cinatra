/**
 * TDD for the project access MCP surface:
 *   - project_access_* (grant / revoke / list / check)
 *   - project_agent_template_bindings_* (CRUD)
 *   - projects_list union (owned ∪ accessed) + archived filter
 *   - removed primitives stay absent (assertScopeRatchet / projects_delete)
 *
 * Mirrors packages/agents/src/__tests__/auth-policy.test.ts and
 * packages/objects/src/mcp/__tests__/handlers-authz.test.ts mocking
 * patterns: vi.mock the host-app modules (`@/lib/projects-store`,
 * `@/lib/projects-store-dao`, `@/lib/project-co-owners-store`,
 * `@/lib/authz`) and the mcp-server context storage, then drive each
 * primitive through `createProjectsPrimitiveHandlers()`.
 *
 * The absence checks (assertScopeRatchet + projects_delete) live
 * as PURE TEXT GREPS at the bottom so the source files keep matching
 * the expected project-access MCP contract.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type {
  ProjectGrant,
  ProjectRole,
  ProjectAccessSource,
} from "@/lib/authz/actor-context";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

// Tracked SQL invocations on projectsDb.execute — tests inspect the
// stringified SQL to confirm the right write/read happened. The Drizzle
// `sql` tagged template tag produces an object with a `getSQL()` method
// that returns the assembled SQL string + params.
type ExecCall = { sql: string; raw: unknown };
const execCalls: ExecCall[] = [];

vi.mock("@/lib/projects-store", () => ({
  // The handlers only use `projectsDb.execute(sql\`...\`)`.
  projectsDb: {
    execute: vi.fn(async (q: unknown) => {
      // Drizzle sql tag exposes the assembled SQL via the inspection
      // helper. We coerce to a string for substring matching.
      let assembled = "";
      try {
        // Drizzle's sql template returns an instance with a `.queryChunks`
        // array; calling `.toString()` is unreliable. Use the structural
        // hint string from the test if present, otherwise stringify.
        assembled =
          typeof (q as { toQuery?: () => unknown }).toQuery === "function"
            ? JSON.stringify((q as { toQuery: () => unknown }).toQuery())
            : JSON.stringify(q);
      } catch {
        assembled = String(q);
      }
      execCalls.push({ sql: assembled, raw: q });
      // Default: empty rows. Individual tests override via
      // `(projectsDb.execute as Mock).mockResolvedValueOnce({ rows: ... })`.
      return { rows: [] };
    }),
  },
  projects: {},
  projectCoOwners: {},
}));

vi.mock("@/lib/projects-store-dao", () => ({
  readProjectById: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("@/lib/project-co-owners-store", () => ({
  readProjectCoOwners: vi.fn().mockResolvedValue([]),
}));

// Pin the authz kernel decision surface — allow-by-default so the
// project.read/update/manageMembers gates pass uniformly. The owner
// short-circuit inside the project_access_grant role-escalation gate
// runs in handler code (against `actor.projectGrants`), not in the
// kernel, so we don't need to mock per-permission decisions.
vi.mock("@/lib/authz", async () => {
  return {
    can: vi.fn(() => true),
    canDo: vi.fn(() => true),
    buildActorContext: vi.fn(() => ({})),
    AuthzError: class AuthzError extends Error {
      statusCode: number;
      reason: string;
      constructor(opts: { statusCode: number; reason: string; message?: string }) {
        super(opts.message ?? opts.reason);
        this.name = "AuthzError";
        this.statusCode = opts.statusCode;
        this.reason = opts.reason;
      }
    },
    EFFECTIVE_GRANTS: {},
    POLICY_VERSION: "test",
    logAuditEvent: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "org-A";
const USER_OWNER = "user-owner";
const USER_GRANTEE = "user-grantee";
const PROJECT_ID = "proj-1";

const ownedRow = {
  id: PROJECT_ID,
  name: "Test Project",
  description: null,
  ownerLevel: "user",
  ownerId: USER_OWNER,
  organizationId: ORG_A,
  visibility: "private",
  slug: "test-project",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

const archivedRow = {
  ...ownedRow,
  id: "proj-archived",
  slug: "archived-project",
  createdAt: new Date("2026-05-02T00:00:00Z"),
};

const ownerActor = {
  actorType: "human",
  source: "ui",
  userId: USER_OWNER,
  orgId: ORG_A,
  organizationId: ORG_A,
  roles: ["member"],
  projectGrants: [
    {
      projectId: PROJECT_ID,
      effectiveRole: "owner" as ProjectRole,
      accessSource: "owner" as ProjectAccessSource,
    },
  ] satisfies ProjectGrant[],
} as unknown as PrimitiveActorContext;

const adminGranteeActor = {
  actorType: "human",
  source: "ui",
  userId: USER_GRANTEE,
  orgId: ORG_A,
  organizationId: ORG_A,
  roles: ["member"],
  // Grantee is a project_access admin, NOT the owner — must be unable
  // to grant `role='admin'` to anyone else (SC-7.a / D7.a).
  projectGrants: [
    {
      projectId: PROJECT_ID,
      effectiveRole: "admin" as ProjectRole,
      accessSource: "user" as ProjectAccessSource,
    },
  ] satisfies ProjectGrant[],
} as unknown as PrimitiveActorContext;

// Negative-test actors for the `assertProjectGrantRole` gate.
// The all-allow authz
// stub masked role-rank denials; these actors exercise the explicit
// `read`-only / `write`-only paths.
const readOnlyActor = {
  actorType: "human",
  source: "ui",
  userId: "user-readonly",
  orgId: ORG_A,
  organizationId: ORG_A,
  roles: ["member"],
  projectGrants: [
    {
      projectId: PROJECT_ID,
      effectiveRole: "read" as ProjectRole,
      accessSource: "user" as ProjectAccessSource,
    },
  ] satisfies ProjectGrant[],
} as unknown as PrimitiveActorContext;

const writeActor = {
  actorType: "human",
  source: "ui",
  userId: "user-writer",
  orgId: ORG_A,
  organizationId: ORG_A,
  roles: ["member"],
  projectGrants: [
    {
      projectId: PROJECT_ID,
      effectiveRole: "write" as ProjectRole,
      accessSource: "user" as ProjectAccessSource,
    },
  ] satisfies ProjectGrant[],
} as unknown as PrimitiveActorContext;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let handlers: ReturnType<typeof import("../mcp/handlers").createProjectsPrimitiveHandlers>;

beforeEach(async () => {
  vi.clearAllMocks();
  execCalls.length = 0;
  const mod = await import("../mcp/handlers");
  handlers = mod.createProjectsPrimitiveHandlers();
});

// ---------------------------------------------------------------------------
// project_access_grant
// ---------------------------------------------------------------------------

describe("project_access_grant", () => {
  it("happy path: writes a row with INSERT … ON CONFLICT … DO UPDATE", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_access_grant"]({
      primitiveName: "project_access_grant",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "user",
        principalId: USER_GRANTEE,
        role: "write",
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    // Verify the INSERT happened and used ON CONFLICT DO UPDATE — the
    // raw SQL string is in the captured chunk; check via the chunked
    // structure that Drizzle's sql tag produces.
    const sqlText = JSON.stringify(execCalls[0]?.raw ?? "");
    expect(sqlText).toContain("project_access");
    expect(sqlText).toContain("INSERT");
    expect(sqlText).toContain("ON CONFLICT");
    expect(sqlText).toContain("DO UPDATE");
  });

  it("SC-4: rejects owner self-insert with 400 owner_implicit", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    await expect(
      handlers["project_access_grant"]({
        primitiveName: "project_access_grant",
        input: {
          projectId: PROJECT_ID,
          principalLevel: "user",
          principalId: USER_OWNER, // matches projects.owner_id
          role: "admin",
        },
        actor: ownerActor,
        mode: "agentic",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 400,
      reason: "owner_implicit",
    });
    // No INSERT should have been issued.
    expect(execCalls.length).toBe(0);
  });

  it("D7.a: admin-grant by a non-owner (project_access admin) is rejected 403", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    await expect(
      handlers["project_access_grant"]({
        primitiveName: "project_access_grant",
        input: {
          projectId: PROJECT_ID,
          principalLevel: "user",
          principalId: "user-some-other",
          role: "admin",
        },
        actor: adminGranteeActor, // NOT the owner
        mode: "agentic",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
    expect(execCalls.length).toBe(0);
  });

  it("owner can grant admin role to another principal", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_access_grant"]({
      primitiveName: "project_access_grant",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "team",
        principalId: "team-xyz",
        role: "admin",
      },
      actor: ownerActor, // effectiveRole === 'owner'
      mode: "agentic",
    } as never);
    expect(result).toEqual({ ok: true });
    expect(execCalls.length).toBe(1);
  });

  it("read-only actor cannot grant (assertProjectGrantRole rejects 403)", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    await expect(
      handlers["project_access_grant"]({
        primitiveName: "project_access_grant",
        input: {
          projectId: PROJECT_ID,
          principalLevel: "user",
          principalId: "user-some-other",
          role: "write",
        },
        actor: readOnlyActor, // effectiveRole === 'read'
        mode: "agentic",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
    // No INSERT was issued — gate ran BEFORE any SQL write.
    expect(execCalls.length).toBe(0);
  });

  it("write actor cannot manage membership (grant rejects 403)", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    await expect(
      handlers["project_access_grant"]({
        primitiveName: "project_access_grant",
        input: {
          projectId: PROJECT_ID,
          principalLevel: "user",
          principalId: "user-some-other",
          role: "write",
        },
        actor: writeActor, // effectiveRole === 'write' < admin
        mode: "agentic",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
    expect(execCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// project_access_revoke
// ---------------------------------------------------------------------------

describe("project_access_revoke", () => {
  it("happy path: DELETE matching row", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_access_revoke"]({
      primitiveName: "project_access_revoke",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "user",
        principalId: USER_GRANTEE,
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    const sqlText = JSON.stringify(execCalls[0]?.raw ?? "");
    expect(sqlText).toContain("DELETE");
    expect(sqlText).toContain("project_access");
  });
});

// ---------------------------------------------------------------------------
// project_access_list
// ---------------------------------------------------------------------------

describe("project_access_list", () => {
  it("returns the derived OWNER row + all project_access rows", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [
        {
          principal_level: "user",
          principal_id: USER_GRANTEE,
          role: "write",
          granted_by: USER_OWNER,
          granted_at: new Date("2026-05-03T00:00:00Z"),
        },
        {
          principal_level: "team",
          principal_id: "team-xyz",
          role: "admin",
          granted_by: USER_OWNER,
          granted_at: new Date("2026-05-04T00:00:00Z"),
        },
      ],
    } as never);

    const result = (await handlers["project_access_list"]({
      primitiveName: "project_access_list",
      input: { projectId: PROJECT_ID },
      actor: ownerActor,
      mode: "agentic",
    } as never)) as { items: Array<{ role: string; principalId: string; accessSource: string }> };

    expect(result.items).toHaveLength(3);
    // Owner row first
    expect(result.items[0]).toMatchObject({
      principalLevel: "user",
      principalId: USER_OWNER,
      role: "owner",
      accessSource: "owner",
    });
    // Project_access rows next
    expect(result.items[1]).toMatchObject({
      principalLevel: "user",
      principalId: USER_GRANTEE,
      role: "write",
      accessSource: "user",
    });
    expect(result.items[2]).toMatchObject({
      principalLevel: "team",
      principalId: "team-xyz",
      role: "admin",
      accessSource: "team",
    });
  });
});

// ---------------------------------------------------------------------------
// project_access_check
// ---------------------------------------------------------------------------

describe("project_access_check", () => {
  it("returns 'owner' when queried principal is the project owner (SC-4 short-circuit)", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_access_check"]({
      primitiveName: "project_access_check",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "user",
        principalId: USER_OWNER,
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toMatchObject({
      effectiveRole: "owner",
      accessSource: "owner",
    });
  });

  it("returns the project_access row role when queried principal has an explicit grant", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [{ role: "write" }],
    } as never);

    const result = await handlers["project_access_check"]({
      primitiveName: "project_access_check",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "user",
        principalId: USER_GRANTEE,
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toMatchObject({
      effectiveRole: "write",
      accessSource: "user",
    });
  });

  it("returns null effectiveRole when no row matches", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({ rows: [] } as never);

    const result = await handlers["project_access_check"]({
      primitiveName: "project_access_check",
      input: {
        projectId: PROJECT_ID,
        principalLevel: "user",
        principalId: "user-noaccess",
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toMatchObject({
      effectiveRole: null,
      accessSource: null,
    });
  });
});

// ---------------------------------------------------------------------------
// project_agent_template_bindings_* CRUD
// ---------------------------------------------------------------------------

describe("project_agent_template_bindings_create", () => {
  it("writes INSERT … ON CONFLICT … DO UPDATE on the bindings table", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_agent_template_bindings_create"]({
      primitiveName: "project_agent_template_bindings_create",
      input: {
        projectId: PROJECT_ID,
        agentTemplateId: "tpl-abc",
        visibility: "visible",
        pinnedVersion: "1.2.3",
        defaultContextOverrides: { foo: "bar" },
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    const sqlText = JSON.stringify(execCalls[0]?.raw ?? "");
    expect(sqlText).toContain("project_agent_template_bindings");
    expect(sqlText).toContain("INSERT");
    expect(sqlText).toContain("ON CONFLICT");
  });
});

describe("project_agent_template_bindings_update", () => {
  it("issues a sparse UPDATE when fields are provided", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    // RETURNING 1 + 404 on zero affected rows. Happy-path mock must
    // return a non-empty row.
    // `mockResolvedValueOnce` replaces the default implementation that
    // tracks into `execCalls`, so inspect the call args via vi.mocked
    // instead.
    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [{ ok: 1 }],
    } as never);

    const result = await handlers["project_agent_template_bindings_update"]({
      primitiveName: "project_agent_template_bindings_update",
      input: {
        projectId: PROJECT_ID,
        agentTemplateId: "tpl-abc",
        visibility: "hidden",
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    const firstCallArg = vi.mocked(projectsDb.execute).mock.calls[0]?.[0];
    const sqlText = JSON.stringify(
      (firstCallArg as { queryChunks?: unknown }).queryChunks ?? firstCallArg,
    );
    expect(sqlText).toContain("UPDATE");
    expect(sqlText).toContain("project_agent_template_bindings");
    // Verify RETURNING is in the SQL.
    expect(sqlText).toContain("RETURNING");
  });

  it("throws 404 when no binding row matches", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    // The default mock returns `{ rows: [] }` so RETURNING gives zero
    // rows — the handler must throw 404, not silently succeed.
    await expect(
      handlers["project_agent_template_bindings_update"]({
        primitiveName: "project_agent_template_bindings_update",
        input: {
          projectId: PROJECT_ID,
          agentTemplateId: "tpl-missing",
          visibility: "hidden",
        },
        actor: ownerActor,
        mode: "agentic",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 404,
      reason: "hidden",
    });
  });

  it("no-ops when no mutable field is provided", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_agent_template_bindings_update"]({
      primitiveName: "project_agent_template_bindings_update",
      input: {
        projectId: PROJECT_ID,
        agentTemplateId: "tpl-abc",
      },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    // Verify NO UPDATE was issued.
    expect(execCalls.length).toBe(0);
  });
});

describe("project_agent_template_bindings_delete", () => {
  it("DELETEs the binding row", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const result = await handlers["project_agent_template_bindings_delete"]({
      primitiveName: "project_agent_template_bindings_delete",
      input: { projectId: PROJECT_ID, agentTemplateId: "tpl-abc" },
      actor: ownerActor,
      mode: "agentic",
    } as never);

    expect(result).toEqual({ ok: true });
    const sqlText = JSON.stringify(execCalls[0]?.raw ?? "");
    expect(sqlText).toContain("DELETE");
    expect(sqlText).toContain("project_agent_template_bindings");
  });
});

describe("project_agent_template_bindings_list", () => {
  it("returns mapped binding rows", async () => {
    const { readProjectById } = await import("@/lib/projects-store-dao");
    vi.mocked(readProjectById).mockResolvedValue(ownedRow as never);

    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [
        {
          agent_template_id: "tpl-1",
          visibility: "visible",
          pinned_version: null,
          default_context_overrides: null,
          created_by: USER_OWNER,
          created_at: new Date("2026-05-05T00:00:00Z"),
        },
      ],
    } as never);

    const result = (await handlers["project_agent_template_bindings_list"]({
      primitiveName: "project_agent_template_bindings_list",
      input: { projectId: PROJECT_ID },
      actor: ownerActor,
      mode: "agentic",
    } as never)) as { items: Array<{ agentTemplateId: string }> };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      agentTemplateId: "tpl-1",
      visibility: "visible",
      pinnedVersion: null,
      projectId: PROJECT_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// projects_list union (owned ∪ accessed) + archived filter
// ---------------------------------------------------------------------------

describe("projects_list union", () => {
  it("returns owned + accessed rows with effectiveRole + accessSource per row", async () => {
    const { projectsDb } = await import("@/lib/projects-store");
    // The handler resolves `actor.projectGrants`, then issues ONE SQL
    // query that returns matching project rows. Return two rows (owned
    // + accessed).
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [
        {
          id: PROJECT_ID,
          name: "Test Project",
          description: null,
          owner_level: "user",
          owner_id: USER_OWNER,
          organization_id: ORG_A,
          visibility: "private",
          slug: "test-project",
          created_at: new Date("2026-05-01T00:00:00Z"),
          archived_at: null,
        },
        {
          id: "proj-shared",
          name: "Shared Project",
          description: null,
          owner_level: "user",
          owner_id: "user-other-owner",
          organization_id: ORG_A,
          visibility: "private",
          slug: "shared-project",
          created_at: new Date("2026-04-30T00:00:00Z"),
          archived_at: null,
        },
      ],
    } as never);

    const actorWithMixedGrants = {
      ...ownerActor,
      projectGrants: [
        {
          projectId: PROJECT_ID,
          effectiveRole: "owner",
          accessSource: "owner",
        },
        {
          projectId: "proj-shared",
          effectiveRole: "write",
          accessSource: "user",
        },
      ] satisfies ProjectGrant[],
    } as unknown as PrimitiveActorContext;

    const result = (await handlers["projects_list"]({
      primitiveName: "projects_list",
      input: {},
      actor: actorWithMixedGrants,
      mode: "agentic",
    } as never)) as { items: Array<{ id: string; effectiveRole: string; accessSource: string }> };

    expect(result.items).toHaveLength(2);
    const ownedItem = result.items.find((i) => i.id === PROJECT_ID);
    const sharedItem = result.items.find((i) => i.id === "proj-shared");
    expect(ownedItem).toMatchObject({ effectiveRole: "owner", accessSource: "owner" });
    expect(sharedItem).toMatchObject({ effectiveRole: "write", accessSource: "user" });
  });

  it("returns empty list when actor has no projectGrants (defence-in-depth)", async () => {
    const noGrantActor = {
      ...ownerActor,
      projectGrants: [],
    } as unknown as PrimitiveActorContext;

    const result = (await handlers["projects_list"]({
      primitiveName: "projects_list",
      input: {},
      actor: noGrantActor,
      mode: "agentic",
    } as never)) as { items: unknown[] };

    expect(result.items).toEqual([]);
    // No SQL should have been issued.
    expect(execCalls.length).toBe(0);
  });

  it("default archived=false: filters out archived rows by NOT including them in SQL", async () => {
    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({ rows: [] } as never);

    await handlers["projects_list"]({
      primitiveName: "projects_list",
      input: {}, // includeArchived defaults to false
      actor: ownerActor,
      mode: "agentic",
    } as never);

    // The SQL must include the archived_at IS NULL filter when
    // includeArchived is false (default). vi mock.calls always records
    // call args even when behaviour is overridden via mockResolvedValueOnce.
    const firstCallArg = vi.mocked(projectsDb.execute).mock.calls[0]?.[0];
    const sqlText = JSON.stringify(
      (firstCallArg as { queryChunks?: unknown }).queryChunks ?? firstCallArg,
    );
    expect(sqlText).toContain("archived_at IS NULL");
  });

  it("includeArchived=true: omits the archived_at IS NULL filter", async () => {
    const { projectsDb } = await import("@/lib/projects-store");
    vi.mocked(projectsDb.execute).mockResolvedValueOnce({
      rows: [
        {
          ...archivedRow,
          owner_level: archivedRow.ownerLevel,
          owner_id: archivedRow.ownerId,
          organization_id: archivedRow.organizationId,
          created_at: archivedRow.createdAt,
          archived_at: new Date("2026-05-15T00:00:00Z"),
        },
      ],
    } as never);

    const actorForArchived = {
      ...ownerActor,
      projectGrants: [
        {
          projectId: archivedRow.id,
          effectiveRole: "owner",
          accessSource: "owner",
        },
      ] satisfies ProjectGrant[],
    } as unknown as PrimitiveActorContext;

    const result = (await handlers["projects_list"]({
      primitiveName: "projects_list",
      input: { includeArchived: true },
      actor: actorForArchived,
      mode: "agentic",
    } as never)) as { items: Array<{ id: string; archivedAt: Date | null }> };

    const firstCallArg = vi.mocked(projectsDb.execute).mock.calls[0]?.[0];
    const sqlText = JSON.stringify(
      (firstCallArg as { queryChunks?: unknown }).queryChunks ?? firstCallArg,
    );
    expect(sqlText).not.toContain("archived_at IS NULL");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: archivedRow.id });
  });
});

// ---------------------------------------------------------------------------
// Removed project-access primitives: text-grep asserts on the source files
// ---------------------------------------------------------------------------

describe("removed project-access primitives", () => {
  const handlersSrc = readFileSync(
    join(REPO_ROOT, "packages/projects/src/mcp/handlers.ts"),
    "utf8",
  );
  const registrySrc = readFileSync(
    join(REPO_ROOT, "packages/projects/src/mcp/registry.ts"),
    "utf8",
  );

  it("scope-ratchet symbol absent from packages/projects/src/mcp/handlers.ts", () => {
    // Match the absence-check regex character-for-character.
    expect(/assertScopeRatchet/.test(handlersSrc)).toBe(false);
  });

  it("projects_delete entry absent from packages/projects/src/mcp/registry.ts", () => {
    // Match the absence-check regex `/projects_delete\s*:/`.
    expect(/projects_delete\s*:/.test(registrySrc)).toBe(false);
  });

  it("no INSERT into project_access references owner_id (SC-4 dual-truth guard)", () => {
    const sqlText = handlersSrc;
    expect(/INSERT INTO[^;]*project_access[^;]*owner_id/i.test(sqlText)).toBe(
      false,
    );
  });
});
