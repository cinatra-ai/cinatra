// @vitest-environment jsdom
// #3051: the real panel, review card and decision bar. Only the server/stream
// ports are fixtures; this is not hosted-widget/browser or capture proof.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LifecycleCardSurfaceProvider, type LifecycleCardAuth } from "../lifecycle-card-runtime";
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { AgenticRunPanel } from "../agentic-run-panel";
import { getAgentBuilderTask } from "../a2a-actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/embed/assistant", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("../hitl-actions", () => ({ approveReviewTask: vi.fn(), rejectReviewTask: vi.fn() }));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [], runId: "run-3051" })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(), skipRunRecommendationAction: vi.fn(),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(), createAndTriggerRun: vi.fn(), triggerAgentRun: vi.fn(),
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false, outputsUnavailable: false, unlinkableOutputs: 0 })),
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({ status: null, error: null, presentationHint: null, isLive: false, interruptContext: null, streamedText: "", dataPartFrames: [] })),
}));

// The client barrel adapter re-exports the ACTUAL panel; it replaces no UI.
vi.mock("@cinatra-ai/agents/client-entry", async () => ({
  AgenticRunPanel: (await import("../agentic-run-panel")).AgenticRunPanel,
}));
vi.mock("../../../chat/src/pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }), decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../../../chat/src/undo-actions", () => ({ recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }) }));
vi.mock("@/components/data-safety/undo-toast", () => ({ undoDeepLink: (id: string) => `/objects?undo=${id}` }));
vi.mock("../agent-hitl-screen-actions", () => ({ getAgentHitlScreenStateAction: async () => ({ state: "none" }) }));
import { ChatMessagesView } from "../../../chat/src/chat-messages-view";
import { createChatWidgetRuntime } from "../../../chat/src/widget-runtime";
import type { UiMessage } from "../../../chat/src/types";

const RUN = "run-3051";
const REF = "review-ref-3051";
const CARD = '[data-conformance-id="review-gate-card"]';
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const AUTH: LifecycleCardAuth = { headers: () => ({ "X-Cinatra-Widget-User-Token": "unit-broker-3051" }), credentials: "omit" };
const FRAME = { assistant: "wordpress", instanceId: "unit-instance-3051" };
const HEADER = { title: "Produced artifact", typeLabel: "Email", objectType: "@cinatra-ai/email:body", revisionId: "revision-3051", facts: ["organization", "private", "text/html"] };
const pending = { state: "pending", canDecide: true, canComment: true };
const settled = { state: "settled", outcome: "approved" };
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function props() {
  return { runId: RUN, initialStatus: "completed", initialError: null, initialMessages: [], agUiEnabled: false, templateId: "template-3051", surface: "chat" as const, initialReviewGate: { ref: REF, awaiting: false } };
}
function widget(node: React.ReactNode, auth: LifecycleCardAuth | undefined = AUTH) {
  return <LifecycleCardSurfaceProvider host="site_widget" auth={auth} frame={FRAME}>{node}</LifecycleCardSurfaceProvider>;
}
function service(options: { resolve?: () => Promise<Response>; initialState?: typeof pending | typeof settled; run?: () => Record<string, unknown> } = {}) {
  let state: typeof pending | typeof settled = options.initialState ?? pending;
  const port = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/recommendation-hold") || String(url).endsWith("/hitl-screen")) return response({ state: "none" });
    if (String(url).startsWith("/api/notifications")) return response({ notifications: [] });
    if (String(url).endsWith("/decide")) { state = settled; return response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } }); }
    if (String(url).endsWith("/resolve")) return options.resolve ? options.resolve() : response({ kind: "artifact_review_gate", state, body: null, targetHeaders: [HEADER] });
    return response(options.run ? options.run() : { status: "completed", error: null, messages: [], hitlContext: null, reviewGate: { ref: REF, awaiting: false } });
  });
  vi.stubGlobal("fetch", port); return port;
}
function lifecycleCalls(port: ReturnType<typeof service>) { return port.mock.calls.filter(([url]) => /\/lifecycle-views\/(resolve|decide)$/.test(String(url))); }
function assertBrokerCalls(port: ReturnType<typeof service>) {
  const calls = lifecycleCalls(port); expect(calls.length).toBeGreaterThan(0);
  for (const [, init] of calls) { expect(init?.credentials).toBe("omit"); expect(init?.headers).toMatchObject(AUTH.headers()); }
}
const WIDGET_RUNTIME = createChatWidgetRuntime([], []);
function transcript(messages: UiMessage[]) {
  return <ChatMessagesView messages={messages} isSlackMode={false} animating={false} theme="github-light"
    activeThreadId="thread-3051" assistantHandleMap={new Map()} taggedAssistantUserIds={[]}
    mentionables={[]} pausedParticipants={[]} onTogglePause={vi.fn()} requestEditMessageId={null}
    onRequestEditMessage={vi.fn()} onEditStarted={vi.fn()} hasActiveStream={false} isStreaming={() => false}
    onEditAndResend={vi.fn()} onActivateResource={vi.fn()} widgetRuntime={WIDGET_RUNTIME}
    widgetSubmitRef={{ current: null }} widgetRefreshKey={0} onActiveGateChange={vi.fn()}
    pendingExternalHandle={null} typingIndicators={new Map()} chatViews={{}}
    lifecycleSurface={{ host: "site_widget", auth: AUTH, frame: FRAME }} />;
}
beforeEach(() => { ensureDefaultFieldRenderersRegistered(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("#3051 — the widget run-card owns one broker-authorised review", () => {
  it("completed output draws one site_widget review; actual Approve resolves and decides with the same broker", async () => {
    const port = service(); const refreshReviewRail = vi.fn();
    const { container } = render(widget(<AgenticRunPanel {...props()} refreshReviewRail={refreshReviewRail} />));
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(container.querySelectorAll(CARD)).toHaveLength(1);
    expect(container.querySelector(CARD)?.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(container.querySelector(PLACEHOLDER)).toBeNull();
    expect(container.querySelector('[data-lifecycle-card-host="run_card"]')).toBeNull();
    fireEvent.click(approve);
    await waitFor(() => expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull());
    const decision = lifecycleCalls(port).find(([url]) => String(url).endsWith("/decide"));
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision![1]?.body))).toEqual({ ref: REF, disposition: "approve", comment: null });
    assertBrokerCalls(port); expect(refreshReviewRail).not.toHaveBeenCalled();
  });

  it("completed awaiting keeps one placeholder, then swaps to one real card only after its resolve draws", async () => {
    const answer = deferred<Response>(); const port = service({ resolve: () => answer.promise });
    const slot = deferred<{ ref: string; awaiting: boolean; producedReviewPark: boolean } | null>();
    const readReviewSlot = vi.fn(() => slot.promise);
    const { container } = render(widget(<AgenticRunPanel {...props()} initialReviewGate={{ ref: null, awaiting: true }} readReviewSlot={readReviewSlot} />));
    await waitFor(() => expect(container.querySelectorAll(PLACEHOLDER)).toHaveLength(1));
    expect(container.querySelector(CARD)).toBeNull();
    await act(async () => slot.resolve({ ref: REF, awaiting: false, producedReviewPark: false }));
    await waitFor(() => expect(lifecycleCalls(port).length).toBeGreaterThan(0));
    expect(container.querySelectorAll(PLACEHOLDER)).toHaveLength(1);
    await act(async () => answer.resolve(response({ kind: "artifact_review_gate", state: pending, body: null, targetHeaders: [HEADER] })));
    await screen.findByRole("button", { name: "Approve" });
    expect(container.querySelectorAll(CARD)).toHaveLength(1); expect(container.querySelector(PLACEHOLDER)).toBeNull(); assertBrokerCalls(port);
  });

  it("the marked review uses its own ref under the same widget host and broker decision", async () => {
    const port = service(); const { container } = render(widget(<AgenticRunPanel {...props()} initialStatus="pending_approval" initialHitlContext={{ xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID, childRunId: null, reviewTaskId: "review-task-3051", inputSchema: { type: "object" }, currentValues: { lifecycleCardRef: "marked-ref-3051" } }} />));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lifecycleCalls(port).some(([url]) => String(url).endsWith("/decide"))).toBe(true));
    const calls = lifecycleCalls(port); expect(calls.every(([, init]) => JSON.parse(String(init?.body)).ref === "marked-ref-3051")).toBe(true);
    expect(container.querySelector(CARD)?.getAttribute("data-lifecycle-card-host")).toBe("site_widget"); assertBrokerCalls(port);
  });

  it.each([undefined, { headers: AUTH.headers, credentials: "same-origin" as const }])("a refused widget declaration cannot recover through a cookie run_card (%s)", async (auth) => {
    const port = service(); const { container } = render(<LifecycleCardSurfaceProvider host="site_widget" auth={auth}><AgenticRunPanel {...props()} /></LifecycleCardSurfaceProvider>);
    await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
    expect(container.querySelector(CARD)).toBeNull(); expect(lifecycleCalls(port)).toHaveLength(0);
  });

  it.each([undefined, { headers: AUTH.headers, credentials: "same-origin" as const }])("refused auth (%s) cannot poll a run or call its cookie task action", async (auth) => {
    vi.useFakeTimers();
    const port = service();
    const { container } = render(<LifecycleCardSurfaceProvider host="site_widget" auth={auth}>
      <AgenticRunPanel {...props()} initialStatus="running" taskId="refused-task-3051" />
    </LifecycleCardSurfaceProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(container.querySelector(CARD)).toBeNull(); expect(lifecycleCalls(port)).toHaveLength(0);
    expect(port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`))).toHaveLength(0);
    expect(getAgentBuilderTask).not.toHaveBeenCalled();
  });

  it.each([
    ["pending_approval", undefined],
    ["pending_approval", { headers: AUTH.headers, credentials: "same-origin" as const }],
    ["completed", undefined],
    ["completed", { headers: AUTH.headers, credentials: "same-origin" as const }],
  ] as const)("refused widget %s with a null review ref never reads the cookie slot (%s)", async (status, auth) => {
    vi.useFakeTimers();
    const port = service();
    const { container } = render(<LifecycleCardSurfaceProvider host="site_widget" auth={auth}>
      <AgenticRunPanel {...props()} initialStatus={status} initialReviewGate={{ ref: null, awaiting: true }} />
    </LifecycleCardSurfaceProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`))).toHaveLength(0);
    expect(lifecycleCalls(port)).toHaveLength(0);
    expect(container.querySelector(CARD)).toBeNull();
    expect(getAgentBuilderTask).not.toHaveBeenCalled();
  });

  it.each(["pending_approval", "completed"])("refused widget %s cannot invoke even a supplied slot reader", async (status) => {
    vi.useFakeTimers();
    const port = service();
    const readReviewSlot = vi.fn(async () => ({ ref: REF, awaiting: false, producedReviewPark: false }));
    render(<LifecycleCardSurfaceProvider host="site_widget">
      <AgenticRunPanel {...props()} initialStatus={status} initialReviewGate={{ ref: null, awaiting: true }} readReviewSlot={readReviewSlot} />
    </LifecycleCardSurfaceProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(readReviewSlot).not.toHaveBeenCalled();
    expect(port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`))).toHaveLength(0);
    expect(lifecycleCalls(port)).toHaveLength(0);
  });

  it.each(["pending_approval", "completed"])("valid widget %s default slot reader uses its broker before resolve and decide", async (status) => {
    const port = service({ run: () => ({ status, error: null, messages: [], hitlContext: null,
      reviewGate: { ref: REF, awaiting: false, producedReviewPark: status === "pending_approval" } }) });
    const { container } = render(widget(<AgenticRunPanel {...props()} initialStatus={status} initialReviewGate={{ ref: null, awaiting: true }} />));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lifecycleCalls(port).some(([url]) => String(url).endsWith("/decide"))).toBe(true));
    const slots = port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`));
    expect(slots.length).toBeGreaterThan(0);
    for (const [, init] of slots) {
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toMatchObject(AUTH.headers());
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(container.querySelectorAll(CARD)).toHaveLength(1);
    expect(container.querySelector('[data-lifecycle-card-host="run_card"]')).toBeNull();
    expect(getAgentBuilderTask).not.toHaveBeenCalled();
    assertBrokerCalls(port);
  });

  it.each(["chat_thread", "run_card", "site_widget"] as const)("a nested %s declaration cannot override an already refused widget", async (host) => {
    const port = service();
    const { container } = render(<LifecycleCardSurfaceProvider host="site_widget">
      <LifecycleCardSurfaceProvider host={host} auth={host === "site_widget" ? AUTH : undefined}>
        <AgenticRunPanel {...props()} />
      </LifecycleCardSurfaceProvider>
    </LifecycleCardSurfaceProvider>);
    await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
    expect(container.querySelector(CARD)).toBeNull(); expect(lifecycleCalls(port)).toHaveLength(0);
  });

  it("a standalone panel still declares its ordinary cookie run_card", async () => {
    const port = service(); const { container } = render(<AgenticRunPanel {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lifecycleCalls(port).some(([url]) => String(url).endsWith("/decide"))).toBe(true));
    expect(container.querySelector(CARD)?.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    for (const [, init] of lifecycleCalls(port)) expect(init?.credentials).toBe("same-origin");
  });

  it("settled output restores one widget review from the same persisted run props on remount", async () => {
    const port = service({ initialState: settled }); const stored = JSON.stringify(props());
    const first = render(widget(<AgenticRunPanel {...JSON.parse(stored)} />));
    await waitFor(() => expect(first.container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull()); first.unmount();
    const again = render(widget(<AgenticRunPanel {...JSON.parse(stored)} />));
    await waitFor(() => expect(again.container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull());
    expect(again.container.querySelectorAll(CARD)).toHaveLength(1); assertBrokerCalls(port);
    // This proves actual panel restoration, not the full transcript carriage.
    expect(JSON.stringify(props())).toBe(stored);
  });

  it.each([undefined, "a2a-task-3051"])("the actual widget panel polls with its broker even when taskId=%s", async (taskId) => {
    const port = service();
    render(widget(<AgenticRunPanel {...props()} taskId={taskId} initialStatus="running"
      initialReviewGate={{ ref: null, awaiting: false }}
      readReviewSlot={async () => ({ ref: REF, awaiting: false, producedReviewPark: false })} />));
    await screen.findByRole("button", { name: "Approve" }, { timeout: 12000 });
    const polls = port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`));
    expect(polls.length).toBeGreaterThan(0);
    for (const [, init] of polls) {
      expect(init?.cache).toBe("no-store"); expect(init?.credentials).toBe("omit");
      expect(init?.headers).toEqual(AUTH.headers());
    }
    expect(getAgentBuilderTask).not.toHaveBeenCalled();
    assertBrokerCalls(port);
  });

  it("the real transcript run card changes from running to completed-awaiting to its one review", async () => {
    let status = "running";
    let reviewGate: { ref: string | null; awaiting: boolean } = { ref: null, awaiting: false };
    const answer = deferred<Response>();
    const port = service({ run: () => ({ status, error: null, messages: [], hitlContext: null, reviewGate }), resolve: () => answer.promise });
    const messages: UiMessage[] = [{ id: "assistant-live-3051", role: "assistant", content: "", parts: [
      { kind: "tool_call", id: "start-live-3051", name: "agent_named_start", runId: RUN, status: "completed" },
    ] }];
    const { container } = render(transcript(messages));
    await waitFor(() => expect(container.querySelectorAll(PLACEHOLDER)).toHaveLength(1));
    expect(container.querySelector(CARD)).toBeNull();
    status = "completed"; reviewGate = { ref: null, awaiting: true };
    await waitFor(() => expect(port.mock.calls.filter(([url]) => String(url).includes(`/runs/${RUN}`)).length).toBeGreaterThan(2), { timeout: 6000 });
    expect(container.querySelectorAll(PLACEHOLDER)).toHaveLength(1);
    reviewGate = { ref: REF, awaiting: false };
    await waitFor(() => expect(lifecycleCalls(port).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(container.querySelectorAll(PLACEHOLDER)).toHaveLength(1);
    await act(async () => answer.resolve(response({ kind: "artifact_review_gate", state: pending, body: null, targetHeaders: [HEADER] })));
    await screen.findByRole("button", { name: "Approve" });
    expect(container.querySelectorAll(CARD)).toHaveLength(1); expect(container.querySelector(PLACEHOLDER)).toBeNull();
    expect(container.querySelector(CARD)?.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    assertBrokerCalls(port);
    // InlineAgentRunCard's seed/slot reads are the broker request builder.
    // The inherited timeline status poll is a separate existing port;
    // this test does not certify that unbrokered poll or all widget networking.
    const brokerRunReads = port.mock.calls.filter(([url, init]) =>
      String(url).includes(`/runs/${RUN}`) && init?.credentials === "omit");
    expect(brokerRunReads.length).toBeGreaterThan(1);
    for (const [, init] of brokerRunReads) expect(init?.headers).toMatchObject(AUTH.headers());
  });

  it("the actual agent_named_start transcript carries one panel review and restores it settled on reload", async () => {
    const port = service();
    const messages: UiMessage[] = [{ id: "assistant-3051", role: "assistant", content: "", parts: [
      { kind: "tool_call", id: "start-3051", name: "agent_named_start", runId: RUN, status: "completed" },
    ] }];
    const stored = JSON.stringify(messages);
    const first = render(transcript(messages));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(first.container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull());
    expect(first.container.querySelectorAll(CARD)).toHaveLength(1);
    expect(first.container.querySelector('[data-run-review-slot="review"]')).not.toBeNull();
    expect(first.container.querySelector('[data-lifecycle-card-host="run_card"]')).toBeNull();
    first.unmount();
    const reload = render(transcript(JSON.parse(stored)));
    await waitFor(() => expect(reload.container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull());
    expect(reload.container.querySelectorAll(CARD)).toHaveLength(1); assertBrokerCalls(port);
    const decisions = lifecycleCalls(port).filter(([url]) => String(url).endsWith("/decide"));
    expect(decisions).toHaveLength(1);
    // The persisted wire is unchanged. No second decision/delivery on replay.
    expect(JSON.stringify(messages)).toBe(stored);
  });

  it.each(["chat_thread", "run_card"] as const)("%s retains its original cookie host and transport", async (host) => {
    const port = service(); const { container } = render(<LifecycleCardSurfaceProvider host={host}><AgenticRunPanel {...props()} /></LifecycleCardSurfaceProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lifecycleCalls(port).some(([url]) => String(url).endsWith("/decide"))).toBe(true));
    expect(container.querySelector(CARD)?.getAttribute("data-lifecycle-card-host")).toBe(host);
    for (const [, init] of lifecycleCalls(port)) { expect(init?.credentials).toBe("same-origin"); expect(init?.headers).not.toHaveProperty("X-Cinatra-Widget-User-Token"); }
  });
});
