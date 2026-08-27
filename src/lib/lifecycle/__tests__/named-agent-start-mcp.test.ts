// THE NAMED-AGENT START, THROUGH ITS FIVE GATES (cinatra#2935, lifecycle-b W5d)
// — acceptance items 1, 2 and 4.
//
//   1. "A named agent is started by the assistant in the chat and inside a
//      third-party application, under the person's own rights, with the run card
//      appearing — fixtures per host."
//   2. "The widget's start is refused for an agent the person may not start."
//   4. "Inside a third-party application nothing is offered that the widget's
//      own credential cannot do."
//
// The REAL handler runs. What is substituted is the world under it — the
// standing lookup and `agent_run` itself — so what these cases prove is the
// ORDER of the gates, WHICH credential the start is made with, and that a
// refusal is the platform's own sentence rather than one this surface invented.
//
// EVERY CASE HERE IS RED ON THE BASE BRANCH for the plainest possible reason:
// the module under test does not exist there. What existed instead was the
// verb-anchored sentence-matcher, which started an agent before the model read
// the message and which no widget policy ever admitted.

import { describe, expect, it, vi } from "vitest";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(),
  invokePrimitive: vi.fn(),
}));

import {
  NAMED_AGENT_START_NO_AGENT_NAMED,
  NAMED_AGENT_START_NO_AUTHORITY,
  NAMED_AGENT_START_PRIMITIVE,
  handleNamedAgentStart,
  readFramePerson,
} from "../named-agent-start-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const AGENT = "@cinatra-ai/contact-discovery-agent";

/** The person's OWN credential, as the bound-turn actor resolves it LIVE — the
 *  team and project axes present, which is exactly what a delegated token
 *  lacks and exactly what the run's execute gate reads. */
const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: {
    actorOrganizationId: PERSON.orgId,
    orgRole: "member",
    platformRole: "member",
    teamIds: ["team_a"],
    projectGrants: [{ projectId: "prj_1", effectiveRole: "write", accessSource: "user" }],
  },
} as unknown as ReviewActorContext;

function ok() {
  return { readFrame: () => ({ ...PERSON, humanPresent: true as const }) };
}
function withActor(resolved: ReviewActorContext | null = OWN_CREDENTIAL) {
  return { resolveActor: vi.fn(async () => resolved) };
}

function text(res: Awaited<ReturnType<typeof handleNamedAgentStart>>) {
  return res.structuredContent as { ok?: boolean; message?: string; runId?: string; status?: string; code?: string };
}

describe("GATE 1 — the acting person comes from the frame, never from an argument", () => {
  it("a widget delegation IS placeable — its verified subject and org are the person", () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      delegatedActor: { delegation: "public_site_widget", userId: PERSON.userId, orgId: PERSON.orgId },
    };
    expect(readFramePerson()).toEqual({ ...PERSON, humanPresent: true });
  });

  it("a first-party chat frame IS placeable", () => {
    frame.store = { userId: PERSON.userId, orgId: PERSON.orgId, delegatedActor: { delegation: "chat" } };
    expect(readFramePerson()).toEqual({ ...PERSON, humanPresent: true });
  });

  it("an agent-run OBO frame is NOT — a headless caller names no person", () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      delegatedActor: { delegation: "agent_run", runId: "run_x" },
    };
    expect(readFramePerson()).toBeNull();
  });

  it("RED ON ROUND 1 — a frame with NO delegation is NOT placeable either", () => {
    // Convergence round 1, finding 2. The predicate used to refuse only a frame
    // whose delegation was explicitly something else, which admitted every frame
    // carrying none at all — a machine or service-account MCP caller with a
    // resolvable user and org — and then stamped it `launchOrigin: "chat"`,
    // telling the coordinator a person was watching when none was. An explicit
    // conversation delegation is now required.
    frame.store = { userId: PERSON.userId, orgId: PERSON.orgId };
    expect(readFramePerson()).toBeNull();
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      delegatedActor: { delegation: "a2a" },
    };
    expect(readFramePerson()).toBeNull();
  });

  it("no frame at all, no org, or no attributable user is NOT placeable", () => {
    frame.store = undefined;
    expect(readFramePerson()).toBeNull();
    frame.store = { userId: PERSON.userId };
    expect(readFramePerson()).toBeNull();
    frame.store = { orgId: PERSON.orgId };
    expect(readFramePerson()).toBeNull();
  });

  it("an unplaceable turn refuses in the ONE fixed sentence and starts nothing", async () => {
    const invoke = vi.fn();
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { readFrame: () => null, invoke },
    );
    expect(text(res)).toEqual({ ok: false, message: NAMED_AGENT_START_NO_AUTHORITY });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("GATE 2 — the person's own credential, resolved live at the call", () => {
  it("no live standing (membership revoked between the send and the call) refuses", async () => {
    const invoke = vi.fn();
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(null), invoke },
    );
    expect(text(res)).toEqual({ ok: false, message: NAMED_AGENT_START_NO_AUTHORITY });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the start is made with the LIVE standing, never with the frame's own hints", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    const resolveActor = vi.fn(async () => OWN_CREDENTIAL);
    await handleNamedAgentStart({ packageName: AGENT }, { ...ok(), resolveActor, invoke });

    expect(resolveActor).toHaveBeenCalledWith({ userId: PERSON.userId, orgId: PERSON.orgId });
    const [actor] = invoke.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    // The axes the run's execute gate actually reads, carried from the LIVE
    // resolution: team membership and project grants. A delegated token has
    // neither, which is why reading them off the frame would silently deny a
    // person their own agent.
    expect(actor).toMatchObject({
      actorType: "human",
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      orgRole: "member",
      platformRole: "member",
      teamIds: ["team_a"],
      launchOrigin: "chat",
    });
    expect((actor as { projectGrants?: unknown[] }).projectGrants).toEqual([
      { projectId: "prj_1", effectiveRole: "write", accessSource: "user" },
    ]);
  });
});

describe("GATE 3 — a named agent, and only that", () => {
  it.each([
    ["a bare slug", "contact-discovery-agent"],
    ["a template uuid", "0f6a1b2c-3d4e-5f60-8712-9a0b1c2d3e4f"],
    ["a path", "@cinatra-ai/x/../../etc"],
    ["empty-ish", "@/"],
  ])("refuses %s without touching the store", async (_label, packageName) => {
    const invoke = vi.fn();
    const resolveActor = vi.fn();
    const res = await handleNamedAgentStart(
      { packageName },
      { ...ok(), resolveActor, invoke },
    );
    expect(text(res)).toEqual({ ok: false, message: NAMED_AGENT_START_NO_AGENT_NAMED });
    expect(resolveActor).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a templateId argument is not part of the schema at all", async () => {
    const invoke = vi.fn();
    const res = await handleNamedAgentStart(
      { packageName: AGENT, templateId: "0f6a1b2c-3d4e-5f60-8712-9a0b1c2d3e4f" },
      { ...ok(), ...withActor(), invoke },
    );
    // `.strict()` rejects the unknown key, so the call never reaches the store.
    expect(text(res)).toEqual({ ok: false, message: NAMED_AGENT_START_NO_AGENT_NAMED });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the canonical scoped form is accepted, case-folded to the canonical name", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    await handleNamedAgentStart(
      { packageName: "@Cinatra-AI/Contact-Discovery-Agent" },
      { ...ok(), ...withActor(), invoke },
    );
    const [, args] = invoke.mock.calls[0] as unknown as [unknown, { packageName: string }];
    expect(args.packageName).toBe(AGENT);
  });

  it("an operator-vendor scope is accepted — the SHAPE is what is pinned", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    const res = await handleNamedAgentStart(
      { packageName: "@acme-instance/contact-discovery-agent" },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res).ok).toBe(true);
  });
});

describe("GATES 4 AND 5 — the agent the person may start, on the one road", () => {
  it("ACCEPTANCE 2 — an agent the person may not start is REFUSED, in the platform's own words", async () => {
    // `agent_run`'s execute gate answers its refusal as data. This is the exact
    // string the run page gives, and it is relayed word for word: the plan's
    // "A refusal is the platform's own, relayed. … It never decides in place of
    // a refusal and never re-writes one."
    const PLATFORM_REFUSAL = "Template not found: @cinatra-ai/contact-discovery-agent";
    const invoke = vi.fn(async () => ({ error: PLATFORM_REFUSAL }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res)).toEqual({ ok: false, message: PLATFORM_REFUSAL });
    // NEVER A SILENT NO-OP: the refusal is a sentence the assistant relays.
    expect(text(res).message).not.toBe("");
  });

  it("a structured rejection keeps its code beside the platform's sentence", async () => {
    const invoke = vi.fn(async () => ({
      error: "Agent is not installed: @cinatra-ai/contact-discovery-agent",
      code: "WAYFLOW_AGENT_NOT_REGISTERED",
    }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res)).toMatchObject({
      ok: false,
      code: "WAYFLOW_AGENT_NOT_REGISTERED",
      message: "Agent is not installed: @cinatra-ai/contact-discovery-agent",
    });
  });

  it("a THROW is not a sentence — nothing started, and no reason invented", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("ECONNREFUSED 5432");
    });
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res)).toEqual({ ok: false, message: NAMED_AGENT_START_NO_AUTHORITY });
    expect(JSON.stringify(res)).not.toContain("ECONNREFUSED");
  });

  it("the start is `agent_run` — one road, not a second creation site", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    await handleNamedAgentStart(
      { packageName: AGENT, inputParams: '{"topic":"acme"}' },
      { ...ok(), ...withActor(), invoke },
    );
    const [, args] = invoke.mock.calls[0] as unknown as [unknown, { packageName: string; inputParams: string }];
    expect(args).toEqual({ packageName: AGENT, inputParams: '{"topic":"acme"}' });
  });

  it("absent inputs degrade to `{}` — the run's own setup screen asks for the rest", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    await handleNamedAgentStart({ packageName: AGENT }, { ...ok(), ...withActor(), invoke });
    const [, args] = invoke.mock.calls[0] as unknown as [unknown, { inputParams: string }];
    expect(args.inputParams).toBe("{}");
  });

  it("it starts AT MOST ONE run per call", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_1", status: "queued" }));
    await handleNamedAgentStart({ packageName: AGENT }, { ...ok(), ...withActor(), invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("the answer the conversation draws the card from", () => {
  it("ACCEPTANCE 1 — the run's id and status come back, and the card is drawn from them", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_card_1", status: "queued" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res)).toEqual({ ok: true, runId: "run_card_1", status: "queued" });
    // The card carries its own link to the run page; a path composed from a run
    // id does not exist and 404s, so no URL is on this wire (cinatra#2729).
    expect(JSON.stringify(res)).not.toMatch(/\/agents\/runs\//);
  });

  it("a PARKED run reaches the transcript parked — the status is copied, never derived", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_held", status: "pending_input" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res)).toEqual({ ok: true, runId: "run_held", status: "pending_input" });
  });

  it("an ABSENT status defaults to queued, and never to a held one", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_nostatus" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(text(res).status).toBe("queued");
  });
});

describe("the name is the contract", () => {
  it("the constant and the registered literal are one string", () => {
    expect(NAMED_AGENT_START_PRIMITIVE).toBe("agent_named_start");
  });

  it("it carries a verb token both delegated backstops deny — so it must be disclosed", () => {
    expect(NAMED_AGENT_START_PRIMITIVE.split("_")).toContain("start");
  });
});
