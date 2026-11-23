// @vitest-environment jsdom
/**
 * cinatra#3470: THE HOST'S ONE CONTINUE SENDS A DECLINE AS A DECLINE.
 *
 * On a declared publish step the agent's two choices only stage an answer, and
 * the host's one Continue beneath them sends it: "a decline is sent as a
 * decline, and nothing is posted" (design app-artifact-review I.4 and I.5).
 * Before this fix every Continue built `{ ...staged, approved: true }`, so a
 * staged `approved: false` left as an approval. Pinned here:
 *
 *   - the shared flag every mid-run Continue builds its payload with
 *     (`continueApprovalFlag`, used by the run panel, the stepper panel and the
 *     HITL screen card);
 *   - on the HITL screen card: a renderer that staged `approved: false` is sent
 *     with `approved: false`, and an untouched gate still continues as an
 *     approval;
 *   - end to end: a declared card's "decline" choice reaches the server action
 *     as `approved: false` with its carried keys;
 *   - ON THE REAL WIRE: what the card's own Continue sends goes through the
 *     real `approveReviewTaskInternal` (only the A2A client, the stores and
 *     the database are stubbed), on the chat thread and through the site
 *     widget's broker body. A typed field answer, a decline with its keys and
 *     a choice made after another one reach the running agent as exactly the
 *     staged answer, and the captured prompt and the answered-gate binding
 *     record the same answer.
 *
 * Harness mirrors agent-hitl-screen-card-boolean-4310.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/continue-sends-decline-3470.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }),
);
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));

// The list step's lists (cinatra#3470): one fixture list to pick.
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(async () => [
    { id: "list-1", name: "Fixture list", memberCount: 3, lastUpdated: null, memberType: "contact" },
  ]),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

// --- The real server road (cinatra#3470): only what lies past it is stubbed.
type SendTaskInput = { message?: { parts?: Array<{ kind?: string; text?: string }> } };
const sendTaskMock = vi.fn(async (_input: SendTaskInput) => ({
  id: "task-resume",
  status: { state: "completed" },
  contextId: "ctx-3470",
}));
const answeredMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })) },
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  writeHitlPrompt: vi.fn(async (_input: { submittedValues?: unknown }) => undefined),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await storeMock.writeHitlPrompt(input);
    return "captured-prompt";
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskMock })),
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: (...args: unknown[]) => answeredMock(...args),
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { approveReviewTaskInternal } from "../review-task-actions";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { continueApprovalFlag, continueHeldByRenderer } from "../hitl-gate-submit";
import { Button } from "@/components/ui/button";

const RUN_ID = "run-3470";
const TASK_ID = "wayflow-task-3470";
const PROBE_ID = "@acme-test/probe-agent:confirm";
const DECLARED_ID = "@acme-test/publish-agent:confirm";

/** A mid-run renderer whose one control stages a decline. */
function DeclineProbe({ onChange }: FieldRendererProps) {
  return (
    <Button type="button" onClick={() => onChange({ approved: false, itemId: "item-1" })}>
      Fixture decline
    </Button>
  );
}

function asking(xRenderer: string, currentValues: Record<string, unknown> = {}) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3470",
    gate: {
      reviewTaskId: TASK_ID,
      xRenderer,
      inputSchema: { type: "object" },
      currentValues,
      fieldName: undefined,
    },
  };
}

let current = asking(PROBE_ID);
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: PROBE_ID,
    priority: 100,
    condition: (_f, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === PROBE_ID,
    renderer: DeclineProbe,
    credentialSafe: true,
    midRunHitl: true,
  });
  current = asking(PROBE_ID);
  screenStateMock.mockImplementation(async () => current);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(current), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function mount() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** The site widget: no cookie session, a declared credential instead. */
function mountOnSiteWidget() {
  return render(
    <LifecycleCardSurfaceProvider
      host="site_widget"
      auth={{ headers: () => ({ Authorization: "Bearer cwu_site" }), credentials: "omit" }}
      frame={{ assistant: "a", instanceId: "i" }}
    >
      <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** A declared publish card with two choices (fixture words). */
function registerDeclaredPublishCard() {
  registerFieldRendererBindings([
    {
      id: DECLARED_ID,
      kind: "linkedin-draft-review",
      priority: 90,
      midRunHitl: true,
      screen: {
        layout: "card",
        title: "Fixture publish step",
        sections: [{ type: "words", key: "content" }],
        decisionLabel: "Fixture decision",
        decisions: [
          { label: "Fixture do not send", answer: { approved: false } },
          { label: "Fixture send", answer: { approved: true } },
        ],
        carry: ["itemId", "revisionId"],
        requires: ["itemId", "revisionId"],
      },
    },
  ]);
  current = asking(DECLARED_ID, { itemId: "item-1", revisionId: "rev-1", content: "Fixture words" });
}

function button(container: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    name.test(b.textContent ?? ""),
  );
}

/** A declared card's answer row: the radio inside the row whose text matches. */
function answer(container: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  const row = Array.from(container.querySelectorAll("label")).find((l) => name.test(l.textContent ?? ""));
  return row?.querySelector<HTMLButtonElement>('[role="radio"]') ?? undefined;
}

async function pressContinue(container: HTMLElement) {
  await waitFor(() => expect(button(container, /^Continue/)).toBeDefined());
  fireEvent.click(button(container, /^Continue/)!);
  await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
  return (approveMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

describe("continueApprovalFlag (cinatra#3470)", () => {
  it("keeps a staged decline and continues everything else as an approval", () => {
    expect(continueApprovalFlag({ approved: false })).toBe(false);
    expect(continueApprovalFlag({ approved: true })).toBe(true);
    expect(continueApprovalFlag({})).toBe(true);
    expect(continueApprovalFlag({ approved: "false" })).toBe(true);
  });
});

describe("the HITL screen card's Continue (cinatra#3470)", () => {
  it("sends a staged decline as a decline", async () => {
    const { container } = mount();
    await settle();
    await waitFor(() => expect(button(container, /Fixture decline/)).toBeDefined());
    fireEvent.click(button(container, /Fixture decline/)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(false);
    expect(payload.itemId).toBe("item-1");
  });

  it("an untouched gate still continues as an approval", async () => {
    const { container } = mount();
    await settle();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(true);
  });

  it("a declared card's decline reaches the server as a decline, with its carried keys", async () => {
    registerDeclaredPublishCard();
    const { container } = mount();
    await settle();
    await waitFor(() => expect(answer(container, /Fixture do not send/)).toBeDefined());
    fireEvent.click(answer(container, /Fixture do not send/)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
    const payload = await pressContinue(container);
    expect(payload).toMatchObject({ approved: false, itemId: "item-1", revisionId: "rev-1" });
  });
});

describe("a declared card holds the HITL screen card's Continue (cinatra#3470)", () => {
  function continueButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
  }

  it("the Continue stays disabled until a declared choice is made", async () => {
    registerDeclaredPublishCard();
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    expect(continueButton(container)!.disabled).toBe(true);
    // A press on the held Continue sends nothing.
    fireEvent.click(continueButton(container)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
    fireEvent.click(answer(container, /^Fixture send/)!);
    await settle();
    expect(continueButton(container)!.disabled).toBe(false);
    const payload = await pressContinue(container);
    expect(payload).toMatchObject({ approved: true, itemId: "item-1", revisionId: "rev-1" });
  });

  it("the Continue stays disabled until a required field holds text", async () => {
    registerFieldRendererBindings([
      {
        id: DECLARED_ID,
        kind: "linkedin-draft-review",
        priority: 90,
        midRunHitl: true,
        screen: {
          layout: "card",
          title: "Fixture question",
          sections: [{ type: "field", key: "answer", label: "Fixture label" }],
          carry: ["itemId"],
          requires: ["answer"],
        },
      },
    ]);
    current = asking(DECLARED_ID, { itemId: "item-1" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    expect(continueButton(container)!.disabled).toBe(true);
    const box = container.querySelector<HTMLInputElement>("input")!;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "   " } });
    await settle();
    expect(continueButton(container)!.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Fixture answer" } });
    await settle();
    expect(continueButton(container)!.disabled).toBe(false);
    const payload = await pressContinue(container);
    expect(payload).toMatchObject({ approved: true, itemId: "item-1", answer: "Fixture answer" });
  });
});

describe("continueHeldByRenderer (cinatra#3470)", () => {
  it("holds only where the entry declares continueReady and it answers false", () => {
    expect(continueHeldByRenderer(null, {}, {})).toBe(false);
    expect(continueHeldByRenderer({}, {}, {})).toBe(false);
    expect(continueHeldByRenderer({ continueReady: () => true }, {}, {})).toBe(false);
    expect(continueHeldByRenderer({ continueReady: () => false }, {}, {})).toBe(true);
    const seen = vi.fn(() => true);
    continueHeldByRenderer({ continueReady: seen }, undefined, { a: 1 });
    expect(seen).toHaveBeenCalledWith({ runValue: {}, staged: { a: 1 } });
  });
});

describe("a declared card on the site widget (cinatra#3470)", () => {
  it("is drawn on a credential-only host, and its Continue is not withheld", async () => {
    registerDeclaredPublishCard();
    const { container } = mountOnSiteWidget();
    await settle();
    await waitFor(() => expect(answer(container, /Fixture do not send/)).toBeDefined());
    expect(answer(container, /^Fixture send/)).toBeDefined();
    fireEvent.click(answer(container, /Fixture do not send/)!);
    await settle();
    const go = container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
    expect(go).not.toBeNull();
    expect(go!.disabled).toBe(false);
    expect(go!.getAttribute("title")).toBeNull();
  });
});

describe("a declared card's answer on the real wire (cinatra#3470)", () => {
  /** The cookie door forwards into the real server road, as the action does. */
  function throughTheServer() {
    storeMock.readAgentRunByTaskId.mockResolvedValue({
      id: "run-wire-3470",
      templateId: "tpl-3470",
      status: "pending_approval",
      a2aContextId: "ctx-3470",
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-3470",
      packageName: "@acme-test/publish-agent",
      sourceType: "internal",
    });
    approveMock.mockImplementation(async (taskId: string, values?: unknown) => {
      await approveReviewTaskInternal(taskId, "actor-3470", values);
      return { ok: true as const };
    });
  }

  /** The one text part the running agent receives. */
  function wireText(): string {
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const parts = (sendTaskMock.mock.calls[0]?.[0] as SendTaskInput)?.message?.parts;
    expect(parts).toHaveLength(1);
    return parts?.[0]?.text ?? "";
  }

  /** What the captured prompt recorded as the submitted values. */
  function recorded(): unknown {
    return (storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown })?.submittedValues;
  }

  function registerCard(screen: Record<string, unknown>, currentValues: Record<string, unknown>) {
    registerFieldRendererBindings([
      { id: DECLARED_ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen },
    ]);
    current = asking(DECLARED_ID, currentValues);
  }

  const FIELD_CARD = {
    layout: "card",
    title: "Fixture question",
    sections: [
      { type: "field", key: "answer", label: "Fixture answer label" },
      { type: "field", key: "detail", label: "Fixture detail label", multiline: true },
    ],
    carry: ["itemId"],
  };

  const CHOICE_CARD = {
    layout: "card",
    title: "Fixture choice",
    decisionLabel: "Fixture decision",
    decisions: [
      { label: "Fixture decline", answer: { approved: false, reason: "Fixture reason" } },
      { label: "Fixture revise", answer: { action: "revise" } },
    ],
    carry: ["itemId"],
  };

  beforeEach(() => {
    sendTaskMock.mockClear();
    answeredMock.mockClear();
    storeMock.writeHitlPrompt.mockClear();
    throughTheServer();
  });

  it("a typed field answer reaches the agent as the answer, and is recorded as sent", async () => {
    registerCard(FIELD_CARD, { itemId: "item-1" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(container.querySelector("input")).not.toBeNull());
    fireEvent.change(container.querySelector("input")!, { target: { value: "revise this" } });
    await settle();
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Fixture detail" } });
    await settle();
    await pressContinue(container);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    const sent = JSON.stringify({ itemId: "item-1", answer: "revise this", detail: "Fixture detail" });
    expect(wireText()).toBe(sent);
    expect(recorded()).toEqual({ itemId: "item-1", answer: "revise this", detail: "Fixture detail" });
    expect(answeredMock).toHaveBeenCalledWith("run-wire-3470", "task-3470", sent);
  });

  it("a declared decline reaches the agent with its own keys, and is recorded as the same decline", async () => {
    registerCard(CHOICE_CARD, { itemId: "item-1" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(answer(container, /Fixture decline/)).toBeDefined());
    fireEvent.click(answer(container, /Fixture decline/)!);
    await settle();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(false);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    const sent = JSON.stringify({ itemId: "item-1", approved: false, reason: "Fixture reason" });
    expect(wireText()).toBe(sent);
    expect(recorded()).toEqual({ itemId: "item-1", approved: false, reason: "Fixture reason" });
    expect(answeredMock).toHaveBeenCalledWith("run-wire-3470", "task-3470", sent);
  });

  it("a choice made after another one sends only its own answer, never the earlier one's keys", async () => {
    registerCard(CHOICE_CARD, { itemId: "item-1" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(answer(container, /Fixture decline/)).toBeDefined());
    fireEvent.click(answer(container, /Fixture decline/)!);
    await settle();
    fireEvent.click(answer(container, /Fixture revise/)!);
    await settle();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(true);
    expect(Object.hasOwn(payload, "reason")).toBe(false);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    expect(wireText()).toBe(JSON.stringify({ itemId: "item-1", action: "revise" }));
    expect(recorded()).toEqual({ itemId: "item-1", action: "revise" });
  });

  it("the site widget's broker body carries the same answer to the same server road", async () => {
    registerCard(FIELD_CARD, { itemId: "item-1" });
    const bodies: Array<Record<string, unknown>> = [];
    const readFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith("/submit")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ outcome: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return readFetch(url as string);
    }) as unknown as typeof fetch;
    const { container } = mountOnSiteWidget();
    await settle();
    await waitFor(() => expect(container.querySelector("input")).not.toBeNull());
    fireEvent.change(container.querySelector("input")!, { target: { value: "revise this" } });
    await settle();
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Fixture detail" } });
    await settle();
    await waitFor(() => expect(button(container, /^Continue/)?.disabled).toBe(false));
    fireEvent.click(button(container, /^Continue/)!);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(approveMock).not.toHaveBeenCalled();
    // The submit route hands `values` to the same core (agent-hitl-screen-submit.ts).
    await approveReviewTaskInternal(String(bodies[0]!.reviewTaskId), "actor-3470", bodies[0]!.values);
    expect(wireText()).toBe(JSON.stringify({ itemId: "item-1", answer: "revise this", detail: "Fixture detail" }));
  });
});

describe("a list step on the HITL screen card sends its pick on the real wire (cinatra#3470)", () => {
  // A list step reached through the card's own read: a declared "kind" list
  // picker, and the `:list-picker` binding an installed agent declares with no
  // screen. Both are lifted into the approval note, as on the run page.
  const LIST_ID = "@acme-test/list-agent:list-picker";

  function listAsking(declared: boolean) {
    return {
      ...asking(LIST_ID, {}),
      ...(declared
        ? {
            declaredScreen: {
              id: LIST_ID,
              kind: "list-picker",
              priority: 80,
              midRunHitl: true,
              params: { question: "Fixture question?" },
              screen: { layout: "kind" },
            },
          }
        : {}),
    };
  }

  function wireText(): string {
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    return (sendTaskMock.mock.calls[0]?.[0] as SendTaskInput)?.message?.parts?.[0]?.text ?? "";
  }

  beforeEach(() => {
    sendTaskMock.mockClear();
    storeMock.writeHitlPrompt.mockClear();
    storeMock.readAgentRunByTaskId.mockResolvedValue({
      id: "run-wire-3470",
      templateId: "tpl-3470",
      status: "pending_approval",
      a2aContextId: "ctx-3470",
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-3470",
      packageName: "@acme-test/list-agent",
      sourceType: "internal",
    });
    approveMock.mockImplementation(async (taskId: string, values?: unknown) => {
      await approveReviewTaskInternal(taskId, "actor-3470", values);
      return { ok: true as const };
    });
  });

  function mountOnChat() {
    return render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
      </LifecycleCardSurfaceProvider>,
    );
  }

  for (const declared of [true, false]) {
    it(`${declared ? "a declared 'kind' list picker" : "an installed :list-picker binding"}: the pick reaches the agent as the list snapshot`, async () => {
      if (!declared) {
        registerFieldRendererBindings([{ id: LIST_ID, kind: "list-picker", priority: 80 }]);
      }
      current = listAsking(declared);
      const { container } = mountOnChat();
      await settle();
      await waitFor(() => expect(container.textContent).toContain("Fixture list"));
      // Nothing picked: the card's Continue sends nothing.
      const go = () => container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
      await waitFor(() => expect(go()).not.toBeNull());
      fireEvent.click(go()!);
      await settle();
      expect(approveMock).not.toHaveBeenCalled();
      const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((el) =>
        (el.textContent ?? "").includes("Fixture list"),
      )!;
      fireEvent.click(row);
      await settle();
      fireEvent.click(go()!);
      await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
      const text = wireText();
      expect(text).toMatch(/^\{"type":"list"/);
      const snapshot = JSON.parse(text) as Record<string, unknown>;
      expect(snapshot).toMatchObject({ type: "list", listId: "list-1", listName: "Fixture list", memberCount: 3 });
      const prompt = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
      expect(prompt?.submittedValues).toEqual(expect.objectContaining({ approvalNote: text }));
    });
  }
});
