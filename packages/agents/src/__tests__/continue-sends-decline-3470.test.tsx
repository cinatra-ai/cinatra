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
 *     record the same answer. So does an untouched prefilled field, a choice
 *     staged before the conversation moved the card (still drawn as chosen),
 *     and a choice switch, whose carried keys come from the run values. A
 *     declared answer sent with a file reaches the agent in the attachment
 *     envelope, and is recorded as that answer with its file under
 *     `attachments`, never as the envelope;
 *   - the shared readiness predicate holds a gate with no binding while the
 *     host's bindings load, after they failed, and when its declared screen
 *     did not register; on the card, a read that could not tell and a handed
 *     screen that did not register both hold the Continue with their reason;
 *   - a list step is read from the binding's declared kind, so a list picker
 *     with any id sends its pick.
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
  // cinatra#3470: the gate row of a step that opened with no declared screen (no
  // pin, a renderer id no binding declares); a missing row refuses the answer.
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) => ({
    runId, reviewTaskId, xRenderer: "fixture-test/no-declared-screen",
    inputSchema: {}, values: {}, materializedAt: "2026-01-01T00:00:00.000Z",
  }),
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
import { declaredHitlCardOf, fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import { AgentHitlScreenCard, type AgentHitlScreenCarrier } from "../agent-hitl-screen-card";
import {
  continueApprovalFlag,
  continueHeldByRenderer,
  declaredHitlContinuePayload,
  declaredHitlStage,
  isGroupedSetupRenderer,
  isMidRunListStepGate,
  liftRendererApprovalNote,
  withContextSelectorEnvelope,
} from "../hitl-gate-submit";
import { classifyMidRunHitl } from "../orchestrator-mid-run-hitl";
import {
  declaredHitlScreenReady,
  makeDeclaredHitlScreenRenderer,
  type DeclaredHitlCard,
} from "../declared-hitl-screen-renderer";
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
  const loaded = { status: "loaded" as const, announcedIds: new Set<string>(), freshlyReadIds: new Set<string>() };
  const boundGate = { xRenderer: PROBE_ID, bindings: loaded };

  it("holds only where the entry declares continueReady and it answers false", () => {
    expect(continueHeldByRenderer(null, {}, {}, boundGate)).toBe(false);
    expect(continueHeldByRenderer({}, {}, {}, boundGate)).toBe(false);
    expect(continueHeldByRenderer({ continueReady: () => true }, {}, {}, boundGate)).toBe(false);
    expect(continueHeldByRenderer({ continueReady: () => false }, {}, {}, boundGate)).toBe(true);
    const seen = vi.fn(() => true);
    continueHeldByRenderer({ continueReady: seen }, undefined, { a: 1 }, boundGate);
    expect(seen).toHaveBeenCalledWith({ runValue: {}, staged: { a: 1 } });
  });

  // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
  it("holds a gate with no binding registered while bindings load, after they failed, and when its announced screen did not register", () => {
    const unbound = "@acme-test/runtime-agent:output";
    const at = (bindings: {
      status: "loading" | "loaded" | "failed";
      announcedIds: ReadonlySet<string>;
      freshlyReadIds: ReadonlySet<string> | "every";
    }) =>
      ({ xRenderer: unbound, bindings });
    expect(continueHeldByRenderer(null, {}, {}, at({ status: "loading", announcedIds: new Set(), freshlyReadIds: new Set() }))).toBe(true);
    expect(continueHeldByRenderer(null, {}, {}, at({ status: "failed", announcedIds: new Set(), freshlyReadIds: new Set() }))).toBe(true);
    expect(continueHeldByRenderer(null, {}, {}, at({ status: "loaded", announcedIds: new Set([unbound]), freshlyReadIds: new Set() }))).toBe(true);
    // Loaded, but no fresh read has answered for it yet: the answer may be a
    // scan cached before its agent was installed, so it is held.
    // red-first-expect: expected false to be true
    expect(continueHeldByRenderer(null, {}, {}, at(loaded))).toBe(true);
    // Loaded, and a fresh read found no screen for it: a gate with no binding, as before.
    expect(
      continueHeldByRenderer(null, {}, {}, at({ ...loaded, freshlyReadIds: new Set([unbound]) })),
    ).toBe(false);
    // A source that reads each gate's own binding fresh answers for every id.
    expect(continueHeldByRenderer(null, {}, {}, at({ ...loaded, freshlyReadIds: "every" }))).toBe(false);
    // A registered binding is not held by a load that failed: it was registered.
    expect(continueHeldByRenderer(null, {}, {}, { xRenderer: PROBE_ID, bindings: { status: "failed", announcedIds: new Set(), freshlyReadIds: new Set() } })).toBe(false);
  });

  it("holds a registered binding the source refused, and a gate an incomplete answer does not name", () => {
    // A refused id overrides a binding an earlier read registered under it.
    const refusedLoad = { ...loaded, freshlyReadIds: "every" as const, refusedIds: new Set([PROBE_ID]) };
    // red-first-expect: expected false to be true
    expect(continueHeldByRenderer(null, {}, {}, { xRenderer: PROBE_ID, bindings: refusedLoad })).toBe(true);
    // A source that could not read every installed agent proves no unnamed id declares nothing.
    const unbound = "@acme-test/unread-agent:output";
    const incomplete = { ...loaded, freshlyReadIds: new Set([unbound]), incomplete: true };
    expect(continueHeldByRenderer(null, {}, {}, { xRenderer: unbound, bindings: incomplete })).toBe(true);
    // A registered binding is not held by an incomplete answer.
    expect(continueHeldByRenderer(null, {}, {}, { xRenderer: PROBE_ID, bindings: incomplete })).toBe(false);
  });
});

describe("the HITL screen card holds a screen whose binding failed to load (cinatra#3470)", () => {
  const RUNTIME_ID = "@acme-test/runtime-agent:output";
  const HOLD_FAILED = "This step's screen could not be loaded. Reload the page to try again.";

  function continueButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
  }
  function holdReason(container: HTMLElement): string | null {
    return container.querySelector("[data-continue-hold-reason]")?.textContent ?? null;
  }

  // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
  it("holds the Continue, with its reason, when the read could not tell whether a screen is declared", async () => {
    current = { ...asking(RUNTIME_ID, { itemId: "item-1" }), declaredScreenUnavailable: true } as typeof current;
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    expect(continueButton(container)!.disabled).toBe(true);
    expect(holdReason(container)).toBe(HOLD_FAILED);
    fireEvent.click(continueButton(container)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
  });

  // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
  it("holds the Continue, with its reason, when the declared screen the read handed over did not register", async () => {
    current = {
      ...asking(RUNTIME_ID, { itemId: "item-1" }),
      // A screen the registration refuses: a card with no title and no sections.
      declaredScreen: { id: RUNTIME_ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
    } as typeof current;
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    expect(continueButton(container)!.disabled).toBe(true);
    expect(holdReason(container)).toBe(HOLD_FAILED);
    fireEvent.click(continueButton(container)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("holds the Continue of a refused screen even over a binding registered earlier under its id", async () => {
    // An earlier read registered a drawable card for the id …
    registerFieldRendererBindings([
      {
        id: RUNTIME_ID,
        kind: "linkedin-draft-review",
        priority: 90,
        midRunHitl: true,
        screen: { layout: "card", title: "Fixture earlier card" },
      },
    ]);
    // … and the card's read now names its screen as refused.
    current = {
      ...asking(RUNTIME_ID, { itemId: "item-1" }),
      declaredScreenUnavailable: true,
      declaredScreenRefused: true,
    } as typeof current;
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    // red-first-expect: expected false to be true
    expect(continueButton(container)!.disabled).toBe(true);
    expect(holdReason(container)).toBe(HOLD_FAILED);
    fireEvent.click(continueButton(container)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("leaves a gate with no binding and no declared screen as before: its Continue sends", async () => {
    current = asking(RUNTIME_ID, { itemId: "item-1" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(continueButton(container)?.disabled).toBe(false));
    expect(holdReason(container)).toBeNull();
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

  // The run page's Continue sends a declared answer with the files the person
  // attached (`declaredHitlContinuePayload`): the agent reads the answer in the
  // envelope's text with the files beside it, and the record holds that
  // answer and its files, never the transport envelope.
  const FILE = {
    artifactId: "art-3470",
    representationRevisionId: "rev-file-3470",
    digest: "sha256:fixture",
    mime: "application/pdf",
    originKind: "upload" as const,
    filename: "fixture.pdf",
  };

  async function sendWithFile(screen: Record<string, unknown>, runValue: Record<string, unknown>, change: Record<string, unknown>) {
    registerCard(screen, runValue);
    const card = declaredHitlCardOf(DECLARED_ID)!;
    const staged = declaredHitlStage(card, runValue, {}, change);
    await approveReviewTaskInternal(TASK_ID, "actor-3470", declaredHitlContinuePayload(card, staged, [FILE]));
  }

  it("a typed field answer sent with a file reaches the agent with the file, and is recorded as the answer and its file", async () => {
    await sendWithFile(FIELD_CARD, { itemId: "item-1" }, { answer: "revise this", detail: "Fixture detail" });
    const sent = JSON.stringify({ itemId: "item-1", answer: "revise this", detail: "Fixture detail" });
    expect(wireText()).toBe(JSON.stringify({ text: sent, attachments: [FILE] }));
    // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
    expect(recorded()).toEqual({
      itemId: "item-1",
      answer: "revise this",
      detail: "Fixture detail",
      attachments: [FILE],
    });
  });

  it("a declared decline sent with a file is recorded as the decline and its file", async () => {
    await sendWithFile(CHOICE_CARD, { itemId: "item-1" }, { approved: false, reason: "Fixture reason" });
    const sent = JSON.stringify({ itemId: "item-1", approved: false, reason: "Fixture reason" });
    expect(wireText()).toBe(JSON.stringify({ text: sent, attachments: [FILE] }));
    // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
    expect(recorded()).toEqual({ itemId: "item-1", approved: false, reason: "Fixture reason", attachments: [FILE] });
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

  it("an untouched prefilled field is sent exactly as shown", async () => {
    // The run value prefills both fields; the person presses Continue without
    // touching either. What the card shows is what the agent receives.
    registerCard(FIELD_CARD, { itemId: "item-1", answer: "prefilled", detail: "Fixture prefilled detail" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("prefilled"));
    await pressContinue(container);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    const sent = JSON.stringify({ itemId: "item-1", answer: "prefilled", detail: "Fixture prefilled detail" });
    expect(wireText()).toBe(sent);
    expect(recorded()).toEqual({ itemId: "item-1", answer: "prefilled", detail: "Fixture prefilled detail" });
  });

  it("a card moved to another place in the conversation keeps its staged choice visible, and sends it", async () => {
    // The conversation draws the card in one of two containers and moves it
    // mid-answer (chat-messages-view.tsx): the instance is unmounted and a new
    // one mounted, with the host's carrier keeping the staged answer.
    registerCard(CHOICE_CARD, { itemId: "item-1" });
    const carrier: AgentHitlScreenCarrier = { current: null };
    const draw = () => (
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} carrier={carrier} />
      </LifecycleCardSurfaceProvider>
    );
    const first = render(<section data-place="first">{draw()}</section>);
    await settle();
    await waitFor(() => expect(answer(first.container, /Fixture decline/)).toBeDefined());
    fireEvent.click(answer(first.container, /Fixture decline/)!);
    await settle();
    first.unmount();
    const moved = render(<aside data-place="moved">{draw()}</aside>);
    await settle();
    await waitFor(() => expect(answer(moved.container, /Fixture decline/)).toBeDefined());
    expect(answer(moved.container, /Fixture decline/)!.getAttribute("aria-checked")).toBe("true");
    expect(answer(moved.container, /Fixture revise/)!.getAttribute("aria-checked")).toBe("false");
    await pressContinue(moved.container);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    expect(wireText()).toBe(JSON.stringify({ itemId: "item-1", approved: false, reason: "Fixture reason" }));
  });

  it("a choice switch carries its keys from the run values, never from the earlier choice", async () => {
    // The schema refuses a carry key that is also an answer key; this card
    // is registered past the schema to prove the card itself reads carried
    // keys from the gate's run values: the earlier choice's `mode` is never
    // what goes out.
    const card: DeclaredHitlCard = {
      layout: "card",
      title: "Fixture choice",
      decisionLabel: "Fixture decision",
      decisions: [
        { label: "Fixture block", answer: { mode: "block" } },
        { label: "Fixture proceed", answer: { action: "proceed" } },
      ],
      carry: ["mode"],
    };
    fieldRendererRegistry.register({
      id: DECLARED_ID,
      priority: 90,
      condition: (_f, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === DECLARED_ID,
      renderer: makeDeclaredHitlScreenRenderer(card),
      credentialSafe: true,
      midRunHitl: true,
      stagesWholeAnswer: true,
      continueReady: ({ runValue, staged }) => declaredHitlScreenReady(card, runValue, staged),
      kind: "linkedin-draft-review",
    });
    current = asking(DECLARED_ID, { mode: "review" });
    const { container } = mount();
    await settle();
    await waitFor(() => expect(answer(container, /Fixture block/)).toBeDefined());
    fireEvent.click(answer(container, /Fixture block/)!);
    await settle();
    fireEvent.click(answer(container, /Fixture proceed/)!);
    await settle();
    await pressContinue(container);
    await waitFor(() => expect(sendTaskMock).toHaveBeenCalledTimes(1));
    expect(wireText()).toBe(JSON.stringify({ mode: "review", action: "proceed" }));
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
  // picker, and the list binding an installed agent declares with no screen.
  // Both are lifted into the approval note, as on the run page. A list step is
  // read from the binding's declared kind, so an id with any local name (not
  // only one ending in `:list-picker`) is one.
  const SUFFIX_ID = "@acme-test/list-agent:list-picker";
  const ARBITRARY_ID = "@acme-test/list-agent:pick-list";

  function listAsking(declared: boolean, listId: string) {
    return {
      ...asking(listId, {}),
      ...(declared
        ? {
            declaredScreen: {
              id: listId,
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

  for (const [declared, LIST_ID] of [
    [true, SUFFIX_ID],
    [false, SUFFIX_ID],
    [true, ARBITRARY_ID],
    [false, ARBITRARY_ID],
  ] as const) {
    it(`${declared ? "a declared 'kind' list picker" : "an installed list binding"} with the id ${LIST_ID}: the pick reaches the agent as the list snapshot`, async () => {
      if (!declared) {
        registerFieldRendererBindings([{ id: LIST_ID, kind: "list-picker", priority: 80 }]);
      }
      current = listAsking(declared, LIST_ID);
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

  it("the run page's and the stepper's shared readings take the declared kind, not the id", () => {
    registerFieldRendererBindings([{ id: ARBITRARY_ID, kind: "list-picker", priority: 80 }]);
    expect(isMidRunListStepGate(ARBITRARY_ID, TASK_ID)).toBe(true);
    expect(classifyMidRunHitl(ARBITRARY_ID)).toBe(true);
    const lift = liftRendererApprovalNote(ARBITRARY_ID, { listId: "list-1", listName: "Fixture list" });
    expect(JSON.parse(lift?.approvalNote ?? "{}")).toMatchObject({ type: "list", listId: "list-1" });
    // A binding of another kind is never a list step, whatever its id says.
    registerFieldRendererBindings([{ id: SUFFIX_ID, kind: "linkedin-draft-review", priority: 80 }]);
    expect(isMidRunListStepGate(SUFFIX_ID, TASK_ID)).toBe(false);
    expect(liftRendererApprovalNote(SUFFIX_ID, { listId: "list-1" })).toBeNull();
  });

  // red-first-expect: Failed to resolve import "../declared-hitl-screen-renderer"
  it("a declared card is the card whatever its id's suffix: never a setup form, list step or grouped setup", () => {
    const suffixes = [":setup-form", ":list-picker", ":scrape-schema-review", ":final-list-review", ":context-selector"];
    for (const suffix of suffixes) {
      const id = `@acme-test/declared-agent${suffix}`;
      registerFieldRendererBindings([
        {
          id,
          kind: "linkedin-draft-review",
          priority: 90,
          midRunHitl: true,
          screen: {
            layout: "card",
            title: "Fixture question",
            sections: [{ type: "field", key: "answer", label: "Fixture answer label" }],
            carry: ["itemId"],
          },
        },
      ]);
      expect(isGroupedSetupRenderer(id, { includeSetupFormSuffix: true })).toBe(false);
      expect(isMidRunListStepGate(id, TASK_ID)).toBe(false);
      expect(liftRendererApprovalNote(id, { listId: "list-1", instructions: "x" })).toBeNull();
      const staged = { itemId: "item-1", answer: "a" };
      expect(withContextSelectorEnvelope(id, { slotMeta: { slotId: "s" } }, staged)).toBe(staged);
    }
  });
});
