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

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
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
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const { readRunOutputEvidence } = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
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
