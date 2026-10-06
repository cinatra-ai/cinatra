// @vitest-environment jsdom
// Actual run-panel and server review-step JSX contracts.
// Browser computed-style and picture/grade proof remain separate.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

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

const RUN_ID = "run-3478";

/**
 * THE RUN, AS THE STORE HOLDS IT — one row, mutated per reading, because the
 * two readings below are the SAME run at two moments of its life.
 */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  lifecycleMoment: "hitl" as string | null,
  lifecycleCardKind: "agent_hitl_screen" as string | null,
  lifecycleCardRef: "wayflow-task-1" as string | null,
  hitlContext: null as unknown,
  /** The input forms the agent declares — none for the finished-run reading. */
  required: ["idea", "audience"] as string[],
  /**
   * THE FIELDS THE AGENT DECLARES, WITH THE TITLES IT MAPS TO THEM
   * (cinatra#3243). A field whose title only restates its own key declares no
   * name of its own, and `run-input-steps.ts` merges every such form into the
   * run's one setup entry — which is the reading every case above takes. A
   * field that declares a real name is its own step, which is what a run with
   * a form it is standing at and a form it has not been asked needs.
   */
  properties: {
    idea: { type: "string", title: "idea" },
    audience: { type: "string", title: "audience" },
  } as Record<string, unknown>,
  /** The values the run carries for those fields — none before it is asked. */
  inputParams: { idea: "a post about rails", audience: "developers" } as Record<
    string,
    unknown
  >,
  producedReviewPark: null as string | null,
  templateSourceType: "external" as "external" | "internal",
}));

/**
 * THE RUN'S RECOMMENDATION PARK, AS THE STORE HOLDS IT (cinatra#3243) — the
 * whole reading of the Skills entry: a `parked` row is the question still held,
 * which is the moment the issue reports, and `null` is a run that never held.
 */
const recommendationPark = vi.hoisted(() => ({
  row: null as { status: string } | null,
  /** What the card's own resolve answers for that park. */
  holdState: { state: "none" } as unknown,
}));

/**
 * THE RUN'S REVIEW SLOT, AS THE READER ANSWERS IT — mutated per reading for the
 * same reason the row above is: a run WAITING at its review gate and a run whose
 * gate is settled are the same run at two moments, and the rail draws the run's
 * own record differently at each (cinatra#3478, third leg).
 */
const reviewSlot = vi.hoisted(() => ({
  awaiting: false,
  reviewTaskId: null as string | null,
}));

/**
 * THE RUN'S REVIEW GATES, AS THE RAIL'S OWN READER LISTS THEM — the gate ROW,
 * which is the thing that outlives the outbox window: `readRunReviewSlot`
 * answers `awaiting: false` the moment this row exists, decided or not, so a
 * run standing in front of an UNDECIDED gate is only visible here.
 */
const reviewGates = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    reviewTaskId: string;
    status: "pending" | "resolved";
    disposition: string | null;
    createdAt: Date;
  }>,
}));

/**
 * THE RUN'S TRIGGER ROW, AS THE STORE HOLDS IT (cinatra#3478, the re-cut's
 * first leg) — the one fact that says whether the run CARRIES A SCHEDULE, and
 * of which kind. `null` is a run that carries none; `releasedAt` is the fired
 * stamp the schedule's own record keeps, for an immediate fire as much as for a
 * scheduled one.
 */
const triggerRow = vi.hoisted(() => ({
  row: null as { triggerType: string; releasedAt: Date | null } | null,
}));

/** The trigger row of a run dispatched with "Run right after setup", fired. */
const TEMPLATE = {
  id: "tmpl-3478",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Idea Generator",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: {
    properties: {
      idea: { type: "string", title: "idea" },
      audience: { type: "string", title: "audience" },
    },
    required: [] as string[],
  },
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@cinatra-ai/blog-idea-generator",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: {
    steps: [
      { stepNumber: 1, xRenderer: "cinatra/review", name: "Draft the post" },
      { stepNumber: 2, xRenderer: "cinatra/review", name: "Pick the image" },
    ],
  },
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** The template, with the input forms this reading's agent declares. */
function makeTemplate() {
  return {
    ...TEMPLATE,
    sourceType: row.templateSourceType,
    inputSchema: {
      ...TEMPLATE.inputSchema,
      properties: row.properties,
      required: row.required,
    },
  };
}

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: row.inputParams,
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
    lifecycleMoment: row.lifecycleMoment,
    lifecycleCardKind: row.lifecycleCardKind,
    lifecycleCardRef: row.lifecycleCardRef,
    producedReviewPark: row.producedReviewPark,
    executionAttemptId: null,
    launchScopeAnchor: null,
  };
}

// ── The data layer the screen reads. Nothing of the rail's composition. ──────
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1", name: "A", email: "a@b.c" },
    session: { activeOrganizationId: "org-1" },
  })),
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
  readAgentTemplateBySlug: vi.fn(async () => makeTemplate()),
  readAgentRunById: vi.fn(async () => makeRun()),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => "A run"),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", () => ({
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner" })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../artifact-review-gate-store", async () => {
  // cinatra#3046 — this screen also asks the store whether the run is parked on
  // the review its own output opened. That predicate is PURE: it answers from the
  // run row it is handed, so this factory hands the suite the REAL one (re-exported
  // by the store from its writer) instead of a stub that could answer differently
  // from the page under test.
  const hold = await vi.importActual<typeof import("../run-produced-review-hold")>(
    "../run-produced-review-hold",
  );
  return {
    listReviewGatesForRun: vi.fn(async () => reviewGates.rows),
    readReviewGate: vi.fn(async () => null),
    readRunReviewSlot: vi.fn(async () => ({
      reviewTaskId: reviewSlot.reviewTaskId,
      awaiting: reviewSlot.awaiting,
    })),
    readVerificationRecordsForGates: vi.fn(async () => []),
    isParkedOnProducedReview: hold.isParkedOnProducedReview,
  };
});

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => recommendationPark.row),
}));

// The Skills card resolves its own offer through this module after it mounts,
// and until that answer lands a LIVE hold draws no DOM at all — the card says
// so itself. That read is data layer, so it is stubbed here exactly as every
// other read the page makes; the card, the frame and the rail are the real
// ones.
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => recommendationPark.holdState),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => row.hitlContext),
}));

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
}));

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => triggerRow.row),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => makeTemplate().inputSchema),
}));

// The run's own record reads what the run filed; a finished run asks for it.
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

import { SetupScreen, TriggerScreen } from "../instance-screens";
import { AgenticRunPanel } from "../agentic-run-panel";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

/**
 * The run panel opens the run's event stream on mount. jsdom carries no
 * `EventSource`; the page is what is under test, not the transport, so it is
 * stubbed through vitest's own global stubbing and taken away again in
 * `afterAll` — this file leaves no global behind for the package's other suites
 * (the rail's own rule for a new test file).
 */
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


// These are DOM contract tests, not browser computed-style or picture proof.
const resolveReading = vi.hoisted(() => ({ value: { kind: "artifact_review_gate", state: { state: "pending", canDecide: true, canComment: true }, body: null } as unknown }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [], runId: RUN_ID })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));
vi.mock("@/lib/generated/field-renderer-components", () => ({ GENERATED_FIELD_RENDERER_COMPONENTS: {} }));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {}, GENERATED_CONNECTOR_ENTRY_MODULES: {}, GENERATED_CONNECTOR_MCP_MODULES: {}, GENERATED_DEV_SETUP_MODULES: {}, GENERATED_WIDGET_STREAM_AGENTS: {} }));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../hitl-actions", () => ({ approveReviewTask: vi.fn(), rejectReviewTask: vi.fn() }));
vi.mock("../use-ag-ui-run-stream", () => ({ useAgUiRunStream: () => ({ status: row.status, error: null, presentationHint: null, isLive: false, interruptContext: null, streamedText: "", dataPartFrames: [] }) }));

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-only-review-ground-key");
  row.status = "completed";
  row.lifecycleMoment = null;
  row.lifecycleCardKind = null;
  row.lifecycleCardRef = null;
  row.hitlContext = null;
  row.required = [];
  row.properties = {};
  row.inputParams = {};
  row.producedReviewPark = null;
  row.templateSourceType = "external";
  recommendationPark.row = null;
  recommendationPark.holdState = { state: "none" };
  reviewSlot.awaiting = false;
  reviewSlot.reviewTaskId = "task-review-1";
  reviewGates.rows = [];
  triggerRow.row = null;
  resolveReading.value = { kind: "artifact_review_gate", state: { state: "pending", canDecide: true, canComment: true }, body: null };
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const data = url.includes("/api/agents/runs/") ? { status: row.status, error: null, startedAt: null, completedAt: null, messages: [], hitlContext: null, reviewGate: { ref: reviewSlot.reviewTaskId ? encodeLifecycleGateRef({ runId: RUN_ID, reviewTaskId: reviewSlot.reviewTaskId }) : null, awaiting: reviewSlot.awaiting, producedReviewPark: row.producedReviewPark !== null } } : resolveReading.value;
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function strongGround(slot: HTMLElement) {
  const classes = slot.className.split(/\s+/);
  expect(classes).toContain("bg-surface-strong");
  expect(classes).toContain("border");
  expect(classes).toContain("border-line");
  expect(classes.some((token) => token === "rounded-card" || token === "rounded-[12px]")).toBe(true);
  expect(classes).not.toContain("soft-panel");
}
// The run-detail rail is a layout, while the slot is the one .runcard.
// A placeholder or gate inside it must not draw a second card frame.
function singleSlotFrame(slot: HTMLElement) {
  strongGround(slot);
  expect(slot.classList.contains("rounded-[12px]")).toBe(true);
  const children = slot.querySelectorAll<HTMLElement>('[data-conformance-id="review-gate-card"],[data-conformance-id="review-gate-placeholder"]');
  for (const child of children) {
    // Include the placeholder's literal rounded-[12px], not only rounded-card.
    expect(child.classList.contains("border")).toBe(false);
    expect(child.classList.contains("bg-surface-strong")).toBe(false);
  }
}
async function runPage(step?: string) {
  const tree = await SetupScreen({
    agentId: "blog-idea-generator", instanceId: RUN_ID,
    searchParams: { step: step ?? "detail" },
  });
  return render(tree as React.ReactElement);
}
async function panel(railDrawsTheFrame = false) {
  const view = render(<AgenticRunPanel runId={RUN_ID} initialStatus={row.status} initialError={null} initialMessages={[]} agUiEnabled={false} templateId={TEMPLATE.id} surface="agent-detail" railDrawsTheFrame={railDrawsTheFrame} initialReviewGate={{ ref: reviewSlot.reviewTaskId ? encodeLifecycleGateRef({ runId: RUN_ID, reviewTaskId: reviewSlot.reviewTaskId }) : null, awaiting: reviewSlot.awaiting }} />);
  return view;
}
async function reviewSlotElement() {
  await waitFor(() => expect(document.querySelector('[data-run-review-slot="review"]')).not.toBeNull());
  return document.querySelector<HTMLElement>('[data-run-review-slot="review"]')!;
}
// Traverse React output (including the rail's surfaces) from the REAL server
// function, then mount the exact section it produced. No source extraction or
// hand-written copy of that section is used.
function serverSlot(tree: unknown): React.ReactElement | null {
  if (!tree || typeof tree !== "object") return null;
  if (React.isValidElement<Record<string, unknown>>(tree)) {
    if (Object.hasOwn(tree.props, "data-run-review-slot")) return tree;
    return serverSlot(tree.props);
  }
  for (const item of Object.values(tree)) { const found = serverSlot(item); if (found) return found; }
  return null;
}
async function triggerSlot() {
  const tree = await TriggerScreen({ agentId: "blog-idea-generator", instanceId: RUN_ID });
  return serverSlot(tree);
}

describe("the actual run gate ground", () => {
  it("draws the pending off-frame gate on the strong card ground", async () => { await panel(); strongGround(await reviewSlotElement()); });
  it("gives the rail-owned pending review one strong slot frame", async () => {
    await panel(true);
    singleSlotFrame(await reviewSlotElement());
  });
  it("keeps the off-frame working placeholder on the same strong ground", async () => {
    reviewSlot.reviewTaskId = null; reviewSlot.awaiting = true; row.status = "running";
    await panel(); await waitFor(() => expect(document.querySelector('[data-run-review-slot="working"]')).not.toBeNull());
    strongGround(document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!);
  });
  it("does not invent a review wrapper for a completed run with no gate", async () => {
    reviewSlot.reviewTaskId = null; await panel();
    expect(document.querySelector('[data-run-review-slot]')).toBeNull();
  });
  it("keeps a refused gate from becoming an empty review reading", async () => {
    resolveReading.value = { kind: "artifact_review_gate", state: { state: "absent" }, body: null };
    await panel();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("resolve"))).toBe(true));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    expect(document.querySelector('[data-run-review-slot="review"]')).toBeNull();
  });
  it("keeps a settled gate visible on the strong off-frame ground", async () => {
    resolveReading.value = { kind: "artifact_review_gate", state: { state: "settled", outcome: "approved" }, body: null };
    await panel(); strongGround(await reviewSlotElement());
  });
  it("runs the actual server review-step path and mounts its pending section on the strong ground", async () => {
    const element = await triggerSlot(); expect(element).not.toBeNull();
    expect((element!.props as Record<string, unknown>)["data-run-review-slot"]).toBe("review");
    render(element); strongGround(document.querySelector<HTMLElement>('[data-run-review-slot="review"]')!);
  });
  it("runs the actual server working path on the same ground", async () => {
    reviewSlot.reviewTaskId = null; reviewSlot.awaiting = true;
    const element = await triggerSlot(); expect(element).not.toBeNull();
    render(element); strongGround(document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!);
  });
  it("the server emits no review surface when its slot is absent", async () => {
    reviewSlot.reviewTaskId = null; reviewSlot.awaiting = false;
    expect(await triggerSlot()).toBeNull();
  });
});


describe("the real run page's scheduled rail owns one review card frame", () => {
  beforeEach(() => {
    // The real right-after-setup trigger row is present even for immediate runs.
    triggerRow.row = { triggerType: "immediate", releasedAt: new Date("2026-01-01") };
  });

  it("draws the pending gate on the strong ground inside the actual run page rail", async () => {
    await runPage();
    const slot = await reviewSlotElement();
    expect(slot.closest("[data-run-detail-column]")).not.toBeNull();
    singleSlotFrame(slot);
    expect(slot.querySelector('[data-conformance-id="review-gate-placeholder"]')).toBeNull();
  });

  it("keeps a working immediate run on one strong frame before its gate exists", async () => {
    row.status = "running"; reviewSlot.reviewTaskId = null; reviewSlot.awaiting = true;
    await runPage();
    await waitFor(() => expect(document.querySelector('[data-run-review-slot="working"]')).not.toBeNull());
    const slot = document.querySelector<HTMLElement>("[data-run-review-slot]")!;
    singleSlotFrame(slot);
    expect(slot.querySelector('[data-conformance-id="review-gate-placeholder"]')).not.toBeNull();
  });

  it("retains the same rail slot when its gate has settled", async () => {
    resolveReading.value = { kind: "artifact_review_gate", state: { state: "settled", outcome: "approved" }, body: null };
    await runPage(); singleSlotFrame(await reviewSlotElement());
  });

  it("frames an explicitly selected historical gate from the actual server run page", async () => {
    reviewSlot.reviewTaskId = null;
    reviewGates.rows = [{ id: "gate-history", reviewTaskId: "history-review", status: "resolved", disposition: "approve", createdAt: new Date("2026-01-01") }];
    resolveReading.value = { kind: "artifact_review_gate", state: { state: "settled", outcome: "approved" }, body: null };
    await runPage("review:history-review");
    await waitFor(() => expect(document.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull());
    const card = document.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    const slot = card.closest<HTMLElement>("[data-run-review-slot]");
    expect(slot).not.toBeNull(); singleSlotFrame(slot!);
  });

  it("does not create a review slot for a finished immediate run that has no gate", async () => {
    reviewSlot.reviewTaskId = null; reviewSlot.awaiting = false;
    await runPage(); expect(document.querySelector("[data-run-review-slot]")).toBeNull();
  });

  it("keeps one working frame if the actual rail gate refuses the viewer", async () => {
    resolveReading.value = { kind: "artifact_review_gate", state: { state: "absent" }, body: null };
    await runPage();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("resolve"))).toBe(true));
    await act(async () => { await Promise.resolve(); });
    const slot = document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!;
    expect(slot).not.toBeNull(); singleSlotFrame(slot);
    expect(slot.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("keeps one working frame if the actual rail gate resolve is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })));
    await runPage();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("resolve"))).toBe(true));
    await act(async () => { await Promise.resolve(); });
    const slot = document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!;
    expect(slot).not.toBeNull(); singleSlotFrame(slot);
  });
});


describe("the real internal orchestrator run page owns one review card frame", () => {
  beforeEach(() => {
    row.templateSourceType = "internal";
    row.status = "pending_approval";
    row.producedReviewPark = JSON.stringify({ status: "completed" });
    triggerRow.row = { triggerType: "immediate", releasedAt: new Date("2026-01-01") };
  });
  it.each(["pending", "settled"])("frames its %s gate under the actual rail", async (state) => {
    resolveReading.value = { kind: "artifact_review_gate", state: state === "pending" ? { state, canDecide: true, canComment: true } : { state, outcome: "approved" }, body: null };
    await runPage();
    await waitFor(() => {
      const card = document.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]');
      expect(card).not.toBeNull();
      const slot = card!.closest<HTMLElement>("[data-run-review-slot]");
      expect(slot).not.toBeNull(); singleSlotFrame(slot!);
      expect(slot!.closest("[data-run-detail-column]")).not.toBeNull();
    });
  });
});


it("keeps the actual rail framed when a stale ref resolves absent", async () => {
  triggerRow.row = { triggerType: "immediate", releasedAt: new Date("2026-01-01") };
  resolveReading.value = { kind: "artifact_review_gate", state: { state: "absent" }, body: null };
  await runPage();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("resolve"))).toBe(true));
  await act(async () => { await Promise.resolve(); });
  const slot = document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!;
  expect(slot).not.toBeNull(); singleSlotFrame(slot);
  expect(slot.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  expect(slot.querySelector('[data-conformance-id="review-gate-placeholder"]')).not.toBeNull();
});

it("gives the internal produced-review wait one strong frame before its ref exists", async () => {
  row.templateSourceType = "internal"; row.status = "pending_approval";
  row.producedReviewPark = JSON.stringify({ status: "completed" });
  reviewSlot.reviewTaskId = null; reviewSlot.awaiting = true;
  triggerRow.row = { triggerType: "immediate", releasedAt: new Date("2026-01-01") };
  await runPage();
  await waitFor(() => expect(document.querySelector('[data-run-review-slot="working"]')).not.toBeNull());
  const slot = document.querySelector<HTMLElement>('[data-run-review-slot="working"]')!;
  singleSlotFrame(slot);
  expect(slot.querySelector('[data-conformance-id="review-gate-placeholder"]')).not.toBeNull();
});
