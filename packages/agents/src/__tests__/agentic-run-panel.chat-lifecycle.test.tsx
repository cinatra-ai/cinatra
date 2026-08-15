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
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
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

const { readRunOutputEvidence, getRunRecommendationHoldStateAction } = vi.hoisted(
  () => ({
    readRunOutputEvidence: vi.fn(),
    getRunRecommendationHoldStateAction: vi.fn(),
  }),
);
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
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
            state: { state: "pending", canDecide: true, canComment: true },
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
//   `run_card` host unconditionally, so a matching hold draws in a conversation.
//
//   AUDIT — "Audit visibility is driven by the auditor-agent flow gate;
//   renderer is mounted via field-renderer registry" (agentic-run-panel.tsx),
//   and the panel is forbidden a standalone Audit button of its own
//   (agentic-run-panel.no-audit-button.test.tsx). So the audit screen arrives
//   as a FLOW GATE and renders through the shared HITL renderer branch — the
//   branch below is pinned surface-blind, which is what carries it into chat.
//
// Neither pin invents a gate. They state the core's own decision and prove the
// conversation mount does not narrow it.
const HELD_RECOMMENDATION = {
  state: "held" as const,
  agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
  promptText: "draft a blog post",
  recommendations: [
    { id: "skill-blog", name: "Blog content", description: "", selected: true },
  ],
  holdRef: "hold-ref-2729",
};

describe("the skill-recommendation screen reaches the conversation", () => {
  beforeEach(() => {
    getRunRecommendationHoldStateAction.mockReset();
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD_RECOMMENDATION);
  });

  async function renderRun(surface: "chat" | "agent-detail") {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    return render(
      <AgenticRunPanel
        runId="run-2729"
        initialStatus="running"
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
      expect(screen.queryByText(/Confirm the skills for this run/i)).not.toBeNull();
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

describe("the audit screen's flow gate renders the same on both surfaces", () => {
  // The auditor flow gate is an ordinary xRenderer gate; its renderer ships in
  // the auditor extension, so this stands in for it with the same contract.
  const AUDITOR_FLOW_RENDERER = "cinatra.auditor-flow-stub";

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
    'surface="%s" mounts the flow gate\'s own renderer',
    async (surface) => {
      await renderAuditGate(surface);

      expect(await screen.findByTestId("auditor-flow-screen")).not.toBeNull();
    },
  );
});
