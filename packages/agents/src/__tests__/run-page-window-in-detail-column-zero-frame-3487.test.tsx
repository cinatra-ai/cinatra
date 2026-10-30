// @vitest-environment jsdom
/**
 * THE RUN PAGE KEEPS ITS PROMPT WINDOW IN THE DETAIL COLUMN WHEN NO RAIL FRAME
 * IS DRAWN (cinatra#3487).
 *
 * The ratified drawing puts the run's one prompt window "below the scheduler,
 * in the same column" (`app-artifact-review.html` §I), and the ruling of
 * 2026-09-14 makes it part of the run page's chrome. The chrome draws its window
 * after its children, so whatever the chrome wraps decides where the window
 * lands.
 *
 * WHAT WAS WRONG. The run page wrapped its whole two-column contract in the
 * chrome. Where the rail frame is drawn, the frame's own chrome in its detail
 * column holds the registration and the outer one draws nothing. But a run
 * whose rail carries no step of the frame's own (no Skills, Schedule, input,
 * gate, made or review rows) is drawn as a plain rail column plus a plain detail
 * column, with no frame, and there the outer chrome drew the window after the
 * whole contract, beneath BOTH columns and outside `[data-run-detail-contract]`.
 *
 * WHAT IS READ HERE. That run, through the REAL run page (`SetupScreen`), on the
 * harness of `rail-marks-the-gate-the-run-stops-at-3246.test.tsx` (its mocks
 * copied, never imported across files): an agentic run awaiting approval, its
 * rail one ordinary transcript turn, no schedule, recommendation or review rows,
 * no lifecycle moment, and a respondable HITL renderer that is not the artifact
 * review. The window must be drawn once, inside the contract, in the column the
 * run detail stands in, and not in the rail.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-window-in-detail-column-zero-frame-3487.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// No started-run history: the unrelated reader stays at the data boundary.
vi.mock("../visible-started-runs", () => ({
  readVisibleStartedRuns: async () => [],
}));

vi.mock("../db", () => ({
  agentBuilderPool: { query: async () => ({ rows: [] }), on: () => {}, listenerCount: () => 1 },
  db: {},
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {}, STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {}, GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {}, GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {}, GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {}, GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
vi.mock("@/lib/generated/field-renderer-components", () => ({ GENERATED_FIELD_RENDERER_COMPONENTS: {} }));

const RUN_ID = "run-3487-zero-frame";

/** No declared input: the run carries no input step on its rail. */
const INPUT_SCHEMA = {
  properties: {} as Record<string, unknown>,
  required: [] as string[],
};

/** An AGENTIC template: no approval-policy steps, so the transcript forms the rail. */
const TEMPLATE = {
  id: "tmpl-3487-zero-frame",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Draft Writer",
  description: "",
  type: "agentic",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: INPUT_SCHEMA,
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@cinatra-ai/blog-draft-writer",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: null,
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const RAIL_TURN_TEXT = "Outlined the post";

/** ONE assistant turn: the ordinary rail entry, and the only one. */
const TRANSCRIPT = [
  {
    id: "msg-1",
    runId: RUN_ID,
    sequence: 1,
    role: "assistant",
    messageType: "text",
    body: { messageType: "text", role: "assistant", text: RAIL_TURN_TEXT },
    createdAt: new Date("2026-01-01T00:00:10Z"),
  },
];

/** A respondable gate that is NOT the artifact review. */
const HITL_CONTEXT = {
  xRenderer: "context-selector",
  currentValues: {
    candidates: [{ artifactId: "a1", representationRevisionId: "r1", semanticAssertionId: "s1" }],
    selectedRefs: [],
    slotMeta: { slotId: "draftContext", resolutionMode: "accumulate", selectionMode: "interactive" },
  },
  fieldName: null,
  schema: { type: "object", properties: {} },
  reviewTaskId: "wayflow-task-3487",
};

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: "pending_approval",
    inputParams: {},
    stepResults: null,
    startedAt: new Date("2026-01-01"),
    completedAt: null,
    error: null,
    title: "A run",
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: "1.0.0",
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: true,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
    executionAttemptId: null,
    launchScopeAnchor: null,
  };
}

// ── The data layer the screen reads. Nothing of the page's composition. ─────
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1", name: "A", email: "a@b.c" },
    session: { activeOrganizationId: "org-1" },
  })),
  requireAuthSession: async () => ({ user: { id: "user-1" } }),
  requireActorContext: async () => ({ actorType: "human", source: "ui", userId: "user-1", orgId: "org-1" }),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: vi.fn(async () => TEMPLATE),
  readAgentTemplateById: vi.fn(async () => TEMPLATE),
  readAgentRunById: vi.fn(async () => makeRun()),
  readAgentRunMessages: vi.fn(async () => TRANSCRIPT),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => "A run"),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", async () => ({
  buildActorContextFromPrimitive: (await vi.importActual<typeof import("@/lib/authz/build-actor-context")>("@/lib/authz/build-actor-context")).buildActorContextFromPrimitive,
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner" })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../artifact-review-gate-store", async () => ({
  isParkedOnProducedReview: (await import("../run-produced-review-hold")).isParkedOnProducedReview,
  listReviewGatesForRun: vi.fn(async () => []),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
  readVerificationRecordsForGates: vi.fn(async () => []),
}));

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

// No recommendation park: the run carries no Skills entry.
vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => HITL_CONTEXT),
}));

vi.mock("../run-actions", async (original) => ({
  ...await original<typeof import("../run-actions")>(),
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
  readAnsweredContextHistory: vi.fn(async () => []),
}));

// No trigger row: the run carries no schedule.
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => INPUT_SCHEMA),
}));

vi.mock("@/lib/artifacts/run-made-artifacts", () => ({
  listRunMadeArtifacts: vi.fn(async () => []),
}));

vi.mock("../trigger-duration-estimate", () => ({
  estimateRunDuration: vi.fn(async () => ({ seconds: 60 })),
}));

vi.mock("@/lib/lifecycle/run-window-turn", () => ({
  canRespondInRunWindow: vi.fn(async () => true),
}));

vi.mock("../run-sharing-actions", () => ({ removeRunOwner: vi.fn() }));

vi.mock("../run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { SetupScreen } from "../instance-screens";
import { RUN_WINDOW_HOST_ATTRIBUTE, RUN_WINDOW_HOST_VALUE } from "../run-page-chrome";
import { readRunWindowOwnership } from "../../../../tests/e2e/design/conformance/run-window-ownership";

/** The run page's own event stream, stubbed and taken away again. */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const HOST = `[${RUN_WINDOW_HOST_ATTRIBUTE}="${RUN_WINDOW_HOST_VALUE}"]`;

async function serverTree(): Promise<React.ReactElement> {
  return (await SetupScreen({
    agentId: "blog-draft-writer",
    instanceId: RUN_ID,
  })) as React.ReactElement;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ status: "pending_approval", lifecycleMoment: null }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("cinatra#3487 -- a run page with no rail frame keeps its window in the detail column", () => {
  it("draws one visible window inside the run-detail contract, in the detail column and not in the rail", async () => {
    const { container } = render(await serverTree());
    await waitFor(() => {
      expect(container.querySelector(`${HOST} [data-run-window-field]`)).not.toBeNull();
    });

    // THE INPUT IS THE ONE MEASURED: the contract is drawn with the run's
    // ordinary rail entry beside the detail, and no rail frame of its own.
    const contract = container.querySelector<HTMLElement>("[data-run-detail-contract]");
    expect(contract).not.toBeNull();
    expect(container.querySelector("[data-run-detail-column]")).toBeNull();
    const rail = contract!.querySelector<HTMLElement>("[data-run-step-rail]");
    expect(rail).not.toBeNull();
    expect(rail!.textContent).toContain(RAIL_TURN_TEXT);

    // ONE window for the page.
    const hosts = container.querySelectorAll<HTMLElement>(HOST);
    expect(hosts.length).toBe(1);
    const host = hosts[0]!;

    // INSIDE the contract, never appended after it beneath both columns.
    expect(host.closest("[data-run-detail-contract]")).toBe(contract);
    expect(
      contract!.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();

    // In the column the run detail stands in: one of the contract's two
    // columns, and not the one carrying the rail.
    const column = Array.from(contract!.children).find((child) => child.contains(host));
    expect(column).toBeDefined();
    expect(column!.contains(rail)).toBe(false);
    expect(rail!.contains(host)).toBe(false);
  });
});

// cinatra#3487 item 3: THE DESIGN-CONFORMANCE READING ON THE REAL RUN PAGE. The
// conformance suite's own reader (`tests/e2e/design/conformance/
// run-window-ownership.ts`) is run on the run page ROUTE's own tree
// (`SetupScreen`): the window's anchor is the drawing's `run-window`
// (`app-artifact-review.html` §I.6), it is a descendant of the page chrome and
// never of `[data-lifecycle-card-host]`, and the page carries no second window.
describe("cinatra#3487 item 3 -- the design-conformance reading of the real run page", () => {
  it("one run-window anchor, in the page chrome, none in a card, and no second window", async () => {
    const { container } = render(await serverTree());
    await waitFor(() => {
      expect(container.querySelector(`${HOST} [data-run-window-field]`)).not.toBeNull();
    });

    const anchors = container.querySelectorAll<HTMLElement>('[data-conformance-id="run-window"]');
    expect(anchors.length).toBe(1);
    const anchor = anchors[0]!;
    expect(anchor.closest(HOST)).not.toBeNull();
    expect(anchor.closest("[data-lifecycle-card-host]")).toBeNull();
    // The anchor is the window itself: the field the person types into is in it.
    expect(anchor.querySelector("[data-run-window-field]")).not.toBeNull();

    expect(readRunWindowOwnership(container)).toMatchObject({
      windows: 1,
      ownedWindows: 1,
      promptsInCards: 0,
      composersInCards: 0,
      noticesInCards: 0,
    });
  });
});
