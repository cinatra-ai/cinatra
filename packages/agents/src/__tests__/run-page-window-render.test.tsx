// @vitest-environment jsdom
/**
 * THE RUN PAGE'S WINDOW, RENDERED THROUGH ITS PRODUCTION MOUNT (cinatra#2933,
 * lifecycle-b W5b).
 *
 * The slice claims the prompt window is mounted on five surfaces outside the
 * chat. Four of them draw it. The run page did not draw it AT ALL, and the
 * slice's own surfaces suite reported green throughout, because that suite
 * matches SOURCE TEXT: `agentic-run-panel.tsx` does declare
 * `surface: "run-page"`, does call the one controller, and does gate its box on
 * the run's access — every string the suite looked for was present. What no
 * string could show is that the panel's only production mount outside the chat
 * never hands it the prop the box is gated on.
 *
 * The panel draws the window only when `templateId` is truthy
 * (agentic-run-panel.tsx, the `visible` gate). Its production mount outside the
 * chat is `SetupCompletionWatcher`, mounted by `instance-screens.tsx` — and the
 * watcher had no `templateId` prop at all, so the page had nothing to pass and
 * the panel's gate was false on every real run.
 *
 * So this suite renders the REAL panel through the REAL watcher with the props
 * the page really passes. The existing watcher suites all
 * `vi.mock("../agentic-run-panel")` — they are about the /trigger redirect, and
 * a mocked-away panel cannot show a missing window. Nothing here is mocked that
 * the window is made of.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-window-render.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// §X's OWN SENTENCE FOR THIS READING (design `458fb7ffce6c`,
// `app-artifact-review.html`, "X. One window, five readings" — "The run page —
// a step waiting for its fields"). Character for character, ellipsis included:
// asserting the COPY, not a test id, because a box that draws with different
// words is not this window.
const RUN_PAGE_SENTENCE =
  "Ask Cinatra to fill the fields above, or ask about this step…";
/** Is a box drawn at all, whichever reading it is. */
const ANY_WINDOW_SENTENCE = /^Ask Cinatra /;

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls in browser-only deps jsdom cannot load. The stub
  // renders the placeholder as text so the assertion reads the window's own
  // words. A <div>, not a raw <input>: the design-system lint gate forbids the
  // bare element in favour of the shadcn <Input>.
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Every named icon resolves to a null render, so an icon added to the panel's
// import graph later cannot break this suite.
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
    ownKeys: () => ["default"],
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
    runId: "run-2933",
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

// The window's server bridge. The store is proven elsewhere (unit + real-DB
// tiers); here it only has to answer so the controller can settle.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));

// The run is parked on a gate with a form — the state the window exists for.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    messages: [],
    dataPartFrames: [],
    interruptContext: {
      schema: {
        type: "object",
        properties: { subject: { type: "string" } },
        required: ["subject"],
      },
      xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
      values: { campaignId: "c1", recipients: [] },
      reviewTaskId: "lg-run-2933",
    },
    streamedText: "",
  }),
}));

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ status: "pending_approval", inputParams: {} }),
}));

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
  // The window is portalled into <main> by the shared panel.
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type WatcherProps = React.ComponentProps<
  typeof import("../setup-completion-watcher").SetupCompletionWatcher
>;

/**
 * The run page's mount, prop for prop.
 *
 * Every value here is what `instance-screens.tsx` hands the watcher on the
 * agentic branch of a live run: the run's own id and status, the template the
 * page already holds, and the access answer the page already resolved once on
 * the server with `canRespondInRunWindow(run.id)`.
 */
function runPageProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-2933",
    agentId: "cinatra-ai/email-recipient-selection-agent",
    instanceId: "run-2933",
    agUiEnabled: true as boolean | null,
    initialStatus: "pending_approval",
    initialError: null,
    initialMessages: [],
    requiredFields: ["subject"],
    initialInputParams: { subject: "Spring offer" },
    agentPackageName: "cinatra-ai/email-recipient-selection-agent",
    traceId: null,
    // The page holds the run's template row and passes its id to every other
    // window it mounts; this is the same value.
    templateId: "tmpl-2933",
    // Resolved on the server from the RUN's access, once, and forwarded
    // unchanged — the same value the page's other four windows are given.
    canRespondInWindow: true,
    // A parked run does not redirect; the guards are pinned by the sibling
    // watcher suites and are not what this one is about.
    triggerConfigured: true,
    initialStreamedText: "",
    ...overrides,
  } as WatcherProps;
}

describe("the run page draws the prompt window on its real mount (cinatra#2933)", () => {
  it("draws the window, with the ratified placeholder, through SetupCompletionWatcher", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...runPageProps()} />);

    const prompt = await screen.findByText(ANY_WINDOW_SENTENCE);
    expect(prompt).not.toBeNull();
  });

  it('§X — the run page\'s reading is "Ask Cinatra to fill the fields above, or ask about this step…"', async () => {
    // The run page's PRODUCTION mount, not a fixture: §X fixes this surface's
    // sentence as "The run page — a step waiting for its fields", and this is
    // the screen that reading is about.
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...runPageProps()} />);

    expect(await screen.findByText(RUN_PAGE_SENTENCE)).not.toBeNull();
    // The one string all five mounts used to show is gone from this screen.
    expect(
      screen.queryByText(/Ask Cinatra to suggest edits to the fields above/),
    ).toBeNull();
  });

  it("shows NO window to a person the run would refuse (AC3)", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(
      <SetupCompletionWatcher {...runPageProps({ canRespondInWindow: false })} />,
    );

    // Let the portal effect and the controller's mount read settle; the box
    // must still be absent, because the access gate short-circuits `visible`.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(ANY_WINDOW_SENTENCE)).toBeNull();
  });

  it("carries the run's own access answer down to the panel, not a default", async () => {
    // The watcher must FORWARD what the page resolved. A watcher that dropped
    // the prop would fall back to the panel's "absent ⇒ shown" default and the
    // refusal above would pass for the wrong reason — so the same render is
    // asserted from the other side: with access, the box is there.
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    const { unmount } = render(
      <SetupCompletionWatcher {...runPageProps({ canRespondInWindow: true })} />,
    );
    expect(await screen.findByText(ANY_WINDOW_SENTENCE)).not.toBeNull();
    unmount();
  });
});
