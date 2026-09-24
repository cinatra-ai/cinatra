// @vitest-environment jsdom
/**
 * A RUN STARTED INSIDE A THIRD-PARTY APPLICATION SHOWS ITS REVIEW THERE
 * (cinatra#3051).
 *
 * The sibling file `agentic-run-panel.review-slot.test.tsx` pins the slot on the
 * first-party surfaces. This one pins it on the host that had nothing: a panel
 * drawn inside the site widget's own transcript. Until this change the panel
 * withheld the completed-run review on that host, and the injected delivery was
 * withheld too — on the ground that the run card would show the gate — so
 * NOTHING drew it and a finished run read as an output that could not be loaded.
 *
 * What is pinned here, on the REAL component, under a REAL widget declaration:
 *
 *   1. THE PLACEHOLDER IS KEPT while the run works and while a produced output's
 *      review has not opened yet — the same two readings the first-party hosts
 *      get, on this host too.
 *   2. THE REVIEW SCREEN DRAWS in the same slot, exactly once.
 *   3. IT IS A `site_widget` CARD. The nested mount re-declares the ambient host
 *      instead of shadowing it with `run_card`, so the card's own root says
 *      `site_widget`.
 *   4. IT ASKS WITH THE READER'S OWN PROOF. Both the RESOLVE and the DECIDE
 *      carry the broker headers and `credentials: "omit"` — never the ambient
 *      cookie of a frame that is same-origin to the app, and never a
 *      cookie-bound server action.
 *   5. THE MARKED-GATE PATH IS THE SAME. A run parked on its own review gate
 *      draws from that gate's ref, on the same host, with the same proof.
 *   6. A REFUSED DECLARATION IS NOT A WIDGET, and the panel says so honestly —
 *      the containment for that case lives one level up, where it can act.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.widget-review-slot.test.tsx
 */
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

// THE COOKIE-BOUND SERVER ACTIONS, kept as spies rather than removed. A widget
// card that reached for one of these would be asking the app to answer as
// whoever else is signed in on that browser, so "never called" is an assertion
// here, not a convenience.
const approveReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
const rejectReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../hitl-actions", () => ({ approveReviewTask, rejectReviewTask }));

// THE A2A SNAPSHOT ACTION, a hoisted spy for the same reason: it is a
// cookie-session server action, so "never called on this host" is a reading.
const getAgentBuilderTask = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask }));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3051",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

// THE RUN STREAM, kept as a hoisted spy rather than an anonymous mock: whether
// this panel OPENS it on a given host is one of the readings pinned below.
const useAgUiRunStream = vi.hoisted(() =>
  vi.fn((_runId: string, _options: { enabled: boolean }) => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
);
vi.mock("../use-ag-ui-run-stream", () => ({ useAgUiRunStream }));

import {
  LifecycleCardSurfaceProvider,
  LIFECYCLE_VIEW_RESOLVE_PATH,
} from "../lifecycle-card-runtime";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "../review-gate-card";

const RUN_ID = "run-3051";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";
const APPROVE = '[data-action="approve-review -> resolved"]';

/** The embed's own declaration. The values are structural, not real. */
const WIDGET_AUTH = {
  headers: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }),
  credentials: "omit" as const,
};
const WIDGET_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

const onWidget = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={WIDGET_FRAME}>
    {children}
  </LifecycleCardSurfaceProvider>
);

/** A widget declaration the runtime REFUSES — the mis-wired mount. */
const onRefusedWidget = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="site_widget">{children}</LifecycleCardSurfaceProvider>
);

type Call = { url: string; init: RequestInit };

/**
 * One fetch stub for the run's seed read, the card's resolve and the card's
 * decision. `run` supplies the seed body and can change between ticks; `state`
 * supplies the gate's state and can change after a decision lands.
 */
function stubFetch(
  run: () => Record<string, unknown>,
  state: () => Record<string, unknown>,
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(run()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
      // The route's own answer shape — the card refuses anything else, so a
      // stub that got it wrong would prove the transport and nothing after it.
      return new Response(
        JSON.stringify({
          outcome: { kind: "decided", disposition: "approve", idempotent: false },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({ kind: "artifact_review_gate", state: state(), body: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const PENDING = { state: "pending", canDecide: true, canComment: true };

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false },
    ...over,
  };
}

function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    templateId: "tmpl-3051",
    surface: "chat" as "agent-detail" | "chat",
    ...over,
  };
}

/** Lower-cased header map of a recorded call. */
function headersOf(init: RequestInit): Record<string, string> {
  const raw = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

/** Every lifecycle call the card made — the resolve and the decide, never the
 *  run's own seed read, which is the wrapper's business and not this card's. */
function lifecycleCalls(calls: Call[], path: string): Call[] {
  return calls.filter((c) => c.url === path);
}

/** The one assertion both halves of the credential rail share. */
function expectBrokered(call: Call | undefined, what: string) {
  expect(call, `${what} was never issued`).toBeDefined();
  const headers = headersOf(call!.init);
  expect(headers["authorization"], what).toBe("Bearer cit_site");
  expect(headers["x-cinatra-widget-user-token"], what).toBe("cwu_user");
  expect(call!.init.credentials, what).toBe("omit");
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  approveReviewTask.mockClear();
  rejectReviewTask.mockClear();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the placeholder, on the widget", () => {
  it("draws while the run works — the card's name and its centred arc", async () => {
    stubFetch(() => seedBody(), () => PENDING);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({ initialReviewGate: { ref: null, awaiting: false } })}
        />,
      ),
    );

    const placeholder = await waitFor(() => {
      const el = document.querySelector(PLACEHOLDER);
      if (!el) throw new Error("no placeholder");
      return el;
    });
    expect(placeholder.querySelector("svg.animate-spin")).not.toBeNull();
    // The same card the run page draws, named the same way (cinatra#3051): the
    // widget mounts the one component, so the drawing reaches both hosts at
    // once. The anatomy itself is pinned in
    // `review-gate-placeholder-as-drawn.test.tsx`.
    expect(placeholder.textContent).toBe("Agentic Run Progress");
    expect(placeholder.querySelector('[data-conformance-id="review-gate-loading"]')).toBeNull();
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "working",
    );
    expect(document.querySelector("[data-run-completion]")).toBeNull();
  });

  it("holds while a produced output's review has not opened yet", async () => {
    // The run is done and the outbox says a review is still coming. On the
    // widget this used to fall straight through to the completion notice —
    // "Its output could not be loaded here" — which is the reading #3051 is about.
    stubFetch(
      () => seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } }),
      () => PENDING,
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: "completed",
            agentId: "cinatra-ai/blog-draft-writer-agent",
            initialReviewGate: { ref: null, awaiting: true },
          })}
        />,
      ),
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector("[data-run-completion]")).toBeNull();
  });
});

describe("the review screen, on the widget", () => {
  it("replaces the placeholder in the same slot, exactly once, on this host", async () => {
    let body = seedBody();
    const calls = stubFetch(() => body, () => PENDING);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({ initialReviewGate: { ref: null, awaiting: false } })}
        />,
      ),
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector(REVIEW_CARD)).toBeNull();

    body = seedBody({
      status: "completed",
      reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
    });

    const card = await waitFor(
      () => {
        const el = document.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review screen did not arrive");
        return el;
      },
      { timeout: 10_000 },
    );

    // THE SAME SLOT, and the placeholder is gone.
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
    expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    // EXACTLY ONE card, and it belongs to the widget rather than to a shadowing
    // `run_card` declaration.
    expect(
      document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
    ).toBe(1);
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    // AND IT ASKED WITH THE READER'S OWN PROOF.
    const resolves = lifecycleCalls(calls, LIFECYCLE_VIEW_RESOLVE_PATH);
    expectBrokered(resolves[0], "the resolve");
    for (const call of resolves) {
      expect(call.init.credentials).toBe("omit");
    }
  }, 20_000);

  it("posts the DECISION on the same proof, and never through a cookie-bound action", async () => {
    let state: Record<string, unknown> = PENDING;
    const calls = stubFetch(
      () =>
        seedBody({
          status: "completed",
          reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
        }),
      () => state,
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: "completed",
            initialReviewGate: { ref: "lcr-opaque-3051", awaiting: false },
          })}
        />,
      ),
    );

    const approve = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(APPROVE);
      if (!el) throw new Error("no decision bar");
      return el;
    });
    state = { state: "settled", outcome: "approved" };
    fireEvent.click(approve);

    await waitFor(() =>
      expect(lifecycleCalls(calls, LIFECYCLE_VIEW_DECIDE_PATH).length).toBeGreaterThan(0),
    );
    expectBrokered(lifecycleCalls(calls, LIFECYCLE_VIEW_DECIDE_PATH)[0], "the decide");
    // The cookie-bound path was not taken, on either affordance.
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(rejectReviewTask).not.toHaveBeenCalled();
    // And the settled reading arrives in the same card.
    await waitFor(() =>
      expect(
        document.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-state"),
      ).toBe("settled"),
    );
    expect(
      document.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-host"),
    ).toBe("site_widget");
  }, 20_000);

  it("the MARKED gate draws from its own ref, on this host and on this proof", async () => {
    const calls = stubFetch(
      () =>
        seedBody({
          status: "pending_approval",
          reviewGate: { ref: "lcr-from-slot", awaiting: false },
        }),
      () => PENDING,
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: "pending_approval",
            initialHitlContext: {
              xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
              childRunId: null,
              reviewTaskId: "review-task-3051",
              inputSchema: { type: "object" },
              currentValues: { lifecycleCardRef: "lcr-parked-gate" },
            },
            initialReviewGate: { ref: "lcr-from-slot", awaiting: false },
          })}
        />,
      ),
    );

    const card = await waitFor(() => {
      const el = document.querySelector(REVIEW_CARD);
      if (!el) throw new Error("no card");
      return el;
    });
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    const resolves = lifecycleCalls(calls, LIFECYCLE_VIEW_RESOLVE_PATH);
    expectBrokered(resolves[0], "the marked gate's resolve");
    const asked = resolves.map((c) => String(c.init.body ?? ""));
    expect(asked.some((b) => b.includes("lcr-parked-gate"))).toBe(true);
    expect(asked.some((b) => b.includes("lcr-from-slot"))).toBe(false);
  }, 20_000);
});

describe("a widget declaration the runtime refused", () => {
  // A REFUSED DECLARATION IS INDISTINGUISHABLE FROM NO HOST, from inside here.
  // The runtime publishes NO host and NO credential for a `site_widget` mount
  // that dropped its `auth`, which is exactly what the run page — a surface with
  // no conversation provider at all — publishes. So the panel reads its own
  // `run_card`, and that is the honest reading rather than a guess: the panel
  // cannot invent a distinction the runtime deliberately does not draw.
  //
  // WHICH IS WHY THE CONTAINMENT IS NOT HERE. The wrapper that mounts this panel
  // inside a conversation asks the same question with the three-state answer
  // (`useConversationCredential`) and, on a refusal, issues NO request and mounts
  // NO panel — pinned in `packages/chat/src/__tests__/`'s own
  // `inline-agent-run-card-credential.test.tsx`. A mis-wired widget therefore
  // never reaches this component, and this pin exists so that the day the
  // wrapper's refusal is weakened, the reading it was covering is written down.
  it("is read as the panel's own host, and its containment is the wrapper's", async () => {
    stubFetch(
      () =>
        seedBody({
          status: "completed",
          reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
        }),
      () => PENDING,
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onRefusedWidget(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: "completed",
            initialReviewGate: { ref: "lcr-opaque-3051", awaiting: false },
          })}
        />,
      ),
    );

    const card = await waitFor(() => {
      const el = document.querySelector(REVIEW_CARD);
      if (!el) throw new Error("no card");
      return el;
    });
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
  }, 20_000);
});

describe("the run's own status, on a host that does not ask with a cookie", () => {
  // THE READING THIS DEFECT PRODUCED: a run parked for review while the page was
  // open drew NO review slot at all — for twelve consecutive samples, sixteen
  // seconds after the gate was minted — and only a re-open of the third-party
  // page brought the card. A re-open is not a fix; it is a fresh mount reading a
  // fresh server seed.
  //
  // WHY. The panel's live status comes from the app's own run stream, and that
  // stream is a COOKIE-SESSION transport: an `EventSource` to a same-origin
  // route that answers only a session cookie, with no way to carry a broker
  // credential. Inside the widget there is no such session, so the stream never
  // delivers — and while the stream is enabled the poll tick's status write is
  // suppressed in its favour. The status therefore stayed at the seed value for
  // ever, and the review slot is only read once the run reads `completed`.
  //
  // So on this host the stream stands down and the run is read on the tick,
  // through the surface's OWN reader — the same credential the seed and the
  // slot already travel on.
  it("carries a run that parks while the page is open into its review, in place", async () => {
    let body = seedBody();
    stubFetch(() => body, () => PENDING);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            agUiEnabled: true,
            initialReviewGate: { ref: null, awaiting: false },
          })}
        />,
      ),
    );

    // The placeholder is in the slot the moment the run is working.
    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector(REVIEW_CARD)).toBeNull();

    // The run parks. NOTHING re-mounts and nothing re-opens: the same page
    // instance, the same slot, the panel's own cadence.
    body = seedBody({
      status: "completed",
      reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
    });

    const card = await waitFor(
      () => {
        const el = document.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review slot stayed empty on the open page");
        return el;
      },
      { timeout: 10_000 },
    );
    expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
  }, 20_000);

  it("opens no cookie-session stream on this host", async () => {
    stubFetch(() => seedBody(), () => PENDING);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(onWidget(<AgenticRunPanel {...panelProps({ agUiEnabled: true })} />));

    await waitFor(() => expect(useAgUiRunStream).toHaveBeenCalled());
    for (const [, options] of useAgUiRunStream.mock.calls) {
      expect((options as { enabled: boolean }).enabled).toBe(false);
    }
  }, 20_000);

  it("leaves the stream exactly as it was on a first-party mount", async () => {
    // The rule is about the CREDENTIAL, not about the run: a surface that does
    // ask with a cookie keeps the live stream it has always had.
    stubFetch(() => seedBody(), () => PENDING);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...panelProps({ agUiEnabled: true })} />);

    await waitFor(() => expect(useAgUiRunStream).toHaveBeenCalled());
    expect(
      useAgUiRunStream.mock.calls.some(
        ([, options]) => (options as { enabled: boolean }).enabled === true,
      ),
    ).toBe(true);
  }, 20_000);

  it("reads the run through the surface's own reader, never the ambient cookie", async () => {
    const calls = stubFetch(
      () => seedBody({ status: "completed", reviewGate: { ref: "lcr-opaque-3051", awaiting: false } }),
      () => PENDING,
    );
    const readRunSnapshot = vi.fn(async () => ({
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: null,
      reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
    }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            agUiEnabled: true,
            initialStatus: "running",
            readRunSnapshot,
            // The widget hands BOTH of its reads down; neither may fall back
            // to the same-origin route.
            readReviewSlot: async () => ({ ref: "lcr-opaque-3051", awaiting: false }),
            initialReviewGate: { ref: null, awaiting: false },
          })}
        />,
      ),
    );

    await waitFor(() => expect(readRunSnapshot).toHaveBeenCalled(), { timeout: 10_000 });
    // The panel's own tick asked the reader and NOT the same-origin route, whose
    // answer on a frame same-origin to the app is whoever else is signed in.
    expect(calls.filter((c) => c.url.includes("/api/agents/runs/"))).toEqual([]);
  }, 20_000);

  it("asks the surface's reader even when the run carries an a2a task id", async () => {
    // THE READING THE FIRST FIX MISSED: a widget run carries a task id like any
    // other, and the a2a snapshot action is cookie-session. Keying the transport
    // on the task id sent exactly these runs back down the ambient-cookie path
    // and left their status frozen — the defect this leg exists to remove.
    getAgentBuilderTask.mockClear();
    const calls = stubFetch(
      () => seedBody({ status: "completed", reviewGate: { ref: "lcr-opaque-3051", awaiting: false } }),
      () => PENDING,
    );
    const readRunSnapshot = vi.fn(async () => ({
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: null,
      reviewGate: { ref: "lcr-opaque-3051", awaiting: false },
    }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            agUiEnabled: true,
            initialStatus: "running",
            taskId: "a2a-task-3051",
            readRunSnapshot,
            readReviewSlot: async () => ({ ref: "lcr-opaque-3051", awaiting: false }),
            initialReviewGate: { ref: null, awaiting: false },
          })}
        />,
      ),
    );

    await waitFor(() => expect(readRunSnapshot).toHaveBeenCalled(), { timeout: 10_000 });
    expect(getAgentBuilderTask).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.url.includes("/api/agents/runs/"))).toEqual([]);
    await waitFor(
      () => {
        const el = document.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review slot stayed empty on the open page");
        return el;
      },
      { timeout: 10_000 },
    );
  }, 20_000);
});
