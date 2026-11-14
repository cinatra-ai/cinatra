// @vitest-environment jsdom
/**
 * THE NEW-SCHEDULE FORM'S PROMPT WINDOW IS THE PAGE CHROME'S TOO (cinatra#3487).
 *
 * `/trigger` reached with `new` draws the schedule form with no run to name
 * steps for. The schedule screen lends its one prompt window to the nearest run
 * page chrome instead of drawing its own, so this route has to stand inside a
 * chrome as the run's own schedule step does: without one the pre-run window
 * that fills the form from a sentence would not be drawn at all.
 *
 * The harness (mocks, fixtures, the element walk) is the scoped-links suite's
 * (`scoped-run-page-links-3693.test.tsx`), which reads TriggerScreen the same way.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/trigger-new-in-page-chrome-3487.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const AGENT_ID = "fixture-vendor/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const RUN_NAME = "Blog Draft Writer Agent (1)";

const routerPush = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/agents" }));
const setRunTriggerMock = vi.hoisted(() => vi.fn());
const panelProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  anchor: null as unknown,
  gates: [] as unknown[],
  denied: false,
  templateType: "orchestrator" as string,
  noTrigger: false,
}));

// The run panel the watcher mounts, reduced to the props it is handed.
vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: (props: Record<string, unknown>) => {
    panelProps.last = props;
    return <div data-testid="agentic-run-panel" />;
  },
}));

vi.mock("../run-name-actions", () => ({
  saveRunName: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@cinatra-ai/sdk-ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    InlinePageTitle: React.forwardRef(function InlinePageTitleStub({
      value,
      placeholder,
    }: {
      value: string;
      placeholder: string;
    }) {
      return <h1>{value || placeholder}</h1>;
    }),
  };
});

const TEMPLATE = {
  id: "tmpl-3693",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Draft Writer Agent",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: {
    properties: { idea: { type: "string", title: "idea" } },
    required: [] as string[],
  },
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@fixture-vendor/blog-draft-writer-agent",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: {
    steps: [{ stepNumber: 1, xRenderer: "cinatra/review", name: "Draft the post" }],
  },
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: { idea: "a post about scopes" },
    stepResults: null,
    startedAt: new Date("2026-01-01"),
    completedAt: null,
    error: null,
    title: RUN_NAME,
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
    streamedText: "",
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
    launchScopeAnchor: row.anchor,
  };
}

// ── The data layer the screens read (the run-page suites' own edges). ───────
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
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
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: () => <div data-testid="review-gate-card" />,
}));

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

vi.mock("@cinatra-ai/extensions/scope-containment-filter", () => ({
  allowedScopeIdentitiesFromPolicy: vi.fn(() => []),
}));

vi.mock("../started-run-store", () => ({
  readStartedRunsFor: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: vi.fn(async () =>
    row.templateType === "agentic"
      ? { ...TEMPLATE, type: "agentic", approvalPolicy: { steps: [] } }
      : TEMPLATE,
  ),
  readAgentRunById: vi.fn(async () => {
    if (row.denied) {
      const { AuthzError } = await import("@/lib/authz");
      throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." });
    }
    return makeRun();
  }),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => RUN_NAME),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", () => ({
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner", runListVisibility: ["owner"] })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../artifact-review-gate-store", async () => {
  // cinatra#3046 — the run page also asks the store whether the run is parked on
  // the review its own output opened. That predicate is PURE: it answers from the
  // run row it is handed, so this factory hands the suite the REAL one (re-exported
  // by the store from its writer) instead of a stub that could answer differently
  // from the page under test.
  const hold = await vi.importActual<typeof import("../run-produced-review-hold")>(
    "../run-produced-review-hold",
  );
  return {
    listReviewGatesForRun: vi.fn(async () => row.gates),
    readReviewGate: vi.fn(async () => null),
    readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
    readVerificationRecordsForGates: vi.fn(async () => []),
    isParkedOnProducedReview: hold.isParkedOnProducedReview,
  };
});

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
}));

vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => null),
}));

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false })),
  setRunTrigger: (args: unknown) => setRunTriggerMock(args),
}));

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () =>
    row.noTrigger
      ? null
      : {
          triggerType: "immediate",
          releasedAt: new Date("2026-09-14T11:00:00Z"),
        },
  ),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => TEMPLATE.inputSchema),
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

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: null,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

/**
 * Every element of a server-rendered tree, props included, without rendering
 * it — through arrays and the plain objects a rail's step list is made of.
 */
function elementsOf(
  node: unknown,
  out: React.ReactElement[] = [],
  seen: Set<object> = new Set(),
): React.ReactElement[] {
  if (node == null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out, seen);
    return out;
  }
  if (React.isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elementsOf(value, out, seen);
    return out;
  }
  if (Object.getPrototypeOf(node) === Object.prototype) {
    for (const value of Object.values(node as Record<string, unknown>)) elementsOf(value, out, seen);
  }
  return out;
}

import { TriggerScreenClient } from "../trigger-screen-client";
import { RunPageChrome } from "../run-page-chrome";
import { TriggerScreen } from "../instance-screens";

class StubEventSource {
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
  row.status = "pending_approval";
  row.anchor = null;
  row.gates = [];
  row.denied = false;
  row.templateType = "orchestrator";
  row.noTrigger = false;
  panelProps.last = null;
  nav.pathname = `/agents/${AGENT_ID}/new/trigger`;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("/trigger with `new`: the schedule form stands inside the run page chrome", () => {
  it("draws the schedule form as a descendant of RunPageChrome", async () => {
    const page = await TriggerScreen({ agentId: AGENT_ID, instanceId: "new" });
    const all = elementsOf(page);
    const forms = all.filter((el) => el.type === TriggerScreenClient);
    expect(forms).toHaveLength(1);
    const chromes = all.filter((el) => el.type === RunPageChrome);
    expect(chromes).toHaveLength(1);
    const inside = elementsOf((chromes[0].props as { children?: unknown }).children);
    expect(inside.filter((el) => el.type === TriggerScreenClient)).toHaveLength(1);
  });
});
