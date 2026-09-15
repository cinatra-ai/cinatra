/**
 * E4 (the server half) AND ACCEPTANCE (e) OF cinatra#3487 — THE WINDOW'S WORLD
 * IS THE CHAT COMPOSER'S, ON EVERY SCREEN.
 *
 * The ruling of 2026-09-14: the window "ALWAYS provides the assistant's FULL
 * capabilities, exactly as if no lifecycle screen were active; the screen's
 * context (its surface, the run, step or gate identity, and how a result is
 * applied) is handed to the window in addition, never as a restriction." And the
 * enforcement: "a behavioural test per screen (setup, schedule, review, blocked,
 * no screen): the rendered run page intercepts the request the window sends for
 * an ordinary request unrelated to the screen and asserts the request's tool
 * exposure and capability set are byte-equal to the chat composer's on a page
 * without a screen — the only permitted difference the additive screen-context
 * field".
 *
 * WHERE TOOL EXPOSURE AND THE CAPABILITY SET ACTUALLY LIVE. Neither is a field a
 * browser sends: both are fixed at the network boundary by the one request
 * builder, `buildCinatraAssistantRuntimeConfig()`, and handed to
 * `runAssistantTurn`. So this test intercepts that call on BOTH roads — the run
 * window's (`runWindowTurn`) and the chat composer's (`runChatTurn`) — and
 * compares what each one hands over. The client half of the same claim (the
 * payload the page's window sends, per screen) is measured by
 * `packages/agents/src/__tests__/run-page-chrome-one-window-3487.test.tsx`.
 *
 * NO WAIVER, NO SKIP (E6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ROW = {
  id: "run-3487",
  templateId: "t-1",
  orgId: "org-1",
  status: "pending_approval",
  title: "Blog draft",
  inputParams: {},
};

const stored: Array<{
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant";
  surface: string;
  text: string;
  replyToSequence: number | null;
  createdAt: Date;
}> = [];

/** Every `runAssistantTurn` call either road made: its config and its arguments. */
const turns: Array<{ config: unknown; args: Record<string, unknown> }> = [];

vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  enforceRunAccess: async () => {},
  resolveEffectivePolicy: () => ({ runDataVisibility: "owner" }),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: async () => RUN_ROW as Record<string, unknown>,
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
    const row = {
      id: `m${stored.length + 1}`,
      runId: input.runId,
      sequence: stored.length + 1,
      role: input.role,
      surface: input.surface,
      text: input.text,
      replyToSequence: input.replyToSequence ?? null,
      createdAt: new Date(),
    };
    stored.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...stored],
}));
// The run's READ-STATE frame. It lends nothing and is exercised by its own
// suite; here it is a fixed string so the comparison below is about the world
// the turn is given, not about what the frame happened to read.
vi.mock("../run-window-frame", () => ({
  buildRunWindowFrame: async () => ({ frame: "x" }),
  renderRunWindowFrame: () => "THE RUN: Blog draft",
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: (s: { user: { id: string } }) => ({
    actorType: "human",
    source: "ui",
    userId: s.user.id,
    organizationId: "org-1",
    roles: [],
  }),
  buildActorContextFromPrimitive: (actor: { userId?: string | null }, orgId?: string | null) => ({
    actorType: "human",
    userId: actor.userId ?? null,
    organizationId: orgId ?? undefined,
  }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({
    user: { id: "u-owner", role: "user" },
    session: { activeOrganizationId: "org-1" },
  }),
  resolveUserContextForUserId: async () => ({
    actorContext: { actorType: "human", userId: "u-owner" },
    platformRole: "member",
    sessionOrgId: "org-1",
  }),
}));
vi.mock("../bound-turn-actor", () => ({
  resolveBoundTurnActor: async ({ userId, orgId }: { userId?: string | null; orgId?: string | null }) =>
    userId && orgId
      ? {
          actor: { actorType: "human", source: "agent", userId, orgId },
          orgId,
          roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: orgId },
        }
      : null,
}));
// THE ONE THING THAT IS NOT MOCKED IS THE BUILDER: its real output is the tool
// exposure and capability set under comparison.
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: async (config: unknown, args: Record<string, unknown>) => {
    turns.push({ config, args });
    (args.send as (e: string, d: unknown) => void)("text", { content: "Berlin is mild today." });
  },
  describeLlmRuntimeUnavailability: () => null,
}));

const runWindow = await import("../run-window-turn");
const chat = await import("@/app/api/chat/runner");

/**
 * The comparable reading of a runtime config: every value, with functions named
 * rather than dropped, so a config that swapped a tool table for a filtered one
 * cannot compare equal to the unfiltered one.
 */
function readingOf(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "function" ? `fn:${(v as { name?: string }).name ?? "anonymous"}` : v,
    ),
  );
}

/** An ordinary request, unrelated to any screen. */
const UNRELATED = "what is the weather in Berlin today?";

const SCREENS = ["run-page", "step-by-step", "schedule", "armed-trigger", "review"] as const;

beforeEach(() => {
  stored.length = 0;
  turns.length = 0;
});

describe("E4 — the window's world is the chat composer's, on every screen", () => {
  it("the chat composer's own turn is the baseline", async () => {
    await chat.runChatTurn({
      messages: [{ role: "user", content: UNRELATED }],
      actorContext: { actorType: "human", userId: "u-owner" },
      userId: "u-owner",
      platformRole: "member",
      sessionOrgId: "org-1",
      send: () => {},
    } as never);
    expect(turns).toHaveLength(1);
    expect(readingOf(turns[0].config)).not.toBeNull();
  });

  for (const surface of SCREENS) {
    it(`${surface}: the same tool exposure and capability set as the chat composer`, async () => {
      await chat.runChatTurn({
        messages: [{ role: "user", content: UNRELATED }],
        actorContext: { actorType: "human", userId: "u-owner" },
        userId: "u-owner",
        platformRole: "member",
        sessionOrgId: "org-1",
        send: () => {},
      } as never);
      await runWindow.runWindowTurn({ runId: "run-3487", surface, prompt: UNRELATED });
      expect(turns).toHaveLength(2);
      const [composer, window_] = turns;
      // BYTE-EQUAL, read as the whole config: the world the turn runs in is the
      // same object-for-object on both roads, with no screen able to shrink it.
      expect(readingOf(window_.config)).toEqual(readingOf(composer.config));
    });
  }

  it("a review screen with a bound card changes the world not at all", async () => {
    await chat.runChatTurn({
      messages: [{ role: "user", content: UNRELATED }],
      actorContext: { actorType: "human", userId: "u-owner" },
      userId: "u-owner",
      platformRole: "member",
      sessionOrgId: "org-1",
      send: () => {},
    } as never);
    await runWindow.runWindowTurn({
      runId: "run-3487",
      surface: "review",
      prompt: UNRELATED,
      boundCard: { candidateRefs: ["ref-3487"], focusedRef: "ref-3487" },
    });
    const [composer, window_] = turns;
    expect(readingOf(window_.config)).toEqual(readingOf(composer.config));
  });

  it("the screen's context is ADDITIVE and nothing in the turn narrows the world", async () => {
    await runWindow.runWindowTurn({
      runId: "run-3487",
      surface: "review",
      prompt: UNRELATED,
      boundCard: { candidateRefs: ["ref-3487"], focusedRef: "ref-3487" },
    });
    const args = turns[0].args;
    // The additive fields the ruling names — the surface's claim and the run's
    // read-state frame — and no field that could narrow tools or capabilities.
    expect(Object.keys(args)).toContain("boundCard");
    expect(Object.keys(args)).toContain("runFrame");
    const narrowing = Object.keys(args).filter((k) =>
      /allow|filter|mode|tool|capabilit|deny|restrict|only|subset/i.test(k),
    );
    expect(narrowing, `narrowing arguments: ${narrowing.join(", ")}`).toEqual([]);
  });

  it("every screen hands the runtime the same argument shape apart from the claim", async () => {
    const shapes: Record<string, string[]> = {};
    for (const surface of SCREENS) {
      turns.length = 0;
      stored.length = 0;
      await runWindow.runWindowTurn({ runId: "run-3487", surface, prompt: UNRELATED });
      shapes[surface] = Object.keys(turns[0].args).sort();
    }
    const first = shapes[SCREENS[0]];
    for (const surface of SCREENS) expect(shapes[surface]).toEqual(first);
  });
});
