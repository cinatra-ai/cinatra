// @vitest-environment jsdom
/**
 * THE AGENTIC RUN PANEL REFUSES A RETIRED STEP.
 *
 * A step recorded under a tombstoned id (a retired review gate,
 * `hitlStepScreenIsAnswerable`) shows "no renderer configured for this step"
 * and no Continue, and nothing is sent.
 *
 * Harness mirrors agentic-run-panel.hitl.test.tsx.
 *
 *    cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/agentic-run-panel-tombstoned-step.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import * as midRun from "../orchestrator-mid-run-hitl";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";

// The app's Select drawn as a native one, so a pick is one change event.
vi.mock("@/components/ui/select", async () => {
  const R = await import("react");
  type Kids = { children?: React.ReactNode };
  function Select(props: Kids & { value?: string; onValueChange?: (v: string) => void; disabled?: boolean }) {
    let id: string | undefined;
    R.Children.forEach(props.children, (child) => {
      const childId = (child as { props?: { id?: string } } | null)?.props?.id;
      if (childId) id = childId;
    });
    return R.createElement(
      "select",
      { id, value: props.value ?? "", disabled: props.disabled, onChange: (e: { target: { value: string } }) => props.onValueChange?.(e.target.value) },
      R.createElement("option", { value: "" }, ""),
      props.children,
    );
  }
  const SelectTrigger = () => null;
  const SelectValue = () => null;
  const SelectContent = (props: Kids) => R.createElement(R.Fragment, null, props.children);
  const SelectItem = (props: Kids & { value: string }) => R.createElement("option", { value: props.value }, props.children);
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // HitlConversationPanel renders the field-assist PromptField. Stub it to a
  // plain element exposing the placeholder text so the cinatra#767 surface test
  // can assert presence/absence of the window's sentence in the field
  // above…". The real PromptField pulls in browser-only deps jsdom can't load.
  // Use a <div> (not a raw <input>, which the design-system lint gate forbids in
  // favor of the shadcn <Input>) and surface the placeholder as text content.
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
// lucide-react: stub the specific icons transitively imported by result
// renderers (ExternalLink from CardListRenderer + TableRenderer). Returning
// a module-namespace object (not a Proxy) avoids a vitest mock-hoist crash
// ("Cannot create proxy with a non-object as target or handler").
vi.mock("lucide-react", () => {
  // Vitest/Vite verifies named-export presence at module load time, so the
  // former fixed-list object broke when the run-start chip-row (cinatra#2067)
  // pulled `Check`/`ChevronDown` (direct) plus the transitive
  // orchestrator-sub-agent-node icon set (Circle, CircleDot, CheckCircle2,
  // XCircle, Loader2) into this panel's import graph. Mirror the robust Proxy
  // stub the sibling panel tests use (no-audit-button, email-drafts): every
  // named import resolves to a null-render StubIcon, so no future icon added to
  // the graph can break this mock. The `{}` object target + factory-local
  // StubIcon avoid the vi.mock hoist crash a bare-function Proxy target hits.
  const StubIcon = () => null;
  return new Proxy(
    {} as Record<string, () => null>,
    {
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
    },
  );
});

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-1",
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

/** The plain form's own id: a step that declares no screen of its own. */
const FLOOR_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;

/** The gate's renderer id the mocked stream hands the panel. */
const gateId = vi.hoisted(() => ({ current: "" }));
/** The gate's stored schema and field name the mocked stream hands the panel. */
const gateShape = vi.hoisted(() => ({
  schema: null as Record<string, unknown> | null,
  fieldName: undefined as string | undefined,
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: gateShape.schema ?? {
        type: "object",
        properties: { note: { type: "string", title: "Note" } },
      },
      xRenderer: gateId.current,
      fieldName: gateShape.fieldName,
      values: {},
      reviewTaskId: "wayflow-task-dropped",
    },
    streamedText: "",
  })),
}));

function continues(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

beforeEach(() => {
  cleanup();
  gateId.current = FLOOR_ID;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetFieldRendererComponentMapForTests();
  gateId.current = FLOOR_ID;
  gateShape.schema = null;
  gateShape.fieldName = undefined;
});

function mountPanel(AgenticRunPanel: typeof import("../agentic-run-panel").AgenticRunPanel) {
  return render(
    <AgenticRunPanel
      runId="run-dropped"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />,
  );
}

describe("AgenticRunPanel — a tombstoned gate stays unanswerable", () => {
  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("shows the no-renderer paragraph and no Continue for every tombstoned id", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
      gateId.current = id;
      mountPanel(AgenticRunPanel);
      await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
      expect(document.getElementById("field-note"), id).toBeNull();
      expect(continues(), id).toHaveLength(0);
      cleanup();
    }
  });
});

