/**
 * THE REFUSAL'S CAUSE, ON THE SERVER ONLY (cinatra#3052).
 *
 * The producer answers ONE fixed sentence to every denial, and that rule is not
 * relaxed here: every assertion below still reads the same string on the wire.
 * What is new is that the SERVER now records WHICH stage said no — which is the
 * thing whose absence made this defect unreadable. A person who stated a
 * schedule inside a third-party application was answered "Not available to you."
 * and the server kept no record at all, so "the grant is lost somewhere" and
 * "the agent argument cannot be named here" were indistinguishable without
 * re-deriving the chain by hand.
 *
 * TWO PROPERTIES ARE PINNED TOGETHER, deliberately, because either alone would
 * be the wrong shape: the sentence stays generic AND the stage is recorded. A
 * test that only checked the log would not notice the day the handler starts
 * telling the model what went wrong.
 *
 * The record carries NO identifiers — not the person, not the org, not the
 * agent, not the schedule — and that is asserted too.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LIFECYCLE_REFUSAL_RESULT } from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX } from "../schedule-proposal-mcp";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-schedule-proposal-reasons";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const IDENTIFIERS = [
  "u-widget",
  "org-1",
  "@cinatra-ai/some-agent",
  "tpl-1",
  "Europe/Berlin",
];

/**
 * Drive the REAL handler on a substituted frame and a substituted propose leaf,
 * and return both halves of the contract: what the reader is told, and what the
 * server recorded.
 */
async function driveHandler(input: {
  store: unknown;
  proposeResult?: unknown;
  proposeThrows?: boolean;
  toolInput: Record<string, unknown>;
}): Promise<{ sentence: string; logged: string[] }> {
  vi.resetModules();
  vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
    proposeTriggerSchedule: vi.fn(async () => {
      if (input.proposeThrows) throw new Error("the store is unreachable");
      return input.proposeResult ?? { ok: true, token: "proposal-token-1" };
    }),
  }));
  vi.doMock("@cinatra-ai/mcp-server", () => ({
    mcpRequestContextStorage: { getStore: () => input.store },
  }));
  const logged: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  });
  const mod = await import("../schedule-proposal-mcp");
  const result = await mod.handleScheduleProposalRender(input.toolInput);
  warn.mockRestore();
  vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
  vi.doUnmock("@cinatra-ai/mcp-server");
  return {
    sentence: result.content[0].text as string,
    logged: logged.filter((line) => line.startsWith(SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX)),
  };
}

/** A granted widget frame — the one this defect was found on. */
const GRANTED_WIDGET = {
  userId: "u-widget",
  orgId: "org-1",
  delegatedActor: {
    delegation: "public_site_widget",
    userId: "u-widget",
    orgId: "org-1",
    instanceId: "inst-1",
    kind: "wordpress",
    jti: "j1",
    platformRole: "member",
    lifecycleRead: true,
  },
};

const GOOD_INPUT = {
  packageName: "@cinatra-ai/some-agent",
  schedule: { kind: "immediate" as const },
};

describe("every refusal records its stage, and still says only the one sentence", () => {
  it("no request context at all", async () => {
    const { sentence, logged } = await driveHandler({
      store: undefined,
      toolInput: GOOD_INPUT,
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=no_request_context`]);
  });

  it("an agent-to-agent frame — there is no person to put a question to", async () => {
    const { sentence, logged } = await driveHandler({
      store: { ...GRANTED_WIDGET, a2aActorContext: { agentId: "a1" } },
      toolInput: GOOD_INPUT,
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=a2a_frame`]);
  });

  it("a widget session whose sign-in predates the lifecycle grant", async () => {
    const { sentence, logged } = await driveHandler({
      store: {
        ...GRANTED_WIDGET,
        delegatedActor: { ...GRANTED_WIDGET.delegatedActor, lifecycleRead: false },
      },
      toolInput: GOOD_INPUT,
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=no_lifecycle_grant`]);
  });

  it("a frame with the grant but no attributable person", async () => {
    const { sentence, logged } = await driveHandler({
      store: { ...GRANTED_WIDGET, userId: null, orgId: null },
      toolInput: GOOD_INPUT,
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=no_identity`]);
  });

  it("an input the form could not have produced", async () => {
    const { sentence, logged } = await driveHandler({
      store: GRANTED_WIDGET,
      toolInput: { packageName: "@cinatra-ai/some-agent", schedule: { kind: "whenever" } },
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=invalid_input`]);
  });

  it("the proposal service's OWN reason is the stage recorded — it is not re-invented", async () => {
    for (const reason of ["no_agent_named", "two_agents_named", "unknown_agent", "cross_org", "past_time", "mint_failed"]) {
      const { sentence, logged } = await driveHandler({
        store: GRANTED_WIDGET,
        proposeResult: { ok: false, reason },
        toolInput: GOOD_INPUT,
      });
      expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
      expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=${reason}`]);
    }
  });

  it("a store or transport failure is recorded as a throw, not as an absence", async () => {
    const { sentence, logged } = await driveHandler({
      store: GRANTED_WIDGET,
      proposeThrows: true,
      toolInput: GOOD_INPUT,
    });
    expect(sentence).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=threw`]);
  });

  it("the record names no person, no organization, no agent and no schedule", async () => {
    const { logged } = await driveHandler({
      store: {
        ...GRANTED_WIDGET,
        delegatedActor: { ...GRANTED_WIDGET.delegatedActor, lifecycleRead: false },
      },
      toolInput: {
        packageName: "@cinatra-ai/some-agent",
        schedule: { kind: "scheduled", runAt: "2099-01-01T09:00", timezone: "Europe/Berlin" },
      },
    });
    expect(logged).toHaveLength(1);
    for (const identifier of IDENTIFIERS) {
      expect(logged[0]).not.toContain(identifier);
    }
  });

  it("a granted frame that CAN name its agent writes no refusal record at all", async () => {
    const { sentence, logged } = await driveHandler({
      store: GRANTED_WIDGET,
      toolInput: GOOD_INPUT,
    });
    expect(sentence).not.toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(logged).toEqual([]);
  });
});

describe("the agent argument the widget can actually name", () => {
  it("forwards a package name to the proposal service, untouched", async () => {
    vi.resetModules();
    const propose = vi.fn(async (_input: Record<string, unknown>) => ({
      ok: true,
      token: "proposal-token-1",
    }));
    vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
      proposeTriggerSchedule: propose,
    }));
    vi.doMock("@cinatra-ai/mcp-server", () => ({
      mcpRequestContextStorage: { getStore: () => GRANTED_WIDGET },
    }));
    const mod = await import("../schedule-proposal-mcp");
    await mod.handleScheduleProposalRender({
      packageName: "@cinatra-ai/some-agent",
      schedule: { kind: "immediate" },
    });
    expect(propose).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/some-agent",
      userId: "u-widget",
      orgId: "org-1",
      schedule: { kind: "immediate" },
    });
    // AND NO EMPTY `templateId` RIDES ALONG. The propose leaf reads the pair as
    // an exclusive choice, so a forwarded `templateId: undefined` would be one
    // rename away from being read as "both named".
    expect(Object.keys(propose.mock.calls[0]?.[0] ?? {})).not.toContain("templateId");
    vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
    vi.doUnmock("@cinatra-ai/mcp-server");
    vi.resetModules();
  });

  it("forwards a template id exactly as it did before — the chat host is unchanged", async () => {
    vi.resetModules();
    const propose = vi.fn(async (_input: Record<string, unknown>) => ({
      ok: true,
      token: "proposal-token-1",
    }));
    vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
      proposeTriggerSchedule: propose,
    }));
    vi.doMock("@cinatra-ai/mcp-server", () => ({
      mcpRequestContextStorage: { getStore: () => GRANTED_WIDGET },
    }));
    const mod = await import("../schedule-proposal-mcp");
    await mod.handleScheduleProposalRender({
      templateId: "tpl-1",
      schedule: { kind: "immediate" },
    });
    expect(propose).toHaveBeenCalledWith({
      templateId: "tpl-1",
      userId: "u-widget",
      orgId: "org-1",
      schedule: { kind: "immediate" },
    });
    expect(Object.keys(propose.mock.calls[0]?.[0] ?? {})).not.toContain("packageName");
    vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
    vi.doUnmock("@cinatra-ai/mcp-server");
    vi.resetModules();
  });
});
