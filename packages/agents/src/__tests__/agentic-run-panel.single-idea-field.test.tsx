// @vitest-environment jsdom
/**
 * BOTH surfaces show exactly ONE editable Idea control.
 *
 * The canonical run page and the chat run card are the SAME component
 * (`AgenticRunPanel`, mounted with `surface="agent-detail"` and
 * `surface="chat"`), so this file drives the panel itself rather than the
 * renderer in isolation — a DOM-level assertion on the surface the operator
 * actually sees. The renderer-level pins live in
 * `schema-field-renderer-object-input.test.tsx` leg (c); the payload contract
 * lives in `single-idea-field-contract.test.ts`.
 *
 * Since cinatra#2729 the two surfaces do NOT differ: both carry the field's own
 * Continue button. The chat card used to hide it and expect the composer to
 * drive the gate; the owner ruled the run lifecycle plays IN the conversation,
 * so the card shows the control that continues it. The pin below states that
 * for both surfaces, and it does not affect the count of editable Idea
 * controls, which is what the owner ruled on earlier.
 *
 * Harness mirrors agentic-run-panel-hitl-field-label.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.single-idea-field.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
    runId: "run-bdwa40",
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

/**
 * The `idea` property blog-draft-writer-agent's OAS compiles to. Kept identical
 * to the fixture in the two sibling suites; `single-idea-field-contract.test.ts`
 * pins it against the REAL compiler so the three copies cannot drift silently.
 */
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
      reviewTaskId: "setup-run-bdwa40",
      fieldName: "idea",
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-bdwa40",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-bdwa40",
};

async function renderPanel(surface: "chat" | "agent-detail") {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(<AgenticRunPanel {...PANEL_PROPS} surface={surface} />);
}

/** Every control on the panel a user could type an input into. */
function editableControls(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("input, textarea, select"),
  ).filter((el) => {
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    if ("disabled" in el && (el as HTMLInputElement).disabled) return false;
    if ("readOnly" in el && (el as HTMLInputElement).readOnly) return false;
    return true;
  });
}

function labelTextFor(control: HTMLElement): string {
  const label = document.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`);
  return label?.textContent ?? "";
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Both surfaces, one battery: "agent-detail" is the canonical run page and
// "chat" is the in-conversation run card.
describe.each([["agent-detail" as const], ["chat" as const]])(
  'surface="%s" — the setup gate shows ONE Idea control',
  (surface) => {
    it("renders exactly one visible editable control, and its name is Idea", async () => {
      await renderPanel(surface);

      await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());

      const controls = editableControls();
      expect(controls).toHaveLength(1);
      expect(controls[0].id).toBe("field-idea");
      expect(labelTextFor(controls[0])).toMatch(/^Idea/);
    });

    it("shows NO Title / Summary / Outline controls", async () => {
      await renderPanel(surface);

      await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
      expect(document.querySelector("#field-title")).toBeNull();
      expect(document.querySelector("#field-summary")).toBeNull();
      expect(document.querySelector("#field-outline")).toBeNull();
      expect(document.body.textContent).not.toMatch(/One value per line/i);
    });

    it("keeps the typed text under the Idea label", async () => {
      await renderPanel(surface);

      await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
      const control = document.querySelector("#field-idea") as HTMLTextAreaElement;
      fireEvent.change(control, { target: { value: "human purpose in an age of agentic AI" } });
      expect(control.value).toBe("human purpose in an age of agentic AI");
      expect(labelTextFor(control)).toMatch(/^Idea/);
    });
  },
);

describe("both surfaces carry the Continue affordance (cinatra#2729)", () => {
  function hasContinueButton(): boolean {
    return Array.from(document.querySelectorAll("button")).some((b) =>
      /continue/i.test(b.textContent ?? ""),
    );
  }

  it("the run page carries the field's own Continue button", async () => {
    const view = await renderPanel("agent-detail");
    await waitFor(() => expect(view.container.querySelector("#field-idea")).not.toBeNull());
    expect(hasContinueButton()).toBe(true);
  });

  it("the chat card carries it too — the run is continued in the conversation", async () => {
    const view = await renderPanel("chat");
    await waitFor(() => expect(view.container.querySelector("#field-idea")).not.toBeNull());
    expect(hasContinueButton()).toBe(true);
    // The control itself is unaffected: still exactly one, still named Idea.
    expect(editableControls()).toHaveLength(1);
  });
});
