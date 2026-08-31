// @vitest-environment jsdom
/**
 * THE INPUT FORM IS A STEP'S SCREEN, NOT A PROGRESS PANEL (cinatra#3068).
 *
 * THE DEFECT, on the surface the issue names. A run parked on the blog draft
 * writer's own "Idea" form was drawn inside a section headed "Agentic Run
 * Progress" with the "Awaiting input" badge beside it and NO step list — a
 * progress panel over a run that has not produced any progress, while every
 * later moment of the same run reads as a step: an entry in the rail, the
 * step's own screen in the detail column.
 *
 * WHAT THE FIX MOVES, and what it deliberately does not. The form is unchanged:
 * the same one editable Idea control and the same Continue that
 * `agentic-run-panel.single-idea-field.test.tsx` pins, mounted by the same card.
 * What goes is the heading over it, and only where the page's rail has taken
 * the step over (`inputStepInRail`). A host that draws no rail — the chat
 * thread's run card — passes nothing and keeps the panel it has always had,
 * which `agentic-run-panel.chat-lifecycle.test.tsx` still pins.
 *
 * Harness mirrors agentic-run-panel.single-idea-field.test.tsx.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/agentic-run-panel.input-step-in-rail.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
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
    ownKeys: () => [
      "ArrowRight",
      "Check",
      "CheckCircle2",
      "ChevronDown",
      "Circle",
      "CircleDot",
      "ClipboardList",
      "ExternalLink",
      "Loader2",
      "XCircle",
      "default",
    ],
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
    runId: "run-3068",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => streamResultFor()),
}));

/** The `idea` property blog-draft-writer-agent's OAS compiles to. */
const SHIPPED_IDEA_SCHEMA = {
  type: "object",
  title: "idea",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    outline: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
  "x-object-text-property": "title",
  "x-multiline": true,
  "x-placeholder": "What should this post be about?",
};

/** An AG-UI stream result parked on the `setup-` gate that collects `idea`. */
function streamResultFor() {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: SHIPPED_IDEA_SCHEMA,
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-3068",
      fieldName: "idea",
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-3068",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-3068",
};

async function renderPanel(extra: Record<string, unknown> = {}) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <AgenticRunPanel {...PANEL_PROPS} surface="agent-detail" {...extra} />,
  );
}

function progressHeading(): HTMLElement | null {
  return Array.from(document.querySelectorAll("h2")).find((h) =>
    /Agentic Run Progress/i.test(h.textContent ?? ""),
  ) ?? null;
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the run page's first step (cinatra#3068)", () => {
  it("draws the input form with NO Agentic Run Progress panel over it", async () => {
    const view = await renderPanel({ inputStepInRail: true });

    await waitFor(() =>
      expect(view.container.querySelector("#field-idea")).not.toBeNull(),
    );
    // The step-less panel's title and its "Awaiting input" badge are gone —
    // the rail beside this panel names the step instead.
    expect(progressHeading()).toBeNull();
    expect(document.body.textContent).not.toMatch(/Agentic Run Progress/i);
    expect(document.body.textContent).not.toMatch(/Awaiting input/i);
  });

  it("leaves the form itself untouched — one Idea control and its Continue", async () => {
    const view = await renderPanel({ inputStepInRail: true });

    await waitFor(() =>
      expect(view.container.querySelector("#field-idea")).not.toBeNull(),
    );
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("input, textarea, select"),
    ).filter((el) => !(el instanceof HTMLInputElement && el.type === "hidden"));
    expect(controls).toHaveLength(1);
    expect(controls[0].id).toBe("field-idea");
    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        /continue/i.test(b.textContent ?? ""),
      ),
    ).toBe(true);
  });

  it("keeps the panel exactly as it was for a host that draws no rail", async () => {
    // The chat thread's run card, and every other caller that passes nothing.
    const view = await renderPanel();

    await waitFor(() =>
      expect(view.container.querySelector("#field-idea")).not.toBeNull(),
    );
    expect(progressHeading()).not.toBeNull();
  });
});

/**
 * THE DETAIL IS THE FORM ALONE (cinatra#3068, fix leg 2).
 *
 * The graded picture of the input moment showed the run-progress line
 * "No messages yet." stacked under the form, in the step's own detail column.
 * The ratified drawing, in the section that draws this surface: "One page per
 * gate — the step's own card, and nothing else. Selecting a step opens that
 * step's page in the run detail, and the page carries the one card of the step
 * it belongs to ... two cards are never stacked in one detail."
 */
describe("the input step's detail carries the step's own card and nothing else", () => {
  it("draws no run-progress line under the form", async () => {
    const view = await renderPanel({ inputStepInRail: true });

    await waitFor(() =>
      expect(view.container.querySelector("#field-idea")).not.toBeNull(),
    );
    expect(document.body.textContent).not.toMatch(/No messages yet/i);
    expect(document.body.textContent).not.toMatch(/Waiting to start/i);
  });

  it("keeps the run-progress line for a host that draws no rail", async () => {
    // The chat thread's run card is unchanged: the panel there is a progress
    // panel and says so when it has nothing to report.
    const view = await renderPanel();

    await waitFor(() =>
      expect(view.container.querySelector("#field-idea")).not.toBeNull(),
    );
    expect(document.body.textContent).toMatch(/No messages yet/i);
  });
});
