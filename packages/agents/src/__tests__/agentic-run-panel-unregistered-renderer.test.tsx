// @vitest-environment jsdom
/**
 * THE AGENTIC RUN PANEL REFUSES A STEP WHOSE SCREEN IS GONE.
 *
 * A step whose renderer id no binding declares any more (its package dropped
 * the declaration) is refused: "no renderer configured for this step", no
 * field, no Continue, nothing sent. A former decision or picker step is never
 * drawn as a free-text form. A tombstoned gate (a retired review gate) is
 * refused the same way.
 *
 * Harness mirrors agentic-run-panel.hitl.test.tsx.
 *
 *    cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/agentic-run-panel-unregistered-renderer.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fieldRendererRegistry } from "../field-renderer-registry";
import * as registration from "../register-default-renderers";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import * as midRun from "../orchestrator-mid-run-hitl";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";

/**
 * Mid-run decision and picker steps whose packages dropped the declarations:
 * the generated bindings no longer list them.
 */
const DROPPED = vi.hoisted(() => [
  "@cinatra-ai/blog-pipeline-agent:idea-selection",
  "@cinatra-ai/context-selection-agent:context-selector",
  "@cinatra-ai/email-delivery-agent:send-confirmation",
  "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
  "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
]);
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

vi.mock("@/lib/generated/agent-bindings", async (orig) => {
  const real = await orig<typeof import("@/lib/generated/agent-bindings")>();
  return {
    ...real,
    GENERATED_FIELD_RENDERER_BINDINGS: real.GENERATED_FIELD_RENDERER_BINDINGS.filter(
      (b) => !DROPPED.includes(b.id),
    ),
  };
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

/** Refused: the no-renderer paragraph, no field, no Continue, nothing sent. */
async function expectRefused(id: string) {
  await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
  expect(document.getElementById("field-note"), id).toBeNull();
  expect(document.getElementById("field-selectedIdeaJson"), id).toBeNull();
  expect(continues(), id).toHaveLength(0);
  expect(hitlActions.approveReviewTask, id).not.toHaveBeenCalled();
}

describe("AgenticRunPanel — a step whose screen is no longer declared is refused", () => {
  it("a former decision or picker step is not drawn as a free-text form", async () => {
    gateShape.schema = {
      type: "object",
      properties: { selectedIdeaJson: { type: "string", title: "Selected idea" } },
    };
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    for (const id of DROPPED) {
      expect(fieldRendererRegistry.list().some((e) => e.id === id), id).toBe(false);
      gateId.current = id;
      mountPanel(AgenticRunPanel);
      await expectRefused(id);
      cleanup();
    }
  });

  it("a renderer id the host has never seen is refused", async () => {
    gateId.current = "@cinatra-test/never-seen-agent:screen";
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    mountPanel(AgenticRunPanel);
    await expectRefused(gateId.current);
  });
});

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

type PublishedGate = { submit: (value: Record<string, unknown> | string | number | boolean) => Promise<void> } | null;

/** Mounts the panel with the chat composer's publish callback, and returns what it was handed last. */
function mountPublishing(AgenticRunPanel: typeof import("../agentic-run-panel").AgenticRunPanel) {
  const published: { calls: number; gate: PublishedGate } = { calls: 0, gate: null };
  render(
    <AgenticRunPanel
      runId="run-dropped"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
      onActiveGateChange={(_runId, gate) => {
        published.calls += 1;
        published.gate = gate;
      }}
    />,
  );
  return published;
}

describe("AgenticRunPanel — a step whose renderer id no entry claims is not handed to the chat", () => {
  const REMOVED_ID = "@acme/removed:output";
  const CLAIMED_ID = "@acme/live:output";

  // red-first-expect: expected { runId: 'run-dropped'
  it("shows the no-renderer paragraph, no Continue, and publishes no gate for the composer", async () => {
    gateId.current = REMOVED_ID;
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const published = mountPublishing(AgenticRunPanel);
    await expectRefused(REMOVED_ID);
    await waitFor(() => expect(published.calls).toBeGreaterThan(0));
    expect(published.gate).toBeNull();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("publishes the gate of a claimed id with the same name", async () => {
    fieldRendererRegistry.register({
      id: CLAIMED_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === CLAIMED_ID,
      renderer: () => <div data-testid="live-renderer">Live screen</div>,
    });
    gateId.current = CLAIMED_ID;
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const published = mountPublishing(AgenticRunPanel);
    await waitFor(() => expect(document.querySelector('[data-testid="live-renderer"]')).not.toBeNull());
    await waitFor(() => expect(published.gate).not.toBeNull());
    expect(continues()).toHaveLength(1);
  });
});

// A PUBLISH PACK'S OWN CONFIRMATION SCREEN, PARKED BEFORE AN UPGRADE: under a
// bundled pack that no longer declares it, the step is retired (no field, no
// Continue; the `DROPPED` cases above). Where an installed older pack still
// declares it, its old flow is the one that runs, and the step stays answerable.
const OLD_PUBLISH_SCREENS = [
  { id: "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm", kind: "wordpress-draft-confirm" },
  { id: "@cinatra-ai/blog-linkedin-publish-agent:draft-review", kind: "linkedin-draft-review" },
];
describe("AgenticRunPanel — a publish pack's own confirmation screen after an upgrade", () => {
  for (const screen of OLD_PUBLISH_SCREENS) {
    it(`${screen.id}: a runtime-installed older pack that declares it keeps the step answerable`, async () => {
      expect(fieldRendererRegistry.list().some((e) => e.id === screen.id)).toBe(false);
      registration.registerFieldRendererBindings([{ id: screen.id, kind: screen.kind, priority: 90, midRunHitl: true }]);
      gateId.current = screen.id;
      gateShape.schema = { type: "string", title: "Answer" };
      gateShape.fieldName = "answer";
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      mountPanel(AgenticRunPanel);
      await waitFor(() => expect(document.getElementById("field-answer")).not.toBeNull());
      expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
      await waitFor(() => expect(continues().length).toBeGreaterThan(0));
    });
  }
});
