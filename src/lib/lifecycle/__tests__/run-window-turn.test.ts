// THE ONE ROAD for a prompt window outside the chat (cinatra#2933, W5b).
//
// AC1 (answered by the assistant, stored per turn), AC2 (a non-administrator
// run owner types and IS answered), AC3 (a person without respond access never
// sees the box), AC4 (the tool-less message when the model cannot act).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type EnforceRunAccess = (
  run: unknown,
  actor: unknown,
  op: string,
  hints: Record<string, unknown>,
) => Promise<void>;
const noop: EnforceRunAccess = async () => {};
const enforceRunAccess = vi.fn<EnforceRunAccess>(noop);
// THE RUN ROW the frame is built from (cinatra#3016). A run has a status and a
// name; a window that does not carry them cannot answer "what is this step
// waiting for?" without the person naming the run.
const RUN_ROW = {
  id: "run-1",
  templateId: "t-1",
  orgId: "org-1",
  status: "pending_approval",
  title: "Blog draft",
  inputParams: {},
};
const readAgentRunById = vi.fn(async () => RUN_ROW as Record<string, unknown>);
// The two GATE READS the frame makes, per run id, so a cross-run negative can
// assert what was read as well as what was said.
const hitlReads: string[] = [];
const triggerReads: string[] = [];
const hitlByRun: Record<string, unknown> = {
  "run-1": {
    xRenderer: "campaign-setup",
    childRunId: null,
    reviewTaskId: "task-9",
    inputSchema: { properties: { callToAction: {}, senderName: {} } },
    currentValues: { callToAction: "Book a demo", senderName: "Rita" },
  },
  "run-2": {
    xRenderer: "other-renderer",
    childRunId: null,
    reviewTaskId: "task-other",
    inputSchema: { properties: { secretField: {} } },
    currentValues: { secretField: "the other run's business" },
  },
};
const triggerByRun: Record<string, unknown> = {};
const appended: Array<{ role: string; text: string; surface: string; replyToSequence: number | null }> = [];
const stored: Array<{ role: "user" | "assistant"; text: string; surface: string; id: string; runId: string; sequence: number; replyToSequence: number | null; createdAt: Date }> = [];
let session: unknown = { user: { id: "u-owner", role: "user" }, session: { activeOrganizationId: "org-1" } };
let turnBehaviour: (send: (e: string, d: unknown) => void) => void = (send) => {
  send("text", { content: "Here is what I found." });
};
let lastTurnArgs: Record<string, unknown> | null = null;

vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  enforceRunAccess: (...a: Parameters<EnforceRunAccess>) => enforceRunAccess(...a),
  resolveEffectivePolicy: () => ({ runDataVisibility: "owner" }),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...(a as [])),
  readAgentTemplateById: async () => ({ id: "t-1", packageName: "@x/y" }),
  readRunCoOwners: async () => [],
}));
vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  appendRunWindowMessage: async (input: {
    runId: string;
    role: "user" | "assistant";
    surface: string;
    text: string;
    replyToSequence?: number | null;
  }) => {
    appended.push({
      role: input.role,
      text: input.text,
      surface: input.surface,
      replyToSequence: input.replyToSequence ?? null,
    });
    const row = {
      id: `m${stored.length + 1}`,
      runId: input.runId,
      sequence: stored.length + 1,
      role: input.role,
      surface: input.surface as never,
      text: input.text,
      replyToSequence: input.replyToSequence ?? null,
      createdAt: new Date(),
    };
    stored.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...stored],
}));
// THE FRAME BUILDER, real by default. One switch makes it THROW, so the road's
// own fail-soft is exercised rather than asserted: with it on, the turn must
// still answer and must simply carry no frame.
let frameThrows = false;
vi.mock("../run-window-frame", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-window-frame")>();
  return {
    ...actual,
    buildRunWindowFrame: async (...args: Parameters<typeof actual.buildRunWindowFrame>) => {
      if (frameThrows) throw new Error("the frame could not be assembled");
      return actual.buildRunWindowFrame(...args);
    },
  };
});
vi.mock("@cinatra-ai/agents/hitl-context", () => ({
  deriveRunHitlContext: async (run: { id: string }) => {
    hitlReads.push(run.id);
    return hitlByRun[run.id] ?? null;
  },
}));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({
  readRunTriggerByRunId: async (runId: string) => {
    triggerReads.push(runId);
    return triggerByRun[runId] ?? null;
  },
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: (s: { user: { id: string } }) => ({ actorType: "human", source: "ui", userId: s.user.id, organizationId: "org-1", roles: [] }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => session,
  resolveUserContextForUserId: async () => ({
    actorContext: { actorType: "human", userId: "u-owner" },
    platformRole: "member",
    sessionOrgId: "org-1",
  }),
}));
// The LIVE STANDING leaf (W5a). A run owner who is NOT a platform administrator
// is exactly this: an ordinary member of the org, holding the run by ownership.
vi.mock("../bound-turn-actor", () => ({
  resolveBoundTurnActor: async ({ userId, orgId }: { userId?: string | null; orgId?: string | null }) =>
    userId && orgId
      ? {
          actor: { actorType: "human", source: "agent", userId, orgId },
          orgId,
          roleHints: {
            platformRole: "member",
            orgRole: "member",
            actorOrganizationId: orgId,
            teamIds: ["team-7"],
            projectGrants: [{ projectId: "p-1", role: "editor" }],
          },
        }
      : null,
}));
vi.mock("@/lib/assistant-runtime/cinatra-assistant-config", () => ({
  buildCinatraAssistantRuntimeConfig: () => ({ skillIdNamespace: "@cinatra-ai/chat" }),
}));
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: async (_cfg: unknown, args: Record<string, unknown>) => {
    lastTurnArgs = args;
    turnBehaviour(args.send as (e: string, d: unknown) => void);
  },
}));

const mod = await import("../run-window-turn");

beforeEach(() => {
  enforceRunAccess.mockClear().mockImplementation(noop);
  readAgentRunById.mockClear().mockImplementation(async () => RUN_ROW as Record<string, unknown>);
  hitlReads.length = 0;
  triggerReads.length = 0;
  frameThrows = false;
  for (const key of Object.keys(triggerByRun)) delete triggerByRun[key];
  appended.length = 0;
  stored.length = 0;
  lastTurnArgs = null;
  session = { user: { id: "u-owner", role: "user" }, session: { activeOrganizationId: "org-1" } };
  turnBehaviour = (send) => send("text", { content: "Here is what I found." });
});

describe("the window's turn is answered by the conversation's assistant", () => {
  it("stores the person's message and the assistant's answer with the run, per turn", async () => {
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "run-page",
      prompt: "what is waiting here?",
    });
    // ANSWERED BY THE ASSISTANT: the one road, not a second model.
    expect(lastTurnArgs).not.toBeNull();
    expect((lastTurnArgs as { messages: Array<{ content: string }> }).messages.at(-1)?.content)
      .toBe("what is waiting here?");
    // STORED PER TURN, and the person's words are committed BEFORE the model
    // runs, so a turn that dies in the model still leaves what was typed.
    expect(appended.map((a) => [a.role, a.text])).toEqual([
      ["user", "what is waiting here?"],
      ["assistant", "Here is what I found."],
    ]);
    expect(out.entries.map((e) => e.text)).toEqual([
      "what is waiting here?",
      "Here is what I found.",
    ]);
  });

  it("records WHICH message the answer answered, rather than leaving it to adjacency", async () => {
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "first" });
    const answer = appended.at(-1);
    expect(answer?.role).toBe("assistant");
    // The person's row is sequence 1; the answer says so, so two turns landing
    // interleaved can never present one answer as the other's.
    expect(answer?.replyToSequence).toBe(1);
    expect(appended[0]?.replyToSequence).toBeNull();
  });

  it("hands the model everything said BEFORE the person's own message, and no more", async () => {
    // A turn that raced in and landed while this one was being prepared.
    stored.push({
      id: "m0",
      runId: "run-1",
      sequence: 1,
      role: "user",
      surface: "run-page" as never,
      text: "the other person's message",
      replyToSequence: null,
      createdAt: new Date(),
    });
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "mine" });
    const msgs = (lastTurnArgs as { messages: Array<{ content: string }> }).messages;
    // The prefix is read AFTER this turn's own row lands and cut at it, so it is
    // the same on every read — never "whatever the table held a moment ago".
    expect(msgs.map((m) => m.content)).toEqual([
      "the other person's message",
      "mine",
    ]);
  });

  it("carries the bound card as W5a's CLAIM and mints nothing of its own", async () => {
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "review",
      prompt: "tighten the opening paragraph",
      boundCard: { candidateRefs: ["ref-a"], focusedRef: "ref-a" },
    });
    expect((lastTurnArgs as { boundCard?: unknown }).boundCard).toEqual({
      candidateRefs: ["ref-a"],
      focusedRef: "ref-a",
    });
    // No grant, no resolved reference, no decision is produced HERE: the claim
    // is handed to the runtime, which re-checks it under the person's access.
    expect(JSON.stringify(lastTurnArgs)).not.toContain("grant");
  });

  it("bounds the browser's claim instead of forwarding whatever arrived", async () => {
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "review",
      prompt: "x",
      boundCard: {
        candidateRefs: Array.from({ length: 40 }, (_, i) => `ref-${i}`),
        focusedRef: "ref-not-offered",
      },
    });
    const claim = (lastTurnArgs as { boundCard?: { candidateRefs: string[]; focusedRef: string | null } })
      .boundCard;
    expect(claim?.candidateRefs).toHaveLength(8);
    // A focus the page did not also offer is not a binding it can have seen.
    expect(claim?.focusedRef).toBeNull();
  });

  it("drops a claim with nothing usable in it rather than passing an empty one", async () => {
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "review",
      prompt: "x",
      boundCard: { candidateRefs: ["", "x".repeat(9000)], focusedRef: null },
    });
    expect((lastTurnArgs as { boundCard?: unknown }).boundCard).toBeUndefined();
  });

  it("gives the run's history to the turn so a follow-up resolves", async () => {
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "first" });
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "and the other one" });
    const msgs = (lastTurnArgs as { messages: Array<{ role: string; content: string }> }).messages;
    expect(msgs.map((m) => m.content)).toEqual([
      "first",
      "Here is what I found.",
      "and the other one",
    ]);
  });
});

describe("every window takes the run's access", () => {
  it("answers a run owner who is NOT a platform administrator", async () => {
    session = { user: { id: "u-owner", role: "user" }, session: { activeOrganizationId: "org-1" } };
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "schedule",
      prompt: "every monday at 9",
    });
    expect(out.entries.at(-1)?.text).toBe("Here is what I found.");
    // The right asked for is the RUN's respond right — never the platform tier.
    expect(enforceRunAccess.mock.calls[0]?.[2]).toBe("respondToHitl");
    const hints = enforceRunAccess.mock.calls[0]?.[3] ?? {};
    expect(hints.platformRole).toBe("member");
    expect(await mod.canRespondInRunWindow("run-1")).toBe(true);
  });

  it("asks with the person's LIVE standing, teams and project grants included", async () => {
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "hi" });
    const hints = (enforceRunAccess.mock.calls[0]?.[3] ?? {}) as {
      teamIds?: string[];
      projectGrants?: unknown[];
    };
    // Hand-built hints would deny a person who holds the run through a team or
    // a project grant; the window asks the same leaf the lent action asks.
    expect(hints.teamIds).toEqual(["team-7"]);
    expect(hints.projectGrants).toHaveLength(1);
  });

  it("refuses, and answers NO to the box, for a person without respond access", async () => {
    const deny: EnforceRunAccess = async () => {
      throw new Error("denied");
    };
    enforceRunAccess.mockImplementation(deny);
    await expect(
      mod.runWindowTurn({ runId: "run-1", surface: "armed-trigger", prompt: "hello" }),
    ).rejects.toBeInstanceOf(mod.RunWindowAccessDenied);
    // Nothing was written and nothing was asked of a model.
    expect(appended).toHaveLength(0);
    expect(lastTurnArgs).toBeNull();
    // …and the window is told not to draw itself at all.
    expect(await mod.canRespondInRunWindow("run-1")).toBe(false);
  });

  it("refuses a caller with no org standing at all", async () => {
    session = { user: { id: "u-owner", role: "user" }, session: { activeOrganizationId: null } };
    await expect(
      mod.runWindowTurn({ runId: "run-1", surface: "review", prompt: "hi" }),
    ).rejects.toBeInstanceOf(mod.RunWindowAccessDenied);
  });

  it("refuses a caller with no session and a run that is not there", async () => {
    session = null;
    await expect(
      mod.runWindowTurn({ runId: "run-1", surface: "review", prompt: "hi" }),
    ).rejects.toBeInstanceOf(mod.RunWindowAccessDenied);
    session = { user: { id: "u-owner", role: "user" }, session: { activeOrganizationId: "org-1" } };
    readAgentRunById.mockImplementation(async () => null as never);
    expect(await mod.canRespondInRunWindow("run-1")).toBe(false);
  });

  it("refuses a run that is not the template the caller named", async () => {
    // The two identifiers are independent on a template-scoped route: without
    // this, a person could authorize with a run they may answer and operate on
    // somebody else's template.
    expect(await mod.canRespondInRunWindow("run-1", "t-1")).toBe(true);
    expect(await mod.canRespondInRunWindow("run-1", "t-someone-else")).toBe(false);
  });

  it("reads the exchange under the run's READ right, not its respond right", async () => {
    await mod.runWindowTurn({ runId: "run-1", surface: "run-page", prompt: "x" });
    enforceRunAccess.mockClear();
    await mod.readRunWindowConversation("run-1");
    expect(enforceRunAccess.mock.calls[0]?.[2]).toBe("read");
  });
});

describe("when the model cannot use tools, the window says so", () => {
  it("puts the platform's own sentence first, and still shows the answer", async () => {
    turnBehaviour = (send) => {
      send("turn_capability", { conversationOnly: true });
      send("text", { content: "I can tell you what it says." });
    };
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "run-page",
      prompt: "approve it for me",
    });
    expect(out.toolLess).toBe(true);
    const answer = out.entries.at(-1)?.text ?? "";
    expect(answer.startsWith(mod.RUN_WINDOW_TOOL_LESS_NOTICE)).toBe(true);
    expect(answer).toContain("I can tell you what it says.");
    // NEVER a silent no-op: the notice is stored with the run like any answer.
    expect(appended.at(-1)?.role).toBe("assistant");
  });

  it("says it even when the model produced nothing at all", () => {
    expect(
      mod.composeWindowAnswer({ text: "", toolLess: true, runtimeError: null }),
    ).toBe(mod.RUN_WINDOW_TOOL_LESS_NOTICE);
  });

  it("adds no notice for a tool-capable turn", () => {
    expect(
      mod.composeWindowAnswer({ text: "Done.", toolLess: false, runtimeError: null }),
    ).toBe("Done.");
  });

  it("answers in the platform's words when the turn failed", async () => {
    turnBehaviour = (send) => send("error", { message: "provider exploded: key sk-live-..." });
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "review",
      prompt: "hello",
    });
    const answer = out.entries.at(-1)?.text ?? "";
    expect(answer).toBe("The assistant could not answer just now — please try again.");
    expect(answer).not.toContain("sk-live");
  });
});

// ---------------------------------------------------------------------------
// THE WINDOW KNOWS ITS RUN, ON EVERY MOUNT (cinatra#3016).
//
// The plan: "Outside the chat, the prompt window is the person's conversation with
// the assistant about the run it sits under — on the run page, the step-by-step
// screen, the schedule screen, the armed-trigger tab and the review page." A
// window whose assistant answers "which step do you mean?" is not that
// conversation, and the person naming a run id to the window that is already
// mounted under it is the defect these pin.
// ---------------------------------------------------------------------------

const FIVE_SURFACES = [
  "run-page",
  "step-by-step",
  "schedule",
  "armed-trigger",
  "review",
] as const;

describe("the window hands the assistant the run it sits under", () => {
  it.each(FIVE_SURFACES)(
    "the %s mount's turn carries the run's id, status, gate and gate fields",
    async (surface) => {
      await mod.runWindowTurn({
        runId: "run-1",
        surface,
        prompt: "what is this step waiting for?",
      });
      const frame = (lastTurnArgs as { runFrame?: string }).runFrame ?? "";
      // The run's identity.
      expect(frame).toContain("run-1");
      expect(frame).toContain("pending_approval");
      // The gate it sits under, and that gate's current fields AND values.
      expect(frame).toContain("approval");
      expect(frame).toContain("campaign-setup");
      expect(frame).toContain("callToAction");
      expect(frame).toContain("Book a demo");
      // The screen the person is typing on, so the answer can be about it.
      expect(frame).toContain(surface);
      // The message is still what the person typed — the frame is not folded
      // into their words.
      const msgs = (lastTurnArgs as { messages: Array<{ content: string }> }).messages;
      expect(msgs.at(-1)?.content).toBe("what is this step waiting for?");
    },
  );

  it("carries the SCHEDULE the window sits under, with its current values", async () => {
    triggerByRun["run-1"] = {
      runId: "run-1",
      triggerType: "recurring",
      scheduledAt: null,
      cronExpression: "0 9 * * 3",
      timezone: "UTC",
      enabled: true,
      releasedAt: null,
      lastFiredAt: null,
      stoppedAt: null,
    };
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "armed-trigger",
      prompt: "what is this step waiting for?",
    });
    const frame = (lastTurnArgs as { runFrame?: string }).runFrame ?? "";
    expect(frame).toContain("schedule");
    expect(frame).toContain("0 9 * * 3");
    expect(frame).toContain("UTC");
  });

  it("reads the gate under the run the access check passed, and no other run", async () => {
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "schedule",
      prompt: "what is this step waiting for?",
    });
    // Read by the run's own id, once, on the row that cleared the access check.
    expect(hitlReads).toEqual(["run-1"]);
    expect(triggerReads).toEqual(["run-1"]);
    const frame = (lastTurnArgs as { runFrame?: string }).runFrame ?? "";
    expect(frame).not.toContain("run-2");
    expect(frame).not.toContain("the other run's business");
  });

  it("gives a person without respond access no frame and no window", async () => {
    const deny: EnforceRunAccess = async () => {
      throw new Error("denied");
    };
    enforceRunAccess.mockImplementation(deny);
    await expect(
      mod.runWindowTurn({ runId: "run-1", surface: "step-by-step", prompt: "what is this step waiting for?" }),
    ).rejects.toBeInstanceOf(mod.RunWindowAccessDenied);
    // No model was asked, so no frame was assembled…
    expect(lastTurnArgs).toBeNull();
    // …and nothing about the run was read for one.
    expect(hitlReads).toEqual([]);
    expect(triggerReads).toEqual([]);
    // …and the box is not drawn for them at all.
    expect(await mod.canRespondInRunWindow("run-1")).toBe(false);
  });

  it("lends the assistant nothing — the frame is state to read, not authority", async () => {
    await mod.runWindowTurn({
      runId: "run-1",
      surface: "run-page",
      prompt: "approve it for me",
    });
    // THE WHOLE ARGUMENT SET, not a substring search. The frame adds exactly
    // ONE argument to the turn and it is a string; a tool, a grant, an
    // allowlist or a control smuggled in beside it fails this line, which a
    // "does it contain the word grant" check would not.
    expect(Object.keys(lastTurnArgs ?? {}).sort()).toEqual(
      [
        "actorContext",
        "messages",
        "platformRole",
        "runFrame",
        "send",
        "sessionOrgId",
        "turnIdentity",
        "userId",
      ].sort(),
    );
    expect(typeof (lastTurnArgs as { runFrame?: unknown }).runFrame).toBe("string");
    // No binding is invented where the window offered none, and no grant is
    // minted here: W5c owns acting.
    expect((lastTurnArgs as { boundCard?: unknown }).boundCard).toBeUndefined();
    expect(JSON.stringify(lastTurnArgs)).not.toContain("grant");
  });

  it("reaches the model through the system context and nowhere else", async () => {
    // WHAT THIS PINS, EXACTLY: the runtime mentions this argument at TWO sites
    // and no more — the declaration and the one composition into the turn's
    // system fragments. Counting every mention rather than one spelling is what
    // makes a bracket access, a rename or a destructure fail this line too.
    //
    // WHAT IT DOES NOT PIN, said plainly rather than left to be discovered: the
    // whole argument object is passed to helpers inside the runtime, and a
    // helper that read the frame out of it would add no mention here. The bound
    // that does hold against that is the one above — the exact set of arguments
    // the road passes — and neither line is a claim about what a provider does
    // with the text once it is in the system string.
    const runtimeSrc = readFileSync(
      join(__dirname, "..", "..", "assistant-runtime", "runtime.ts"),
      "utf8",
    );
    const mentions = (runtimeSrc.match(/\brunFrame\b/g) ?? []).length;
    expect(mentions).toBe(2);
    expect(runtimeSrc).toContain("runFrame?: string;");
    expect(runtimeSrc).toContain("runFrameContext: args.runFrame ?? \"\"");
  });

  it("names the run even when it is waiting on nothing", async () => {
    hitlByRun["run-1"] = undefined;
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "review",
      prompt: "what is this step waiting for?",
    });
    hitlByRun["run-1"] = {
      xRenderer: "campaign-setup",
      childRunId: null,
      reviewTaskId: "task-9",
      inputSchema: { properties: { callToAction: {}, senderName: {} } },
      currentValues: { callToAction: "Book a demo", senderName: "Rita" },
    };
    expect(out.entries.at(-1)?.text).toBe("Here is what I found.");
    const frame = (lastTurnArgs as { runFrame?: string }).runFrame ?? "";
    expect(frame).toContain("run-1");
    expect(frame).toContain("not waiting");
  });

  it("answers anyway when the frame itself cannot be assembled", async () => {
    // The road's own fail-soft, exercised: the builder THROWS. A frame that
    // cannot be built costs the answer its context, never the answer — and the
    // turn then carries no frame argument at all rather than an empty one.
    frameThrows = true;
    const out = await mod.runWindowTurn({
      runId: "run-1",
      surface: "step-by-step",
      prompt: "what is this step waiting for?",
    });
    expect(out.entries.at(-1)?.text).toBe("Here is what I found.");
    expect((lastTurnArgs as { runFrame?: unknown }).runFrame).toBeUndefined();
    // …and what the person typed is still stored with the run.
    expect(appended.map((a) => a.role)).toEqual(["user", "assistant"]);
  });
});
