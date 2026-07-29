/**
 * cinatra#2202 — the INTERNAL (in-process) dispatch branch of
 * `sendAgentBuilderMessage` must establish an ActorContext before the executor
 * runs.
 *
 * `InProcessAgentExecutor.execute()` reads the ActorContext ALS frame for the
 * run's `orgId`, its `runBy` attribution and its parent OBO ceiling chain. The
 * EXTERNAL surface establishes that frame at `src/app/api/a2a/route.ts`
 * (`withActorContext(resolvedActorContext, () => mount.handle(...))`); the
 * internal branch established nothing, so every downstream authority check and
 * audit attribution saw no principal at all.
 *
 * What this suite pins:
 *   1. the in-process dispatch runs INSIDE a frame carrying the session's
 *      verified principal (authority checks + audit attribution see it);
 *   2. the executor's injected `createRunWithAuthority` carries a real
 *      run.execute authority for that same principal;
 *   3. FAIL-CLOSED regression pin — the branch REFUSES and never reaches the
 *      executor when the actor is missing, is a different principal than the
 *      dispatching session, is not a HumanUser, carries a different (or no)
 *      organization, or has no run-creation authority. In every case: no client
 *      is built, no message is sent, no run is created. A missing actor fails
 *      LOUD, it never continues silently (the recorded roleless /
 *      silent-authz-drop class);
 *   4. the EXTERNAL branch is unchanged — it neither resolves nor requires the
 *      session ActorContext.
 *
 * The ALS carrier itself (`@cinatra-ai/llm/actor-context`) is deliberately NOT
 * mocked: the mocked A2A client reads the REAL AsyncLocalStorage at dispatch
 * time, so removing the `withActorContext(...)` wrap fails these tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const sess = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  session: { activeOrganizationId: "test-org" } as
    | { activeOrganizationId: string | null }
    | null,
}));

const actorState = vi.hoisted(() => ({
  /** What the canonical session-lineage resolver returns. `null` models
   *  "no actor context resolvable" — the fail-closed case. */
  sessionActor: {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "test-org",
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    projectGrants: [],
    projectIds: [],
  } as Record<string, unknown> | null,
  /** What the REAL membership resolver answers. `null` = no membership row. */
  orgRole: "member" as string | null,
  resolveCalls: 0,
}));

const storeState = vi.hoisted(() => ({
  template: null as
    | {
        id: string;
        sourceType: "internal" | "external";
        agentUrl: string | null;
        connectorSlug: string | null;
        remoteAgentId: string | null;
      }
    | null,
  savedConn: null as { providerConfigKey: string; connectionId: string } | null,
  createAgentRunCalls: [] as Array<{
    input: Record<string, unknown>;
    authority: OrgWriteAuthority | undefined;
  }>,
  readAgentRunByTaskIdResult: null as { id: string } | null,
}));

const internalState = vi.hoisted(() => ({
  createClientCalls: 0,
  sendMessageCalls: 0,
  /** The ActorContext observed from the REAL ALS carrier at dispatch time. */
  actorAtCreateClient: undefined as unknown,
  actorAtSendMessage: undefined as unknown,
  /** The host-injected creation contract, captured so the test can drive it
   *  exactly like the executor would. */
  createRunWithAuthority: null as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | null,
}));

const extState = vi.hoisted(() => ({
  lastOptions: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => {
    if (!sess.user) throw new Error("unauthorized");
    return { user: sess.user, session: sess.session };
  },
  // The canonical session-lineage ActorContext resolver the internal branch
  // consumes (aliased at the import site as `resolveSessionActorContext`).
  getActorContext: async () => {
    actorState.resolveCalls += 1;
    return actorState.sessionActor ?? undefined;
  },
  // Read by the REAL resolveRunCreationAuthority (kept unmocked on purpose so
  // this suite exercises the actual authority resolution, not a stand-in).
  // `null` models a principal with NO membership row — the role-less drop.
  resolveOrgRoleForUser: async () => actorState.orgRole ?? undefined,
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));

vi.mock("@/lib/a2a-server", () => ({
  getA2AMount: async () => ({ handle: async () => ({}) }),
}));

vi.mock("@/lib/nango-system", () => ({
  getNangoConnection: async () => null,
  listSavedNangoConnections: () => [],
}));

vi.mock("../store", async () => ({
  readAgentTemplateByPackageName: async () => storeState.template,
  findSavedConnectionForAgentUrl: () => storeState.savedConn,
  createAgentRun: async (
    input: Record<string, unknown>,
    authority?: OrgWriteAuthority,
  ) => {
    storeState.createAgentRunCalls.push({ input, authority });
    return { id: input.id, orgId: input.orgId ?? null };
  },
  readAgentRunByTaskId: async () => storeState.readAgentRunByTaskIdResult,
  readAgentRunById: async () => null,
  readAgentRunMessages: async () => [],
  readAgentTemplateById: async () => null,
  type: undefined,
}));

vi.mock("@cinatra-ai/a2a", async () => {
  // Read the REAL ALS carrier (never mocked here) so these assertions observe
  // exactly what InProcessAgentExecutor.execute() would observe.
  const readAls = async () => {
    const mod = await import("@cinatra-ai/llm/actor-context");
    return mod.getActorContext();
  };
  return {
    createInProcessA2AClient: async (opts: Record<string, unknown>) => {
      internalState.createClientCalls += 1;
      internalState.actorAtCreateClient = await readAls();
      internalState.createRunWithAuthority = opts.createRunWithAuthority as
        | ((input: Record<string, unknown>) => Promise<unknown>)
        | null;
      return {
        sendMessage: async () => {
          internalState.sendMessageCalls += 1;
          internalState.actorAtSendMessage = await readAls();
          return { id: "int-task-1" };
        },
      };
    },
    createExternalA2AClient: async (opts: Record<string, unknown>) => {
      extState.lastOptions = opts;
      return {
        streamTask: async function* () {
          yield {
            kind: "status-update",
            id: "ext-task-1",
            status: { state: "completed" },
          };
        },
      };
    },
    startExternalSseProxyFromStream: async () => undefined,
    type: undefined,
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock
// ---------------------------------------------------------------------------

import { sendAgentBuilderMessage } from "../a2a-actions";
import { getActorContext } from "@cinatra-ai/llm/actor-context";

function resetState() {
  sess.user = { id: "user-1" };
  sess.session = { activeOrganizationId: "test-org" };
  actorState.sessionActor = {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "test-org",
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    projectGrants: [],
    projectIds: [],
  };
  actorState.orgRole = "member";
  actorState.resolveCalls = 0;
  storeState.template = null;
  storeState.savedConn = null;
  storeState.createAgentRunCalls = [];
  storeState.readAgentRunByTaskIdResult = { id: "run-local-1" };
  internalState.createClientCalls = 0;
  internalState.sendMessageCalls = 0;
  internalState.actorAtCreateClient = undefined;
  internalState.actorAtSendMessage = undefined;
  internalState.createRunWithAuthority = null;
  extState.lastOptions = null;
}

beforeEach(() => {
  resetState();
});

describe("sendAgentBuilderMessage — internal branch establishes the ActorContext", () => {
  it("dispatches INSIDE an ActorContext frame carrying the session's verified principal", async () => {
    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: { q: "hi" },
    });

    expect(result.ok).toBe(true);
    expect(internalState.sendMessageCalls).toBe(1);

    // The executor-side read (this is the exact accessor
    // InProcessAgentExecutor.execute() calls) sees the principal.
    const actor = internalState.actorAtSendMessage as
      | Record<string, unknown>
      | undefined;
    expect(actor).toBeTruthy();
    expect(actor?.principalType).toBe("HumanUser");
    expect(actor?.principalId).toBe("user-1");
    expect(actor?.organizationId).toBe("test-org");
    expect(actor?.authSource).toBe("ui");
  });

  it("establishes the frame before the client is built, not only around the send", async () => {
    await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });
    const actor = internalState.actorAtCreateClient as
      | Record<string, unknown>
      | undefined;
    expect(actor?.principalId).toBe("user-1");
    expect(actor?.organizationId).toBe("test-org");
  });

  it("does not leak the frame past the dispatch (the ALS frame is scoped)", async () => {
    await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });
    expect(getActorContext()).toBeUndefined();
  });

  it("the executor's injected createRunWithAuthority carries a run.execute authority for that same principal", async () => {
    await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });
    const contract = internalState.createRunWithAuthority;
    expect(typeof contract).toBe("function");

    // Drive the contract exactly like execute() does.
    await contract!({
      id: "run-x",
      templateId: "tpl-1",
      inputParams: {},
      orgId: "test-org",
      runBy: "user-1",
      parentOboCeiling: null,
    });

    expect(storeState.createAgentRunCalls.length).toBe(1);
    const call = storeState.createAgentRunCalls[0];
    // Authority checks see a real principal-derived authority (not undefined,
    // which the guarded write refuses as "missing").
    expect(call.authority).toBeTruthy();
    expect(call.authority?.orgId).toBe("test-org");
    expect(call.authority?.can("run.execute")).toBe(true);
    // Audit attribution records WHO acted.
    expect(call.input.runBy).toBe("user-1");
    expect(call.input.orgId).toBe("test-org");
  });
});

describe("sendAgentBuilderMessage — internal branch fails CLOSED without an actor", () => {
  it("REFUSES and never reaches the executor when no ActorContext can be resolved", async () => {
    actorState.sessionActor = null;

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/actor context/i);
    // The load-bearing half of the pin: nothing executor-side ran.
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    expect(storeState.createAgentRunCalls.length).toBe(0);
  });

  it("REFUSES when the resolved actor's organization disagrees with the session's active org", async () => {
    actorState.sessionActor = {
      ...(actorState.sessionActor as Record<string, unknown>),
      organizationId: "other-org",
    };

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/does not match the dispatching session/i);
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    expect(storeState.createAgentRunCalls.length).toBe(0);
  });

  it("REFUSES when the resolved actor is a DIFFERENT principal than the session", async () => {
    actorState.sessionActor = {
      ...(actorState.sessionActor as Record<string, unknown>),
      principalId: "someone-else",
    };

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    expect(storeState.createAgentRunCalls.length).toBe(0);
  });

  it("REFUSES when the resolved actor is not a HumanUser principal", async () => {
    actorState.sessionActor = {
      ...(actorState.sessionActor as Record<string, unknown>),
      principalType: "System",
    };

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
  });

  it("REFUSES BEFORE dispatch when the principal has no membership (no run-creation authority)", async () => {
    actorState.orgRole = null;

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/authority/i);
    // The loud, accurate refusal replaces the old "run created but bridge
    // missing" that a role-less dispatch used to produce.
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    expect(storeState.createAgentRunCalls.length).toBe(0);
  });

  it("REFUSES when the resolved actor carries no organization at all", async () => {
    actorState.sessionActor = {
      ...(actorState.sessionActor as Record<string, unknown>),
      organizationId: undefined,
    };

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    expect(internalState.createClientCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    expect(storeState.createAgentRunCalls.length).toBe(0);
  });
});

describe("sendAgentBuilderMessage — external branch is UNCHANGED", () => {
  beforeEach(() => {
    storeState.template = {
      id: "tpl-ext-1",
      sourceType: "external",
      agentUrl: "https://ext.test",
      connectorSlug: "ext",
      remoteAgentId: "skill-x",
    };
    storeState.savedConn = {
      providerConfigKey: "cinatra-a2a-server",
      connectionId: "conn-1",
    };
  });

  it("dispatches externally without resolving (or requiring) the session ActorContext", async () => {
    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: { q: "hi" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.taskId).toBe("ext-task-1");
    expect(extState.lastOptions?.agentUrl).toBe("https://ext.test");
    // The new resolution is scoped to the internal branch only.
    expect(actorState.resolveCalls).toBe(0);
    expect(internalState.sendMessageCalls).toBe(0);
    // Still mints its own member session authority for the direct create.
    expect(storeState.createAgentRunCalls.length).toBe(1);
    expect(storeState.createAgentRunCalls[0].input.a2aTaskId).toBe("ext-task-1");
    expect(storeState.createAgentRunCalls[0].authority?.orgId).toBe("test-org");
  });

  it("still dispatches externally even when no session ActorContext is resolvable", async () => {
    actorState.sessionActor = null;
    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: {},
    });
    expect(result.ok).toBe(true);
    expect(actorState.resolveCalls).toBe(0);
  });
});
