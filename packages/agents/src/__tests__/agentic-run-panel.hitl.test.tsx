// @vitest-environment jsdom
/**
 * AgenticRunPanel presentation-first HITL branch.
 *
 * Verifies:
 *   (1) when interruptContext.values.presentation is a PresentationHint, the
 *       HITL bubble renders via <DispatchRenderer hint={...} mode="edit" />
 *       instead of the per-xRenderer fieldRendererRegistry path.
 *   (2) the Approve/Reject button row is rendered EXACTLY ONCE in the
 *       presentation branch — the shared approvalActionsRow fragment is not
 *       duplicated between sub-branches.
 *   (3) when presentation is absent, the registry-resolved renderer continues
 *       to render (regression guard).
 *
 *    cd packages/agent-builder && pnpm vitest run src/__tests__/agentic-run-panel.hitl.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

// ---------------------------------------------------------------------------
// Dependency mocks — the real modules touch DB / server / sdk-ui that jsdom
// does not resolve. Mirror the grouped-setup-form-renderer.test.tsx pattern.
// ---------------------------------------------------------------------------

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // HitlConversationPanel renders the field-assist PromptField. Stub it to a
  // plain element exposing the placeholder text so the cinatra#767 surface test
  // can assert presence/absence of "Ask Cinatra to suggest edits to the fields
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
  const StubIcon = () => null;
  return {
    ArrowRight: StubIcon,
    ChevronDown: StubIcon,
    ClipboardList: StubIcon,
    ExternalLink: StubIcon,
    Loader2: StubIcon,
    // Fallback default — guards against the renderer expecting a default export.
    default: StubIcon,
  };
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

// Shape the hook returns — match AgUiRunStreamResult exactly.
const hookResultWithPresentation = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: {
    schema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    xRenderer: "@cinatra-ai/email-drafting-agent:output",
    values: {
      presentation: {
        type: "card_list",
        title: "Review drafts",
        items: [{ title: "Draft A — Subject", description: "Body A..." }],
      },
    },
    reviewTaskId: "lg-run-1",
  },
  streamedText: "",
};

const hookResultWithoutPresentation = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: {
    schema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
    values: { campaignId: "c1", recipients: [] },
    reviewTaskId: "lg-run-2",
  },
  streamedText: "",
};

// The hook mock is re-exported per-test; vi.mocked lets us swap return values.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => hookResultWithPresentation),
}));

// Polling path uses getAgentBuilderTask — return null (no taskSnapshot) so the
// panel relies entirely on the SSE hook's interruptContext for rendering.

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgenticRunPanel HITL presentation branch", () => {
  it("renders DispatchRenderer when interruptContext.values.presentation is set (card_list)", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      hookResultWithPresentation,
    );

    render(
      <AgenticRunPanel
        runId="run-1"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
      />,
    );

    // DispatchRenderer → CardListRenderer renders the card title as text.
    // "Review drafts" is the hint.title; "Draft A — Subject" is items[0].title.
    // The presentation branch must render before the registry fallback
    // consumes the xRenderer.
    // Use findAllByText (async) to accommodate any render-after-effect.
    const titles = await screen.findAllByText(/Draft A — Subject|Review drafts/);
    expect(titles.length).toBeGreaterThan(0);
  });

  it("renders EXACTLY ONE Approve button and ONE Reject button in the presentation branch", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      hookResultWithPresentation,
    );

    render(
      <AgenticRunPanel
        runId="run-1"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
      />,
    );

    // The shared approvalActionsRow fragment is rendered in the presentation
    // branch. If the JSX is duplicated between the presentation and registry
    // branches, both would render, producing multiple buttons. This test locks
    // in "exactly one".
    // The HITL presentation branch renders a single unified "Continue" button
    // (idle: "Continue", pending: "Continuing…"). The "exactly one" invariant
    // locks in one Continue button instead of separate approve/reject buttons.
    const continues = await screen.findAllByText(/^Continue$|^Continuing…$/);
    expect(continues.length).toBe(1);
  });

  it("falls back to registry path when presentation is absent (regression)", async () => {
    // Registry fallback renders "Waiting for input — no renderer configured
    // for this step." when no renderer is configured.
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      hookResultWithoutPresentation,
    );

    render(
      <AgenticRunPanel
        runId="run-1"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
      />,
    );

    // When presentation is absent, the registry-fallback renderer OR the
    // "Waiting for input — no renderer configured for this step." fallback
    // is displayed. Either outcome MUST be reached WITHOUT DispatchRenderer
    // firing. Because the registry may or may not have a recipients renderer
    // wired in the test environment, we assert on the HITL bubble header.
    // jest-dom is not installed in this workspace, so `toBeInTheDocument` is
    // unavailable — `findByText` throws when the node is absent, so a
    // non-null assertion is sufficient to prove the element rendered.
    // Registry-fallback branch copy.
    const fallbackHeading = await screen.findByText(/Waiting for input/i);
    expect(fallbackHeading).not.toBeNull();
    // The DispatchRenderer card title "Review drafts" MUST NOT appear.
    expect(screen.queryByText(/Review drafts/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#767 — the sticky field-assist PromptField (HitlConversationPanel)
// belongs to /agents/* only. It must NOT render when AgenticRunPanel is mounted
// in chat (surface="chat"), where it duplicates the composer and stacks one per
// pending HITL. Default surface ("agent-detail") keeps it.
// ---------------------------------------------------------------------------

const FIELD_ASSIST_PLACEHOLDER =
  /Ask Cinatra to suggest edits to the fields above/i;

describe("AgenticRunPanel field-assist prompt surface gate (cinatra#767)", () => {
  beforeEach(() => {
    // HitlConversationPanel portals into document.querySelector("main").
    cleanup();
    document.body.innerHTML = "";
    document.body.appendChild(document.createElement("main"));
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Visibility also requires a templateId. The non-presentation hook result
  // yields a truthy effectiveHitlContext with an xRenderer + pending_approval,
  // so with templateId set the only remaining discriminator is `surface`.
  async function renderWithSurface(surface?: "chat" | "agent-detail") {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      hookResultWithoutPresentation,
    );
    return render(
      <AgenticRunPanel
        runId="run-1"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
        templateId="tmpl-1"
        {...(surface ? { surface } : {})}
      />,
    );
  }

  it("renders the field-assist prompt by default (agent-detail surface)", async () => {
    await renderWithSurface();
    const prompt = await screen.findByText(FIELD_ASSIST_PLACEHOLDER);
    expect(prompt).not.toBeNull();
  });

  it('hides the field-assist prompt when surface="chat"', async () => {
    await renderWithSurface("chat");
    // Let any post-mount effects (portalTarget set) flush; the prompt must
    // still be absent because the surface gate short-circuits `visible`.
    await Promise.resolve();
    expect(screen.queryByText(FIELD_ASSIST_PLACEHOLDER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// engineering#416 — chat step-0 input gate auto-satisfy.
//
// A `setup-<runId>` reviewTaskId is the structural identity of the StartNode
// step-0 read-only input gate (the setup-interrupt loop is its only emitter;
// oas-compiler hardcodes it riskClass:"read_only", skipLlm:true). In chat the
// human supplies the inputs inline (= approval), so the per-field renderer's
// own "Continue" button is a redundant second approval ON TOP of the inline
// input form. The panel must pass hideSubmit=true to the field renderer for a
// chat-surface setup gate, suppressing that button. On the /agents/* run-detail
// surface (default "agent-detail") the explicit Continue stays. A non-`setup-`
// (side-effect / WayFlow) gate is never treated as a setup gate, so it keeps
// its approval affordance on every surface.
// ---------------------------------------------------------------------------
describe("AgenticRunPanel chat step-0 setup gate hides redundant Continue (engineering#416)", () => {
  const SETUP_RENDERER_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;
  const SETUP_CONTINUE_LABEL = /Setup Continue button/i;

  // Stub renderer that mirrors SchemaFieldRenderer's hideSubmit contract: it
  // renders a "Continue" button ONLY when hideSubmit is not true. Lets us
  // assert the panel's hideSubmit plumbing without the heavy real renderer +
  // its shadcn/sdk-ui deps.
  // The marker is a <span> (not a raw <button>, which the ui-design-system
  // gate forbids in favor of the shadcn <Button>); the assertions key off the
  // text label, not a button role.
  function StubSetupRenderer(props: { hideSubmit?: boolean }) {
    return (
      <div data-testid="stub-setup-renderer">
        {!props.hideSubmit ? <span>Setup Continue button</span> : null}
      </div>
    );
  }

  function setupInterruptHookResult(reviewTaskId: string, xRenderer: string) {
    return {
      status: "pending_approval",
      error: null,
      presentationHint: null,
      isLive: true,
      interruptContext: {
        schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        xRenderer,
        values: {},
        reviewTaskId,
        fieldName: "url",
      },
      streamedText: "",
    };
  }

  beforeEach(() => {
    cleanup();
  });
  afterEach(async () => {
    cleanup();
    vi.clearAllMocks();
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.clear();
  });

  async function renderSetupGate(opts: {
    surface?: "chat" | "agent-detail";
    reviewTaskId: string;
    xRenderer: string;
  }) {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: opts.xRenderer,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { ["x-renderer"]?: string })["x-renderer"] === opts.xRenderer,
      // The stub only reads hideSubmit; cast through unknown to satisfy the
      // ComponentType<FieldRendererProps> registry slot.
      renderer: StubSetupRenderer as unknown as Parameters<
        typeof fieldRendererRegistry.register
      >[0]["renderer"],
    });
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      setupInterruptHookResult(opts.reviewTaskId, opts.xRenderer),
    );
    return render(
      <AgenticRunPanel
        runId="run-1"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
        templateId="tmpl-1"
        {...(opts.surface ? { surface: opts.surface } : {})}
      />,
    );
  }

  it('suppresses the per-field Continue button for a setup gate when surface="chat"', async () => {
    await renderSetupGate({
      surface: "chat",
      reviewTaskId: "setup-run-1",
      xRenderer: SETUP_RENDERER_ID,
    });
    // The input form renderer still mounts (the user supplies inputs inline);
    // only the redundant Continue button is gone.
    expect(await screen.findByTestId("stub-setup-renderer")).not.toBeNull();
    expect(screen.queryByText(SETUP_CONTINUE_LABEL)).toBeNull();
  });

  it("keeps the per-field Continue button for a setup gate on the default agent-detail surface", async () => {
    await renderSetupGate({
      reviewTaskId: "setup-run-1",
      xRenderer: SETUP_RENDERER_ID,
    });
    expect(await screen.findByTestId("stub-setup-renderer")).not.toBeNull();
    expect(screen.queryByText(SETUP_CONTINUE_LABEL)).not.toBeNull();
  });

  it('keeps the Continue button for a NON-setup gate even when surface="chat" (side-effect gate still prompts)', async () => {
    // A WayFlow / side-effect gate uses a non-`setup-` reviewTaskId; it must
    // NOT be auto-satisfied — the explicit approval affordance stays.
    await renderSetupGate({
      surface: "chat",
      reviewTaskId: "wayflow-task-9",
      xRenderer: SETUP_RENDERER_ID,
    });
    expect(await screen.findByTestId("stub-setup-renderer")).not.toBeNull();
    expect(screen.queryByText(SETUP_CONTINUE_LABEL)).not.toBeNull();
  });
});
