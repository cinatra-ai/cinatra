// @vitest-environment jsdom
/**
 * THE RUN LIFECYCLE PLAYS OUT IN THE CONVERSATION (cinatra#2729).
 *
 * Two owner-ruled properties of `AgenticRunPanel`, both driven through the real
 * component so the assertion is on the surface the operator sees:
 *
 *   1. A paused run whose gate the SERVER already derived renders its own
 *      actionable form on the FIRST paint — never the formless "Run paused —
 *      awaiting human approval" banner. That banner appearing on one entry path
 *      and the form on another is defect 2 of the issue.
 *   2. A run that finishes in a conversation renders its completion card there,
 *      linking the artifact it produced, and WITHOUT the "Start new run" button
 *      (which navigates out of the conversation).
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.chat-lifecycle.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The working placeholder's arc (cinatra#3051) — presence only; its anatomy
  // is pinned in `review-gate-placeholder-as-drawn.test.tsx`.
  SpinnerArc: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));

// "Start new run" routes with the app router, which no test tree mounts.
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

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2729",
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
  confirmRunRecommendationAction: vi.fn(
    async (_input: Record<string, unknown>) => ({ ok: true, dispatched: true }),
  ),
  skipRunRecommendationAction: vi.fn(
    async (_input: Record<string, unknown>) => ({ ok: true, dispatched: true }),
  ),
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

// No live stream on either case below: the seed and the terminal status are
// what these pins are about, and a stream would supply its own values.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

/** The `idea` field the blog-draft agent's setup gate collects. */
const IDEA_SCHEMA = {
  type: "object",
  title: "idea",
  properties: { title: { type: "string" } },
  required: ["title"],
  "x-object-text-property": "title",
  "x-multiline": true,
};

/** What the server derives for a run parked on that setup gate. */
const SEEDED_SETUP_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: "setup-run-2729",
  inputSchema: IDEA_SCHEMA,
  currentValues: {},
  fieldName: "idea",
};

const BANNER_TEXT = /Run paused — awaiting human approval/i;

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  readRunOutputEvidence.mockReset();
  // The recommendation hold is READ on every mount (the card asks the core, on
  // every host). Default it to "no matching skills" so only the suite that is
  // about the hold has to say otherwise.
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a server-derived gate paints the form, not the banner (defect 2)", () => {
  async function renderSeeded(surface: "chat" | "agent-detail") {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        surface={surface}
        initialHitlContext={SEEDED_SETUP_GATE}
      />,
    );
  }

  it.each([["agent-detail" as const], ["chat" as const]])(
    'surface="%s" — the setup field renders and the formless banner does not',
    async (surface) => {
      await renderSeeded(surface);

      await waitFor(() =>
        expect(document.querySelector("#field-idea")).not.toBeNull(),
      );
      expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    },
  );

  it("still shows the recovery banner when NO gate was derived", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        surface="agent-detail"
      />,
    );

    expect(await screen.findByText(BANNER_TEXT)).not.toBeNull();
  });
});

describe("a run that finishes in the conversation shows its artifact there", () => {
  async function renderCompleted(surface: "chat" | "agent-detail") {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        agentId="cinatra-ai/blog-draft-writer-agent"
        templateId="tmpl-2729"
        surface={surface}
      />,
    );
  }

  beforeEach(() => {
    readRunOutputEvidence.mockResolvedValue({
      ok: true,
      outputs: [{ id: "art-1", title: "Draft: human purpose" }],
      hasTranscript: false,
      hasStepResults: false,
      outputsUnavailable: false,
      unlinkableOutputs: 0,
    });
  });

  it("renders the completion card with the produced artifact link in chat", async () => {
    await renderCompleted("chat");

    const link = await screen.findByText("Draft: human purpose");
    expect(link.getAttribute("href")).toBe("/artifacts/art-1");
  });

  it("leaves out Start new run in chat — it navigates out of the conversation", async () => {
    await renderCompleted("chat");

    await screen.findByText("Draft: human purpose");
    expect(screen.queryByText(/Start new run/i)).toBeNull();
  });

  it("keeps Start new run on the run page", async () => {
    await renderCompleted("agent-detail");

    await screen.findByText("Draft: human purpose");
    expect(screen.queryByText(/Start new run/i)).not.toBeNull();
  });
});


// ---------------------------------------------------------------------------
// THE CORE'S REVIEW LIFECYCLE TAKES OVER (cinatra#2729)
// ---------------------------------------------------------------------------
//
// When a run produces an artifact that needs review, `execution.ts` mints the
// gate's server-side `lifecycleCardRef` and emits the marked artifact-review
// interrupt; the run parks on it. From that moment the presentation is the
// CORE's: every first-party host draws `ReviewGateCard`, which resolves the
// gate from the ref and brings its own surfaces with it — the target through
// the island, the suggestion chips, the decision floor.
//
// The conversation is one of those hosts. Nothing here draws a review of its
// own, and nothing here strips what the card brings: the panel's job is to
// mount the core card under the `run_card` host and get out of the way. These
// pins are on the CORE component's own anchors, not on any copy of its markup.
const ARTIFACT_REVIEW_GATE = {
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  childRunId: null,
  reviewTaskId: "review-task-2729",
  inputSchema: { type: "object" },
  currentValues: {
    reviewTaskId: "review-task-2729",
    reviewSurfaceUrl:
      "/agents/cinatra-ai/blog-draft-writer-agent/run-2729/review/review-task-2729",
    // The server-minted ref. The card is only ever addressed by this.
    lifecycleCardRef: "lcr-opaque-2729",
    targetCount: 1,
    agentSummary: "",
  },
};

describe("the core's review lifecycle takes over in the conversation", () => {
  /**
   * The card resolves its own gate from the ref, through the lifecycle resolve
   * route, and draws nothing before the server answers — so the pin has to let
   * the core's own request succeed rather than assert against a half-mounted
   * card. This is the same stub the core's own lifecycle-card suite uses.
   */
  function mockResolve() {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            // The per-kind resolve envelope (epic S9, slice S9c). The review
            // kind carries state and no body; a body beside it is refused.
            kind: "artifact_review_gate",
            state: { state: "pending", canDecide: true, canComment: true },
            body: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function renderGate(surface: "chat" | "agent-detail") {
    mockResolve();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        surface={surface}
        initialHitlContext={ARTIFACT_REVIEW_GATE}
      />,
    );
  }

  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" mounts the CORE review gate card',
    async (surface) => {
      await renderGate(surface);

      const card = await waitFor(() => {
        const el = document.querySelector(
          '[data-conformance-id="review-gate-card"]',
        );
        if (!el) throw new Error("core card not mounted");
        return el;
      });
      expect(card.getAttribute("data-lifecycle-card")).toBe(
        "artifact_review_gate",
      );
    },
  );

  it("declares the run_card lifecycle host, so the card knows its surface", async () => {
    await renderGate("chat");

    const card = await waitFor(() => {
      const el = document.querySelector(
        '[data-conformance-id="review-gate-card"]',
      );
      if (!el) throw new Error("core card not mounted");
      return el;
    });
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
  });

  it("draws NO review of its own beside the core card", async () => {
    await renderGate("chat");

    await waitFor(() => {
      if (!document.querySelector('[data-conformance-id="review-gate-card"]')) {
        throw new Error("core card not mounted");
      }
    });
    // No completion card, no output list, no hand-built target: at a gate the
    // conversation shows the core's screen and nothing else.
    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(document.querySelector("[data-run-outputs]")).toBeNull();
    expect(document.querySelector("[data-run-output-target]")).toBeNull();
    // And not the formless approval banner either.
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// THE CORE'S OTHER LIFECYCLE SCREENS REACH THE CONVERSATION TOO (cinatra#2729)
// ---------------------------------------------------------------------------
//
// Two screens the run panel does not own, and must not narrow:
//
//   SKILL RECOMMENDATION — the run-start hold. The card is fail-closed on the
//   HOST DECLARATION and nothing else: "a declared host draws it — the
//   per-surface matrix that withheld this card from the widget is gone"
//   (run-recommendation-chip-row.tsx, RecommendationHoldCard). Its one
//   exception is credential-keyed, not a surface rule, and the state reader is
//   documented for "the chat-mounted run panel … the SAME shared chip-row
//   serves chat" (run-recommendation-actions.ts). The panel declares the
//   `run_card` host wherever no OUTER lifecycle host already owns the card, so
//   a matching hold draws in a conversation — from whichever mount owns it
//   there. See the ambient-host pin at the bottom of this file for that rule.
//
//   AUDIT — there is no audit screen in this tree to surface, on any host. The
//   auditor agent is retired at exact zero
//   (reviewer-auditor-retirement-identity.test.ts), its panel button is
//   forbidden by a ratchet (agentic-run-panel.no-audit-button.test.tsx), and
//   the successor lane says plainly that rendering its suggestions is a slice
//   that has not shipped: "It mints no decision surface … rendering them is
//   S6c" (lifecycle-suggestion-producer-lane.ts). The panel comment claiming a
//   field-renderer mount is stale. So the pin below cannot assert an audit
//   screen; what it holds is the property that would carry one when that slice
//   lands — the shared gate-renderer branch is surface-BLIND, so a flow gate's
//   renderer draws identically in a conversation and on the run page.
//
// Neither pin invents a gate. They state the core's own decision and prove the
// conversation mount does not narrow it.
//
// A CHAT-STARTED RUN NOW REACHES THIS MOUNT. This note used to say the
// opposite, and it was true when it was written: the chat pre-router created
// its run through `agent_run`, which stamped no `humanPresent` and never called
// `maybeHoldRunForRecommendation`, so the decision short-circuited at the
// headless branch and the mount below sat ready for a hold nothing handed it.
//
// The primitive now derives the launch origin from the verified frame, creates
// a chat-started run `pending_input`, and evaluates the hold BEFORE dispatch —
// so a held chat run arrives here parked, in a conversation. The pin at the
// bottom of this block covers that state, and the handler's own state path is
// proved in chat-origin-recommendation-hold.test.ts.
const HELD_RECOMMENDATION = {
  state: "held" as const,
  agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
  promptText: "draft a blog post",
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ],
  holdRef: "hold-ref-2729",
  canDecide: true,
};

describe("the skill-recommendation screen reaches the conversation", () => {
  beforeEach(() => {
    getRunRecommendationHoldStateAction.mockReset();
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD_RECOMMENDATION);
  });

  async function renderRun(
    surface: "chat" | "agent-detail",
    initialStatus = "running",
  ) {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus={initialStatus}
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        surface={surface}
      />,
    );
  }

  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" draws the core recommendation card when skills match',
    async (surface) => {
      await renderRun(surface);

      await waitFor(() => {
        if (!document.querySelector('[data-conformance-id="run-chip-row"]')) {
          throw new Error("recommendation card not drawn");
        }
      });
      // REDRAWN to the ratified §V drawing (cinatra#2841): the heading plate this
      // used to name is gone — the row IS the card. What proves the card reached
      // the conversation is the chip the reader shapes the run with.
      expect(screen.queryByText(/Confirm the skills for this run/i)).toBeNull();
      const chip = document.querySelector('[data-recommendation-chip]');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain("Blog content");
      expect(chip?.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(chip?.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(chip?.querySelector('[data-skill-action="skip"]')).not.toBeNull();
    },
  );

  it("asks the core for the hold on the chat mount, with this run's id", async () => {
    await renderRun("chat");

    await waitFor(() => {
      if (getRunRecommendationHoldStateAction.mock.calls.length === 0) {
        throw new Error("hold not read");
      }
    });
    expect(getRunRecommendationHoldStateAction).toHaveBeenCalledWith({
      runId: "run-2729",
    });
  });

  // The state a chat-started run now actually arrives in. The primitive creates
  // it `pending_input`, evaluates the hold, and — when it fires — leaves it
  // there with nothing queued behind it. So the card has to draw for THAT
  // status, in a conversation, and its two buttons have to reach the canonical
  // release rather than any chat-local shortcut. Confirm and Skip both go to
  // the same server actions the run page uses, which is what makes the run
  // dispatch through `triggerAgentRun` once the park is released.
  it("draws the held card for a chat-started run parked in pending_input", async () => {
    await renderRun("chat", "pending_input");

    await waitFor(() => {
      if (!document.querySelector('[data-conformance-id="run-chip-row"]')) {
        throw new Error("recommendation card not drawn for a parked chat run");
      }
    });
    // RE-ANCHORED to the ratified §V drawing (cinatra#2841), same guarantee.
    // This used to read the heading plate's question back — the plate was the
    // human-readable proof the card had drawn its HELD content in the panel
    // rather than an empty marker node. §V deleted the plate ("the row IS the
    // whole card"), so that proof moves onto the row's own root and its chips,
    // exactly as the sibling case above was re-anchored. Asserted negatively
    // too, so the old drawing cannot creep back.
    expect(screen.queryByText(/Confirm the skills for this run/i)).toBeNull();

    const row = document.querySelector('[data-conformance-id="run-chip-row"]');
    expect(row).not.toBeNull();
    // Still the HELD reading this case is named for.
    expect(row?.getAttribute("data-lifecycle-card-state")).toBe("held");
    // ONE declaring root in the panel — the contract the wrapper removal fixed.
    // The panel renders the row directly and now carries the declaration itself.
    expect(
      document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]'),
    ).toHaveLength(1);
    expect(row?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");

    // What the reader shapes the run with, inside that one root.
    const chip = row?.querySelector("[data-recommendation-chip]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Blog content");
    expect(chip?.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
    expect(chip?.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
    expect(chip?.querySelector('[data-skill-action="skip"]')).not.toBeNull();
  });

  it("resolves Confirm through the canonical release action", async () => {
    await renderRun("chat", "pending_input");

    await waitFor(() => {
      if (!screen.queryByRole("button", { name: /^Confirm$/ })) {
        throw new Error("Confirm not drawn");
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => {
      if (confirmRunRecommendationAction.mock.calls.length === 0) {
        throw new Error("Confirm did not reach the release action");
      }
    });
    expect(confirmRunRecommendationAction.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-2729",
      holdRef: "hold-ref-2729",
    });
  });

  it("resolves Skip through the canonical release action", async () => {
    await renderRun("chat", "pending_input");

    await waitFor(() => {
      if (!screen.queryByRole("button", { name: /^Skip$/ })) {
        throw new Error("Skip not drawn");
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Skip$/ }));

    await waitFor(() => {
      if (skipRunRecommendationAction.mock.calls.length === 0) {
        throw new Error("Skip did not reach the release action");
      }
    });
    expect(skipRunRecommendationAction.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-2729",
      holdRef: "hold-ref-2729",
    });
  });

  it("draws nothing when the core reports no matching skills", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
    await renderRun("chat");

    await waitFor(() => {
      if (getRunRecommendationHoldStateAction.mock.calls.length === 0) {
        throw new Error("hold not read");
      }
    });
    expect(
      document.querySelector('[data-conformance-id="run-chip-row"]'),
    ).toBeNull();
  });
});

describe("a flow gate's renderer is surface-blind (what would carry an audit screen)", () => {
  // There is no audit renderer in this tree to mount (see the header note); a
  // stand-in gate renderer holds the branch property instead, so the day S6c
  // ships one, nothing on this surface narrows it.
  const AUDITOR_FLOW_RENDERER = "cinatra.flow-gate-stub";

  function AuditorStub() {
    return <div data-testid="auditor-flow-screen">Audit</div>;
  }

  async function renderAuditGate(surface: "chat" | "agent-detail") {
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: AUDITOR_FLOW_RENDERER,
      priority: 100,
      condition: (_f, schema) =>
        (schema as { ["x-renderer"]?: string })["x-renderer"] ===
        AUDITOR_FLOW_RENDERER,
      renderer: AuditorStub as unknown as Parameters<
        typeof fieldRendererRegistry.register
      >[0]["renderer"],
    });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        surface={surface}
        initialHitlContext={{
          xRenderer: AUDITOR_FLOW_RENDERER,
          childRunId: null,
          reviewTaskId: "auditor-task-2729",
          inputSchema: {
            type: "object",
            "x-renderer": AUDITOR_FLOW_RENDERER,
            properties: {},
          },
          currentValues: {},
        }}
      />,
    );
  }

  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" mounts the flow gate\'s own renderer, unnarrowed',
    async (surface) => {
      await renderAuditGate(surface);

      expect(await screen.findByTestId("auditor-flow-screen")).not.toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// ONE CARD PER TURN — the ambient-host rule.
//
// Inside a chat transcript this panel is a SIBLING of the conversation's own
// recommendation card, and both resolve the same run. An unconditional mount
// here therefore drew the card TWICE in one turn. The defect hid because only
// the SETTLED states rendered on both mounts: the held state self-gated to the
// chat card's turn, which made the duplication read as a settled-only quirk
// instead of what it was.
//
// The rule is one card per run per turn, in EVERY state: inside a `chat_thread`
// the chat card owns the recommendation and the panel draws none; with no outer
// lifecycle host — the run page — the panel keeps its own copy exactly as
// before. Gating on the AMBIENT host rather than on the `surface` prop is what
// makes the rule hold for any future embedder of this panel in a transcript,
// without that embedder having to remember a prop.
// ---------------------------------------------------------------------------
describe("the panel draws one recommendation card per turn, never two", () => {
  beforeEach(() => {
    getRunRecommendationHoldStateAction.mockReset();
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD_RECOMMENDATION);
  });

  async function renderPanelUnderHost(host: "chat_thread" | null) {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    const panel = (
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="pending_input"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-2729"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        surface="chat"
      />
    );
    return render(
      host === null ? (
        panel
      ) : (
        <LifecycleCardSurfaceProvider host={host}>{panel}</LifecycleCardSurfaceProvider>
      ),
    );
  }

  it("withholds its copy inside a chat_thread — the chat card owns the run there", async () => {
    await renderPanelUnderHost("chat_thread");

    // The panel still paints (its chrome is the run's progress), and the hold
    // read still happens for the chat card — what must not appear is a SECOND
    // recommendation card on this run's turn.
    await screen.findByText(/Agentic Run Progress/i);
    expect(document.querySelectorAll('[data-conformance-id="run-chip-row"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-lifecycle-card-host="run_card"]')).toHaveLength(0);
  });

  it("keeps its copy on the run page, where no outer host owns the card", async () => {
    await renderPanelUnderHost(null);

    await waitFor(() => {
      if (!document.querySelector('[data-conformance-id="run-chip-row"]')) {
        throw new Error("the run page lost its own recommendation card");
      }
    });
  });
});
