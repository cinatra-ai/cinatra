/**
 * cinatra#2485 C — the SHARED run-scope guard: per-path authorization matrix,
 * actor resolution, and the fire-time recheck.
 *
 * The guard is the single helper all three enforcement layers call (creation
 * perimeter, dispatch guard, worker fire-time recheck). Each enumerated
 * run-creation/dispatch path reaches it with one of exactly three actor shapes,
 * so the matrix below covers every path by its shape AND names the paths:
 *
 *   (a) EXPLICIT actor, no `runBy`
 *       — published-agent-as-MCP-tool, public A2A executor, UI A2A action
 *         (in-process), MCP `agent_run` on a frame with no user id.
 *   (b) `runBy` only (actor resolved LIVE from the persisted run owner)
 *       — Run button / recommendation-chip release, createAndTriggerRun,
 *         pending/chat run, dev child preview, registry run action, external
 *         A2A action, host content-editor dispatch (BOTH the enqueued identity
 *         path and the NON-enqueued actorOverride carrier run), scheduled +
 *         recurring fires, lifecycle repair, enqueue repair.
 *   (c) NEITHER — a genuinely autonomous run, authorized as the template's
 *       persisted installation principal, or refused when there is none.
 *
 * Plus the divergent case (explicit actor AND a different `runBy`): BOTH must
 * be in scope, so neither an in-scope requester minting an out-of-scope owner's
 * run nor the reverse gets through.
 *
 * Harness: `../db` is faked (select-by-table), and the canonical live-actor
 * resolver `@/lib/authz/build-actor-context-from-run` is mocked with a
 * per-user membership table that the fire-time test MUTATES between the
 * dispatch check and the execute check — that mutation IS "descoped at fire".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-alpha";
const OTHER_ORG = "org-beta";

const shared = vi.hoisted(() => ({
  templateRows: [] as Array<Record<string, unknown>>,
  runRows: [] as Array<Record<string, unknown>>,
  /** LIVE membership table the mocked resolver reads — mutate to descope. */
  memberships: {} as Record<
    string,
    { orgId: string; teamIds: string[]; projectIds: string[]; orgRole: string }
  >,
  resolverCalls: [] as string[],
}));

vi.mock("../db", async () => {
  const { agentRuns, agentTemplates } = await import("../schema");
  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === agentTemplates) return shared.templateRows;
    if (table === agentRuns) return shared.runRows;
    return [];
  }
  function select(projection?: Record<string, unknown>) {
    return {
      from(table: unknown) {
        const rows = rowsFor(table);
        const project = (r: Record<string, unknown>) => {
          if (!projection) return r;
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(projection)) out[key] = r[key];
          return out;
        };
        const resolved = rows.map(project);
        return {
          where: () => ({ limit: async () => resolved }),
        };
      },
    };
  }
  return { db: { select }, agentBuilderPool: {} };
});

// The membership probe the guard runs BEFORE building an actor. `undefined`
// means "no membership row" — the signal that makes revocation effective.
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: async (orgId: string, userId: string) => {
    const m = shared.memberships[userId];
    if (!m || m.orgId !== orgId) return undefined;
    return m.orgRole;
  },
}));

vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: async (run: { id: string; runBy: string | null; orgId: string }) => {
    shared.resolverCalls.push(run.runBy ?? "<none>");
    if (!run.runBy) {
      // Mirrors the real resolver's runBy-less degradation: a membership-less
      // InternalWorker principal.
      return {
        principalType: "InternalWorker",
        principalId: `run:${run.id}`,
        organizationId: run.orgId,
        teamIds: [],
        projectGrants: [],
        projectIds: [],
        authSource: "a2a",
        policyVersion: "v2",
      } as unknown as ActorContext;
    }
    const m = shared.memberships[run.runBy];
    return {
      principalType: "HumanUser",
      principalId: run.runBy,
      organizationId: m?.orgId,
      teamIds: m?.teamIds ?? [],
      projectIds: m?.projectIds ?? [],
      projectGrants: (m?.projectIds ?? []).map((projectId) => ({
        projectId,
        effectiveRole: "write",
        accessSource: "user",
      })),
      orgRole: m?.orgRole ?? "member",
      platformRole: "member",
      authSource: "worker",
      policyVersion: "v2",
    } as unknown as ActorContext;
  },
}));

const {
  assertAgentRunScopeAuthorized,
  assertAgentRunDispatchAuthorized,
} = await import("../agent-template-scope-guard");
const { AgentTemplateScopeError } = await import("../agent-template-scope");

function seedTemplate(overrides: Record<string, unknown> = {}) {
  shared.templateRows = [
    {
      id: "tmpl-1",
      orgId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
      creatorId: null,
      ...overrides,
    },
  ];
}

function seedRun(overrides: Record<string, unknown> = {}) {
  shared.runRows = [
    { id: "run-1", templateId: "tmpl-1", orgId: ORG, runBy: null, ...overrides },
  ];
}

function explicitActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-explicit",
    organizationId: ORG,
    teamIds: [],
    projectIds: [],
    projectGrants: [],
    orgRole: "member",
    platformRole: "member",
    authSource: "mcp",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

async function refusalReason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AgentTemplateScopeError) return err.reason;
    throw err;
  }
  throw new Error("expected AgentTemplateScopeError, but the call resolved");
}

beforeEach(() => {
  shared.templateRows = [];
  shared.runRows = [];
  shared.memberships = {};
  shared.resolverCalls = [];
});

// ---------------------------------------------------------------------------
// (a) EXPLICIT actor, no runBy
// ---------------------------------------------------------------------------
describe.each([
  ["published-agent-as-MCP-tool (agent-tools-registry)", "create" as const],
  ["public A2A executor (a2a-server createRunWithAuthority)", "create" as const],
  ["UI A2A action, in-process executor (a2a-actions)", "create" as const],
])("explicit-actor path — %s", (_label, stage) => {
  it("ALLOWS an in-scope actor", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    shared.memberships["user-explicit"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage,
        templateId: "tmpl-1",
        orgId: ORG,
        actor: explicitActor(),
      }),
    ).resolves.toBeUndefined();
  });

  it("DENIES an actor who is not a live member of the run's org", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    shared.memberships["user-explicit"] = {
      orgId: OTHER_ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage,
          templateId: "tmpl-1",
          orgId: ORG,
          actor: explicitActor({ organizationId: OTHER_ORG }),
        }),
      ),
    ).toBe("cross_org");
  });

  it("DENIES an org member on a team-scoped agent they do not hold", async () => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
    shared.memberships["user-explicit"] = {
      orgId: ORG,
      teamIds: ["team-3"],
      projectIds: [],
      orgRole: "member",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage,
          templateId: "tmpl-1",
          orgId: ORG,
          actor: explicitActor({ teamIds: ["team-3"] }),
        }),
      ),
    ).toBe("not_team_member");
  });

  it("RE-RESOLVES a human actor LIVE rather than trusting the axes it carries", async () => {
    // The MCP/chat frame forwards org/platform roles but NOT teamIds /
    // projectGrants. Believing that thin actor would false-deny a real member
    // of the owning team; trusting a fat one would let a forged payload in.
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
    shared.memberships["user-explicit"] = {
      orgId: ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "member",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage,
        templateId: "tmpl-1",
        orgId: ORG,
        actor: explicitActor({ teamIds: [] }), // axis absent on the wire
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual(["user-explicit"]);
  });

  it("does NOT believe membership an actor payload claims but the database denies", async () => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
    shared.memberships["user-explicit"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_admin",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage,
          templateId: "tmpl-1",
          orgId: ORG,
          actor: explicitActor({ teamIds: ["team-7"] }), // forged claim
        }),
      ),
    ).toBe("not_team_member");
  });

  it("evaluates a NON-human principal as supplied (no membership rows to resolve)", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    const peer = {
      principalType: "ExternalA2AAgent",
      principalId: "peer-1",
      organizationId: ORG,
      teamIds: [],
      projectIds: [],
      projectGrants: [],
      authSource: "a2a",
      policyVersion: "v2",
    } as unknown as ActorContext;
    await expect(
      assertAgentRunScopeAuthorized({
        stage,
        templateId: "tmpl-1",
        orgId: ORG,
        actor: peer,
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual([]);
  });

  it("DENIES a non-human principal from another org", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    const peer = {
      principalType: "ExternalA2AAgent",
      principalId: "peer-1",
      organizationId: OTHER_ORG,
      teamIds: [],
      projectIds: [],
      projectGrants: [],
      authSource: "a2a",
      policyVersion: "v2",
    } as unknown as ActorContext;
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage,
          templateId: "tmpl-1",
          orgId: ORG,
          actor: peer,
        }),
      ),
    ).toBe("cross_org");
  });
});

// ---------------------------------------------------------------------------
// (b) runBy only — the actor is resolved LIVE from the persisted run owner
// ---------------------------------------------------------------------------
describe.each([
  ["Run button / recommendation-chip release (triggerAgentRun)"],
  ["createAndTriggerRun + pending/chat run"],
  ["dev child preview (startDevChildPreviewRun)"],
  ["registry run action (runFromRegistry)"],
  ["external A2A UI action (a2a-actions external branch)"],
  ["host content-editor dispatch — identity path"],
  ["host content-editor dispatch — actorOverride carrier run (NOT BullMQ-enqueued)"],
  ["scheduled fire (trigger-release-job)"],
  ["recurring fire — clone carries the source run's runBy"],
  ["lifecycle repair dispatch (originating human)"],
  ["project/PM delegation enqueue repair"],
])("runBy path — %s", () => {
  it("ALLOWS when the run owner is in scope (personal)", async () => {
    seedTemplate({ ownerLevel: "user", ownerId: "user-owner" });
    shared.memberships["user-owner"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "create",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: "user-owner",
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual(["user-owner"]);
  });

  it("DENIES when the run owner is not the personal-scope owner", async () => {
    seedTemplate({ ownerLevel: "user", ownerId: "user-owner" });
    shared.memberships["user-other"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_admin",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "create",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: "user-other",
        }),
      ),
    ).toBe("not_owner");
  });

  it("ALLOWS a project-scoped agent for a run owner holding the project", async () => {
    seedTemplate({ ownerLevel: "project", ownerId: "proj-9" });
    shared.memberships["user-pm"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: ["proj-9"],
      orgRole: "member",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "dispatch",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: "user-pm",
      }),
    ).resolves.toBeUndefined();
  });

  it("DENIES a project-scoped agent for a run owner without the project grant", async () => {
    seedTemplate({ ownerLevel: "project", ownerId: "proj-9" });
    shared.memberships["user-pm"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: ["proj-1"],
      orgRole: "member",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "dispatch",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: "user-pm",
        }),
      ),
    ).toBe("not_project_member");
  });

  it("ALLOWS an org-admin at ORG scope", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    shared.memberships["user-admin"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_admin",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "create",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: "user-admin",
      }),
    ).resolves.toBeUndefined();
  });

  it("DENIES a null-scope template for every run owner, including an org owner", async () => {
    seedTemplate({ ownerLevel: null, ownerId: null });
    shared.memberships["user-owner"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_owner",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "create",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: "user-owner",
        }),
      ),
    ).toBe("unknown_scope");
  });
});

// ---------------------------------------------------------------------------
// (c) autonomous — installation principal, or refusal
// ---------------------------------------------------------------------------
describe("autonomous run (no explicit actor, no runBy)", () => {
  it("authorizes as the template's PERSISTED installation principal when it is in scope", async () => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7", creatorId: "user-installer" });
    shared.memberships["user-installer"] = {
      orgId: ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "member",
    };
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "dispatch",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: null,
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual(["user-installer"]);
  });

  it("REFUSES when the installation principal has lost the scope — no generic system bypass", async () => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7", creatorId: "user-installer" });
    shared.memberships["user-installer"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_admin",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "dispatch",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: null,
        }),
      ),
    ).toBe("not_team_member");
  });

  it("ALLOWS an ORG-scoped agent's ownerless run when the run belongs to the owning org", async () => {
    // At org scope "in scope" means "belongs to the owning org", and the run's
    // own org_id IS that evidence. No principal needed, and no principal
    // invented — an ownerless lifecycle repair or recurring clone of a
    // runBy-less source could otherwise never dispatch an org-wide agent.
    seedTemplate({ ownerLevel: "organization", ownerId: ORG, creatorId: null });
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "dispatch",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: null,
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual([]);
  });

  it("does NOT extend the org-anchored allowance across orgs", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG, creatorId: null });
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "dispatch",
          templateId: "tmpl-1",
          orgId: OTHER_ORG,
          runId: "run-1",
          runBy: null,
        }),
      ),
    ).toBe("no_actor");
  });

  it("does NOT extend the org-anchored allowance to a NARROWER scope", async () => {
    // A team/project/personal agent's scope is not proven by the run's org.
    seedTemplate({ ownerLevel: "team", ownerId: "team-7", creatorId: null });
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "dispatch",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: null,
        }),
      ),
    ).toBe("no_actor");
  });

  it("REFUSES a scope-less template's ownerless run", async () => {
    seedTemplate({ ownerLevel: null, ownerId: null, creatorId: null });
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "dispatch",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: null,
        }),
      ),
    ).toBe("no_actor");
  });
});

// ---------------------------------------------------------------------------
// Divergent requester / run-owner — BOTH must pass
// ---------------------------------------------------------------------------
describe("divergent requester and run owner", () => {
  const inTeam = { orgId: ORG, teamIds: ["team-7"], projectIds: [], orgRole: "member" };
  const notInTeam = { orgId: ORG, teamIds: [], projectIds: [], orgRole: "member" };

  beforeEach(() => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
  });

  it("ALLOWS when both are in scope, resolving each human exactly once", async () => {
    shared.memberships["user-owner"] = { ...inTeam };
    shared.memberships["user-explicit"] = { ...inTeam };
    await expect(
      assertAgentRunScopeAuthorized({
        stage: "create",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: "user-owner",
        actor: explicitActor(),
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual(["user-explicit", "user-owner"]);
  });

  it("DENIES an in-scope requester minting a run OWNED by an out-of-scope principal", async () => {
    shared.memberships["user-owner"] = { ...notInTeam };
    shared.memberships["user-explicit"] = { ...inTeam };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "create",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: "user-owner",
          actor: explicitActor(),
        }),
      ),
    ).toBe("not_team_member");
  });

  it("DENIES an out-of-scope requester minting a run owned by an in-scope principal", async () => {
    shared.memberships["user-owner"] = { ...inTeam };
    shared.memberships["user-explicit"] = { ...notInTeam };
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "create",
          templateId: "tmpl-1",
          orgId: ORG,
          runId: "run-1",
          runBy: "user-owner",
          actor: explicitActor(),
        }),
      ),
    ).toBe("not_team_member");
  });

  it("checks the requester even when only the OWNER is named on the run row", async () => {
    // The requester is checked FIRST, so an out-of-scope requester is refused
    // before the owner is ever resolved.
    shared.memberships["user-owner"] = { ...inTeam };
    shared.memberships["user-explicit"] = { ...notInTeam };
    await refusalReason(() =>
      assertAgentRunScopeAuthorized({
        stage: "create",
        templateId: "tmpl-1",
        orgId: ORG,
        runId: "run-1",
        runBy: "user-owner",
        actor: explicitActor(),
      }),
    );
    expect(shared.resolverCalls).toContain("user-explicit");
  });
});

// ---------------------------------------------------------------------------
// The DISPATCHING actor (an admin releasing / a reviewer clearing SOMEONE
// ELSE's run) must be in scope too
// ---------------------------------------------------------------------------
describe("dispatching actor (releaseTriggerNow / HITL approve)", () => {
  beforeEach(() => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
    seedRun({ runBy: "user-owner" });
    shared.memberships["user-owner"] = {
      orgId: ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "member",
    };
  });

  it("ALLOWS an org admin who is ALSO inside the owning team", async () => {
    shared.memberships["user-admin"] = {
      orgId: ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "org_admin",
    };
    await expect(
      assertAgentRunDispatchAuthorized({
        runId: "run-1",
        stage: "dispatch",
        actingUserId: "user-admin",
      }),
    ).resolves.toBeUndefined();
  });

  it("DENIES an org admin OUTSIDE the owning team even though the run OWNER is in scope", async () => {
    shared.memberships["user-admin"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_admin",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({
          runId: "run-1",
          stage: "dispatch",
          actingUserId: "user-admin",
        }),
      ),
    ).toBe("not_team_member");
  });

  it("DENIES a dispatcher who is not a member of the run's org at all", async () => {
    shared.memberships["user-outsider"] = {
      orgId: OTHER_ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "org_owner",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({
          runId: "run-1",
          stage: "dispatch",
          actingUserId: "user-outsider",
        }),
      ),
    ).toBe("cross_org");
  });

  it("still passes when the dispatcher IS the run owner (one resolve, one check)", async () => {
    await expect(
      assertAgentRunDispatchAuthorized({
        runId: "run-1",
        stage: "dispatch",
        actingUserId: "user-owner",
      }),
    ).resolves.toBeUndefined();
    expect(shared.resolverCalls).toEqual(["user-owner"]);
  });
});

// ---------------------------------------------------------------------------
// Membership REVOCATION actually takes effect
// ---------------------------------------------------------------------------
describe("org-membership revocation", () => {
  it("REFUSES a run owner who was removed from the org, even at org scope", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    seedRun({ runBy: "user-removed" });
    // No membership row at all — the run row still carries the org anchor, and
    // the canonical run-actor builder would stamp it back onto the actor with a
    // default `member` role. The guard's membership probe is what stops that
    // from reading as membership.
    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "execute" }),
      ),
    ).toBe("cross_org");
  });

  it("REFUSES once membership moves to a different org", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    seedRun({ runBy: "user-moved" });
    shared.memberships["user-moved"] = {
      orgId: OTHER_ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "org_owner",
    };
    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "execute" }),
      ),
    ).toBe("cross_org");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed edges
// ---------------------------------------------------------------------------
describe("fail-closed edges", () => {
  it("REFUSES when the template row cannot be read", async () => {
    shared.templateRows = [];
    expect(
      await refusalReason(() =>
        assertAgentRunScopeAuthorized({
          stage: "create",
          templateId: "tmpl-gone",
          orgId: ORG,
          runBy: "user-owner",
        }),
      ),
    ).toBe("unknown_scope");
  });

  it("dispatch guard stays quiet for a run row that does not exist (the caller owns that case)", async () => {
    seedTemplate();
    shared.runRows = [];
    await expect(
      assertAgentRunDispatchAuthorized({ runId: "run-missing", stage: "dispatch" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — FIRE-TIME recheck
// ---------------------------------------------------------------------------
describe("fire-time recheck (authorized at schedule, descoped at fire)", () => {
  it("allows the dispatch, then REFUSES the same run once the owner loses the scope", async () => {
    seedTemplate({ ownerLevel: "team", ownerId: "team-7" });
    seedRun({ runBy: "user-scheduler" });
    shared.memberships["user-scheduler"] = {
      orgId: ORG,
      teamIds: ["team-7"],
      projectIds: [],
      orgRole: "member",
    };

    // Armed / dispatched while authorized.
    await expect(
      assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "dispatch" }),
    ).resolves.toBeUndefined();

    // ... membership revoked between arm and fire.
    shared.memberships["user-scheduler"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };

    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "execute" }),
      ),
    ).toBe("not_team_member");
  });

  it("REFUSES at fire time when the agent itself was RE-SCOPED after the run was armed", async () => {
    seedTemplate({ ownerLevel: "organization", ownerId: ORG });
    seedRun({ runBy: "user-scheduler" });
    shared.memberships["user-scheduler"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };

    await expect(
      assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "dispatch" }),
    ).resolves.toBeUndefined();

    // Owner narrows the agent to a personal scope the run owner is not.
    seedTemplate({ ownerLevel: "user", ownerId: "someone-else" });

    expect(
      await refusalReason(() =>
        assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "execute" }),
      ),
    ).toBe("not_owner");
  });

  it("carries the refusing stage on the error so the layer is legible", async () => {
    seedTemplate({ ownerLevel: "user", ownerId: "nobody" });
    seedRun({ runBy: "user-scheduler" });
    shared.memberships["user-scheduler"] = {
      orgId: ORG,
      teamIds: [],
      projectIds: [],
      orgRole: "member",
    };
    let thrown: unknown;
    try {
      await assertAgentRunDispatchAuthorized({ runId: "run-1", stage: "execute" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTemplateScopeError);
    expect((thrown as InstanceType<typeof AgentTemplateScopeError>).stage).toBe(
      "execute/run-owner",
    );
  });
});
