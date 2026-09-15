// ---------------------------------------------------------------------------
// WHAT THE WIDGET'S DOOR SAYS BACK (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// `agent_named_start` is a narrower DOOR onto `agent_run`, never a second road,
// so everything a person reads after a start through it is the platform's own —
// relayed, never composed here. This file pins that relay in both directions:
//
//  · a START that succeeded: the platform's report travels through untouched,
//    beside the run id and status the card is drawn from. Without it the
//    assistant has no sentence to say and reads the envelope out instead, which
//    is exactly what a reader inside a third-party application was shown.
//
//  · a START the platform refused: its sentence travels through untouched and
//    the enforcement diagnostic — the stage, the template's id, the machine
//    reason, the scope level — is nowhere in what the person reads.
//
// The sibling suite owns the five gates; this one owns the words.
// ---------------------------------------------------------------------------

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
  RUN_START_QUEUED_CLAUSE,
  RUN_START_REPLY_RULE,
  RUN_START_STARTED_CLAUSE,
  describeStartedRun,
} from "@cinatra-ai/agents/run-status";

import {
  NAMED_AGENT_START_TOOL_DESCRIPTION,
  handleNamedAgentStart,
} from "../named-agent-start-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const AGENT = "@cinatra-ai/contact-discovery-agent";

const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: {
    actorOrganizationId: PERSON.orgId,
    orgRole: "member",
    platformRole: "member",
    teamIds: ["team_a"],
    projectGrants: [],
  },
} as unknown as ReviewActorContext;

function ok() {
  return { readFrame: () => ({ ...PERSON, humanPresent: true as const }) };
}
function withActor() {
  return { resolveActor: vi.fn(async () => OWN_CREDENTIAL) };
}
function answer(res: Awaited<ReturnType<typeof handleNamedAgentStart>>) {
  return res.structuredContent as {
    ok?: boolean;
    message?: string;
    runId?: string;
    status?: string;
  };
}

/** The platform's report, as `agent_run` mints it for this start — taken from
 *  the platform itself, so the door is proven to relay whatever the platform
 *  says rather than a wording copied here and left to drift (cinatra#3147). */
const PLATFORM_REPORT = describeStartedRun({
  packageName: AGENT,
  runId: "run_card_1",
  status: "queued",
});

/** The platform's sentence for a start the agent's scope refuses. */
const PLATFORM_REFUSAL = "You can't start this agent. Nothing was started.";

/** The enforcement diagnostic — the thing a person must never be handed. */
const DIAGNOSTIC =
  "Run failed: agent-template-scope: create/requesting-actor refused for template " +
  "80d761cd-a8eb-4ad0-81e4-288244b79727 — not_project_member (scope: project)";

describe("the platform's report, relayed", () => {
  it("travels through the door untouched, beside the id and status the card needs", async () => {
    const invoke = vi.fn(async () => ({
      runId: "run_card_1",
      status: "queued",
      message: PLATFORM_REPORT,
    }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );

    expect(answer(res)).toEqual({
      ok: true,
      runId: "run_card_1",
      status: "queued",
      message: PLATFORM_REPORT,
    });
    // Byte for byte: this surface adds nothing to the report and rewrites none
    // of it, exactly as it already does for a refusal.
    expect(answer(res).message).toBe(PLATFORM_REPORT);
    // And what travels is TRUE of the status beside it (cinatra#3147): the run
    // is queued, so the line says that and never that the run started.
    expect(PLATFORM_REPORT).toBe(
      "Dispatched `@cinatra-ai/contact-discovery-agent` " +
        "(runId: `run_card_1`, status: `queued`). " +
        RUN_START_QUEUED_CLAUSE,
    );
    expect(answer(res).message).not.toContain(RUN_START_STARTED_CLAUSE);
  });

  it("the text half of the answer carries the same report, so a reader of either sees one wording", async () => {
    const invoke = vi.fn(async () => ({
      runId: "run_card_1",
      status: "queued",
      message: PLATFORM_REPORT,
    }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(res.content[0]?.text).toContain(PLATFORM_REPORT);
  });

  it("INVENTS NOTHING: an answer with no report gets no report put on it", async () => {
    const invoke = vi.fn(async () => ({ runId: "run_card_1", status: "queued" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(answer(res)).toEqual({ ok: true, runId: "run_card_1", status: "queued" });
    expect(answer(res).message).toBeUndefined();
  });
});

describe("the platform's refusal, relayed", () => {
  it("is said back word for word", async () => {
    const invoke = vi.fn(async () => ({ error: PLATFORM_REFUSAL, code: "AGENT_TEMPLATE_SCOPE_DENIED" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    expect(answer(res).ok).toBe(false);
    expect(answer(res).message).toBe(PLATFORM_REFUSAL);
  });

  it("carries no diagnostic, because the platform hands it none", async () => {
    const invoke = vi.fn(async () => ({ error: PLATFORM_REFUSAL, code: "AGENT_TEMPLATE_SCOPE_DENIED" }));
    const res = await handleNamedAgentStart(
      { packageName: AGENT },
      { ...ok(), ...withActor(), invoke },
    );
    const whole = JSON.stringify(res);
    expect(whole).not.toContain("agent-template-scope");
    expect(whole).not.toContain("not_project_member");
    expect(whole).not.toContain("80d761cd-a8eb-4ad0-81e4-288244b79727");
    expect(whole).not.toContain(DIAGNOSTIC);
  });
});

// ---------------------------------------------------------------------------
// ONE REPLY RULE, THE SAME BYTES ON BOTH DOORS (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// The widget's door landed the platform's sentence every time and the chat
// host's did not, and the difference was in the words each door gives the model:
// this one carried the reply rule ALONE, while `agent_run` carried it beside an
// order to poll the run afterwards — and in the turn the captures caught, the
// poll is what the model did. The rule is now ONE exported string and both doors
// carry it, so the REPLY RULE cannot differ between the hosts. That is all these
// cases claim: what each door says around the rule is still its own.
// ---------------------------------------------------------------------------

describe("the words the widget's door gives the model", () => {
  it("are the platform's one reply rule, byte for byte", () => {
    expect(NAMED_AGENT_START_TOOL_DESCRIPTION).toContain(RUN_START_REPLY_RULE);
  });

  it("END on that rule — nothing is said after it", () => {
    expect(NAMED_AGENT_START_TOOL_DESCRIPTION.endsWith(RUN_START_REPLY_RULE)).toBe(true);
  });

  it("order no poll, and never name the read primitive as a follow-up", () => {
    expect(NAMED_AGENT_START_TOOL_DESCRIPTION).not.toMatch(/MUST be followed by/i);
    expect(NAMED_AGENT_START_TOOL_DESCRIPTION).not.toMatch(/\bpoll(ing)?\b[^.]*\buntil\b/i);
    expect(NAMED_AGENT_START_TOOL_DESCRIPTION).not.toContain("agent_run_get");
  });
});
