// @vitest-environment jsdom
/**
 * THE RUN PAGE NAMES ITS RUN AS THE SKILLS PANE DOES (cinatra#4453).
 *
 * The components drawing, Breadcrumb section: "under an agent instance the trail
 * names the agent's display name", and while a name is genuinely unavailable the
 * crumb shows the id's first eight characters plus an ellipsis. The run page and
 * the skills pane read the run's name with one read, `readRunCrumbIdentity`. The
 * run page used to name the run by the route's template without checking it was
 * the run's own, let a failing `ensureRunTitle` fail the page, and hand its
 * layout a blank title untrimmed, which the layout drew as a blank crumb.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-run-crumb-identity-4453.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";

const AGENT_ID = "fixture-vendor/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const USER_ANCHOR = { v: 1, kind: "user", id: "user-1" };
const BARE_RUN = `/agents/${AGENT_ID}/${RUN_ID}`;
const EPOCH = "anon";

const routerPush = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/agents" }));
const setRunTriggerMock = vi.hoisted(() => vi.fn());
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  anchor: null as unknown,
  gates: [] as unknown[],
  denied: false,
  title: null as string | null,
  templateId: "tmpl-3693",
  ensureFails: false,
  ownTemplate: null as { name: string } | null,
}));
const store = vi.hoisted(() => ({
  // The store's rule (store.ts, ensureRunTitle): a title stays; an untitled run
  // of a user is numbered and kept.
  ensureRunTitle: vi.fn(async (run: { title: string | null }, baseName: string) => {
    if (row.ensureFails) throw new Error("database down");
    return run.title?.trim() || `${baseName} (1)`;
  }),
  readAgentTemplateById: vi.fn(async () => row.ownTemplate),
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
    templateId: row.templateId,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: { idea: "a post about scopes" },
    stepResults: null,
    startedAt: new Date("2026-01-01"),
    completedAt: null,
    error: null,
    title: row.title,
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
  readAgentTemplateBySlug: vi.fn(async () => TEMPLATE),
  readAgentRunById: vi.fn(async () => {
    if (row.denied) {
      const { AuthzError } = await import("@/lib/authz");
      throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." });
    }
    return makeRun();
  }),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: store.ensureRunTitle,
  readAgentTemplateById: store.readAgentTemplateById,
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
  readRunTriggerByRunId: vi.fn(async () => ({
    triggerType: "immediate",
    releasedAt: new Date("2026-09-14T11:00:00Z"),
  })),
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPageLayout } from "../agent-page-layout";
import { SetupScreen } from "../instance-screens";

beforeEach(() => {
  clearCrumbContributions();
  row.status = "pending_approval";
  row.anchor = USER_ANCHOR;
  row.gates = [];
  row.denied = false;
  row.title = null;
  row.templateId = TEMPLATE.id;
  row.ensureFails = false;
  row.ownTemplate = null;
  nav.pathname = BARE_RUN;
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});


function renderLayout(props: { initialRunName: string; runFallbackName?: string }) {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId={AGENT_ID}
        instanceId={RUN_ID}
        activeTab="run"
        templateName="Blog Draft Writer Agent"
        runId={RUN_ID}
        {...props}
      >
        <section />
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

function runCrumbOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  }).map((c) => c.label)[1];
}

async function runPageLayoutProps() {
  const layouts = elementsOf(await SetupScreen({ agentId: AGENT_ID, instanceId: RUN_ID })).filter(
    (el) => (el.props as { activeTab?: unknown }).activeTab !== undefined,
  );
  expect(layouts).toHaveLength(1);
  const p = layouts[0].props as { initialRunName: string; runFallbackName?: string };
  return { initialRunName: p.initialRunName, runFallbackName: p.runFallbackName };
}

describe("the run page's name for its run", () => {
  beforeEach(() => {
    row.anchor = null;
  });

  it("numbers an untitled started run by the route's template when it is the run's own, reading no template again", async () => {
    expect(await runPageLayoutProps()).toEqual({
      initialRunName: "Blog Draft Writer Agent (1)",
      runFallbackName: "Blog Draft Writer Agent",
    });
    expect(store.readAgentTemplateById).not.toHaveBeenCalled();
    expect(store.ensureRunTitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID }),
      "Blog Draft Writer Agent",
    );
  });

  it("draws the page when the numbered name cannot be written, the template naming the run", async () => {
    row.ensureFails = true;
    expect(await runPageLayoutProps()).toEqual({
      initialRunName: "",
      runFallbackName: "Blog Draft Writer Agent",
    });
  });

  it("hands a run waiting for its first input with a blank title no blank name", async () => {
    row.status = "pending_input";
    row.title = "   ";
    expect(await runPageLayoutProps()).toEqual({
      initialRunName: "",
      runFallbackName: "Blog Draft Writer Agent",
    });
    expect(store.ensureRunTitle).not.toHaveBeenCalled();
  });

  it("names the run by its own template when the route's template is another", async () => {
    row.templateId = "tmpl-own";
    row.ownTemplate = { name: "Blog Idea Generator" };
    expect(await runPageLayoutProps()).toEqual({
      initialRunName: "Blog Idea Generator (1)",
      runFallbackName: "Blog Idea Generator",
    });
    expect(store.readAgentTemplateById).toHaveBeenCalledWith("tmpl-own");
  });

  it("falls back to the id's first eight characters when the run's own template is gone", async () => {
    row.templateId = "tmpl-gone";
    row.ownTemplate = null;
    expect(await runPageLayoutProps()).toEqual({
      initialRunName: "",
      runFallbackName: `${RUN_ID.slice(0, 8)}…`,
    });
    expect(store.ensureRunTitle).not.toHaveBeenCalled();
  });
});

describe("the run's crumb the layout publishes", () => {
  it("draws the template's name, not a blank crumb, for a blank run name", () => {
    renderLayout({ initialRunName: "   " });
    expect(runCrumbOn(BARE_RUN)).toBe("Blog Draft Writer Agent");
  });

  it("draws the server's fallback for the run before the route's template name", () => {
    renderLayout({ initialRunName: "", runFallbackName: "Blog Idea Generator" });
    expect(runCrumbOn(BARE_RUN)).toBe("Blog Idea Generator");
  });

  it("draws the run's own name, trimmed", () => {
    renderLayout({ initialRunName: "  Launch notes ", runFallbackName: "Blog Idea Generator" });
    expect(runCrumbOn(BARE_RUN)).toBe("Launch notes");
  });
});
