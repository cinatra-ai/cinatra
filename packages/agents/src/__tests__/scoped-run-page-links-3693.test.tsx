// @vitest-environment jsdom
/**
 * EVERY LINK THE RUN PAGE OFFERS KEEPS THE RUN'S SCOPE (cinatra#3693).
 *
 * cinatra#2809, Change item 3: "on a persisted instance it is the instance's
 * HOME scope, never the path wandered in through". A run started from a
 * scope's Agents tab already opens under that scope; every way OUT of its page
 * used to be spelled by hand as the bare `/agents/...` address — the Setup,
 * Schedule and Permissions tabs, the settled review link, the Run button's
 * return address, the watcher's hand-off to the schedule step, the schedule
 * form's return and the "View this run" link — so one press took the reader
 * out of the scope they were standing in.
 *
 * B1 — for a run read under /organizations/<id>, each of them starts with that
 *      base.
 * B2 — for an unscoped run each of them is byte-identical to what it was.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-run-page-links-3693.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const ORG_BASE = scopeSurfaceBase(ORG_SCOPE);
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const RUN_NAME = "Blog Draft Writer Agent (1)";
const ORG_ANCHOR = { v: 1, kind: "organization", id: ORG_ID };
const BARE_RUN = `/agents/${AGENT_ID}/${RUN_ID}`;
const SCOPED_RUN = `${ORG_BASE}${BARE_RUN}`;

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
  packageName: "@cinatra-ai/blog-draft-writer-agent",
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

vi.mock("../artifact-review-gate-store", () => ({
  listReviewGatesForRun: vi.fn(async () => row.gates),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
  readVerificationRecordsForGates: vi.fn(async () => []),
}));

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

import { AgentInstanceNav } from "@/components/agent-instance-nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPageLayout } from "../agent-page-layout";
import { SetupCompletionWatcher } from "../setup-completion-watcher";
import { TriggerScreenClient } from "../trigger-screen-client";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";
import { RunAgentButton } from "../run-dialog";
import { SetupScreen, TriggerScreen } from "../instance-screens";

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
  row.anchor = ORG_ANCHOR;
  row.gates = [];
  row.denied = false;
  row.templateType = "orchestrator";
  row.noTrigger = false;
  panelProps.last = null;
  nav.pathname = SCOPED_RUN;
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

function tabHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

// ---------------------------------------------------------------------------
// The tab strip.
// ---------------------------------------------------------------------------

describe("the Setup / Schedule / Permissions tabs", () => {
  it("B1: under /organizations/<id>, every tab starts with that base", () => {
    const { container } = render(
      <AgentInstanceNav
        agentId={AGENT_ID}
        instanceId={RUN_ID}
        activeTab="setup"
        showTriggerTab
        scopeBase={ORG_BASE}
      />,
    );
    expect(tabHrefs(container)).toEqual([SCOPED_RUN, `${SCOPED_RUN}/trigger`, `${SCOPED_RUN}/permissions`]);
  });

  it("B2: for an unscoped run the tabs are byte-identical to today", () => {
    const { container } = render(
      <AgentInstanceNav agentId={AGENT_ID} instanceId={RUN_ID} activeTab="setup" showTriggerTab />,
    );
    expect(tabHrefs(container)).toEqual([BARE_RUN, `${BARE_RUN}/trigger`, `${BARE_RUN}/permissions`]);
  });

  it("B1: the run page's layout hands its scope base to the tab strip", () => {
    const { container } = render(
      <TooltipProvider>
        <AgentPageLayout
          agentId={AGENT_ID}
          instanceId={RUN_ID}
          activeTab="setup"
          templateName="Blog Draft Writer Agent"
          initialRunName={RUN_NAME}
          runId={RUN_ID}
          showTriggerTab
          scopeBase={ORG_BASE}
        >
          <section />
        </AgentPageLayout>
      </TooltipProvider>,
    );
    expect(tabHrefs(container)).toEqual([SCOPED_RUN, `${SCOPED_RUN}/trigger`, `${SCOPED_RUN}/permissions`]);
  });
});

// ---------------------------------------------------------------------------
// The watcher's hand-off to the schedule step.
// ---------------------------------------------------------------------------

function renderWatcher(scopeBase?: string) {
  return render(
    <SetupCompletionWatcher
      runId={RUN_ID}
      agentId={AGENT_ID}
      instanceId={RUN_ID}
      agUiEnabled={false}
      initialStatus="completed"
      initialError={null}
      initialMessages={[]}
      requiredFields={[]}
      initialInputParams={{}}
      {...(scopeBase ? { scopeBase } : {})}
    />,
  );
}

describe("the watcher's push to the schedule step", () => {
  it("B1: keeps the base", () => {
    renderWatcher(ORG_BASE);
    expect(routerPush).toHaveBeenCalledWith(`${SCOPED_RUN}/trigger`);
  });

  it("B2: is byte-identical for an unscoped run", () => {
    renderWatcher();
    expect(routerPush).toHaveBeenCalledWith(`${BARE_RUN}/trigger`);
  });

  it("hands the base on to the run panel it draws, for the panel's own restart", () => {
    renderWatcher(ORG_BASE);
    expect(panelProps.last?.scopeBase).toBe(ORG_BASE);
  });
});

// ---------------------------------------------------------------------------
// The schedule form's return push.
// ---------------------------------------------------------------------------

async function pressRunRightAfterSetup(scopeBase?: string) {
  setRunTriggerMock.mockResolvedValueOnce({ ok: true, runId: RUN_ID, jobSchedulerId: null });
  render(
    <TriggerScreenClient
      agentId={AGENT_ID}
      instanceId={RUN_ID}
      templateId="tmpl-3693"
      inputParams={{}}
      requiredFields={[]}
      properties={{}}
      setupComplete
      {...(scopeBase ? { scopeBase } : {})}
    />,
  );
  fireEvent.click(screen.getByText("Continue"));
  await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
}

describe("the schedule form's return to the run", () => {
  it("B1: keeps the base", async () => {
    await pressRunRightAfterSetup(ORG_BASE);
    expect(routerPush).toHaveBeenCalledWith(SCOPED_RUN);
  });

  it("B2: is byte-identical for an unscoped run", async () => {
    await pressRunRightAfterSetup();
    expect(routerPush).toHaveBeenCalledWith(BARE_RUN);
  });
});

// ---------------------------------------------------------------------------
// The server-rendered run page and its schedule page.
// ---------------------------------------------------------------------------

type Scoped = { scopeBase?: string; launchScope?: ScopeSurfaceRef; scopeTitle?: string };
const AT_HOME: Scoped = { scopeBase: ORG_BASE, launchScope: ORG_SCOPE, scopeTitle: "Acme" };

async function runPage(scoped: Scoped) {
  return elementsOf(await SetupScreen({ agentId: AGENT_ID, instanceId: RUN_ID, ...scoped }));
}

function propsOf(elements: React.ReactElement[], name: string): unknown[] {
  return elements
    .filter((el) => name in (el.props as Record<string, unknown>))
    .map((el) => (el.props as Record<string, unknown>)[name]);
}

describe("the run page's links (SetupScreen)", () => {
  it("B1: the settled review link base starts with the base, and the run panel is handed it", async () => {
    const elements = await runPage(AT_HOME);
    const bases = propsOf(elements, "reviewHrefBase");
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) expect(base).toBe(`${SCOPED_RUN}/review`);
    const panels = elements.filter((el) => el.type === OrchestratorStepperPanel);
    expect(panels).toHaveLength(1);
    expect((panels[0].props as { scopeBase?: unknown }).scopeBase).toBe(ORG_BASE);
  });

  it("B1: the watcher of an agentic run is handed the base", async () => {
    row.templateType = "agentic";
    const elements = await runPage(AT_HOME);
    const watchers = elements.filter((el) => el.type === SetupCompletionWatcher);
    expect(watchers).toHaveLength(1);
    expect((watchers[0].props as { scopeBase?: unknown }).scopeBase).toBe(ORG_BASE);
  });

  it("B1: the schedule step's form is handed the base for its return push", async () => {
    row.status = "pending_trigger";
    row.noTrigger = true;
    const forms = (await runPage(AT_HOME)).filter((el) => el.type === TriggerScreenClient);
    expect(forms).toHaveLength(1);
    expect((forms[0].props as { scopeBase?: unknown }).scopeBase).toBe(ORG_BASE);
  });

  it("B1: the Run button returns to the scoped run", async () => {
    row.status = "pending_input";
    const buttons = (await runPage(AT_HOME)).filter((el) => el.type === RunAgentButton);
    expect(buttons).toHaveLength(1);
    expect((buttons[0].props as { redirectTo?: unknown }).redirectTo).toBe(SCOPED_RUN);
  });

  it("B2: for an unscoped run the review link base and the Run button are byte-identical", async () => {
    row.anchor = null;
    const bases = propsOf(await runPage({}), "reviewHrefBase");
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) expect(base).toBe(`${BARE_RUN}/review`);
    row.status = "pending_input";
    const buttons = (await runPage({})).filter((el) => el.type === RunAgentButton);
    expect((buttons[0].props as { redirectTo?: unknown }).redirectTo).toBe(BARE_RUN);
  });
});

describe("the schedule page's links (TriggerScreen)", () => {
  function finishedRunLink(elements: React.ReactElement[]) {
    const links = elements.filter(
      (el) => (el.props as Record<string, unknown>)["data-action"] === "open-finished-run",
    );
    expect(links).toHaveLength(1);
    return (links[0].props as { href?: unknown }).href;
  }

  it("B1: 'View this run' starts with the base", async () => {
    row.status = "completed";
    const elements = elementsOf(await TriggerScreen({ agentId: AGENT_ID, instanceId: RUN_ID, ...AT_HOME }));
    expect(finishedRunLink(elements)).toBe(SCOPED_RUN);
  });

  it("B2: for an unscoped run 'View this run' is byte-identical", async () => {
    row.status = "completed";
    row.anchor = null;
    const elements = elementsOf(await TriggerScreen({ agentId: AGENT_ID, instanceId: RUN_ID }));
    expect(finishedRunLink(elements)).toBe(BARE_RUN);
  });
});
