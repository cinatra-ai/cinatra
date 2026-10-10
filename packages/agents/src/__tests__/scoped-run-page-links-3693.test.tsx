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
 * B3: for a PERSONAL run (cinatra#3786) every ADDRESS stays bare, which is
 *      what the module's design says, and the successor controls are handed
 *      `/personal`, the launcher that mints the user anchor, instead of the
 *      bare road that wrote the successor with no anchor at all.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-run-page-links-3693.test.tsx
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const ORG_BASE = scopeSurfaceBase(ORG_SCOPE);
const AGENT_ID = "fixture-vendor/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const RUN_NAME = "Blog Draft Writer Agent (1)";
const ORG_ANCHOR = { v: 1, kind: "organization", id: ORG_ID };
const TEAM_ID = "b1e0c7a4-4f2b-4d6e-9a31-5c8f0d2e7a64";
const TEAM_SCOPE: ScopeSurfaceRef = { kind: "team", id: TEAM_ID };
const TEAM_BASE = scopeSurfaceBase(TEAM_SCOPE);
const TEAM_ANCHOR = { v: 1, kind: "team", id: TEAM_ID };
const OWNER_ID = "user-1";
const USER_ANCHOR = { v: 1, kind: "user", id: OWNER_ID };
const PERSONAL_BASE = "/personal";
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

function renderWatcher(scopeBase?: string, launchBase?: string) {
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
      {...(launchBase ? { launchBase } : {})}
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

  it("hands the LAUNCH base on to the run panel it draws, for the panel's own restart", () => {
    renderWatcher(ORG_BASE, ORG_BASE);
    expect(panelProps.last?.launchBase).toBe(ORG_BASE);
  });

  it("forwards the launch base it is given, never the address base beside it (cinatra#3786)", () => {
    // The two part on a personal run: the run is addressed bare and its
    // successor is launched from `/personal`.
    renderWatcher(undefined, PERSONAL_BASE);
    expect(panelProps.last?.launchBase).toBe(PERSONAL_BASE);
    expect(panelProps.last?.scopeBase).toBeUndefined();
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
    expect((panels[0].props as { launchBase?: unknown }).launchBase).toBe(ORG_BASE);
  });

  it("B1: the watcher of an agentic run is handed the base", async () => {
    row.templateType = "agentic";
    const elements = await runPage(AT_HOME);
    const watchers = elements.filter((el) => el.type === SetupCompletionWatcher);
    expect(watchers).toHaveLength(1);
    expect((watchers[0].props as { scopeBase?: unknown }).scopeBase).toBe(ORG_BASE);
    expect((watchers[0].props as { launchBase?: unknown }).launchBase).toBe(ORG_BASE);
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

/**
 * THE PERSONAL RUN: A FLAT ADDRESS, A SCOPED LAUNCH (cinatra#3786).
 *
 * The run itself is addressed bare, which is the module's own design: the
 * `/personal` base names the reader, and a run has other authorized readers. A
 * LAUNCH has no such reader, so the successor controls open the personal
 * launcher: the one mint that stamps the fresh run with a user anchor. Before
 * this, they were handed the same null the addresses take, opened the bare
 * launcher, and the successor was written with no anchor at all.
 */
describe("a personal run's successor controls (cinatra#3786)", () => {
  function stepperOf(elements: React.ReactElement[]) {
    const panels = elements.filter((el) => el.type === OrchestratorStepperPanel);
    expect(panels).toHaveLength(1);
    return panels[0].props as Record<string, unknown>;
  }

  it("B3: hands /personal to the stepper panel while every address stays BARE", async () => {
    row.anchor = USER_ANCHOR;
    nav.pathname = BARE_RUN;
    const elements = await runPage({});
    expect(stepperOf(elements).launchBase).toBe(PERSONAL_BASE);
    // …and nothing about the run's own address moves with it.
    const bases = propsOf(elements, "reviewHrefBase");
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) expect(base).toBe(`${BARE_RUN}/review`);
    for (const base of propsOf(elements, "scopeBase")) expect(base).toBeNull();
  });

  it("B3: the Run button of a personal run still returns to the bare address", async () => {
    row.anchor = USER_ANCHOR;
    row.status = "pending_input";
    nav.pathname = BARE_RUN;
    const buttons = (await runPage({})).filter((el) => el.type === RunAgentButton);
    expect(buttons).toHaveLength(1);
    expect((buttons[0].props as { redirectTo?: unknown }).redirectTo).toBe(BARE_RUN);
  });

  it("B3: hands /personal to the agentic run's watcher, whose own address base stays null", async () => {
    row.anchor = USER_ANCHOR;
    row.templateType = "agentic";
    nav.pathname = BARE_RUN;
    const watchers = (await runPage({})).filter((el) => el.type === SetupCompletionWatcher);
    expect(watchers).toHaveLength(1);
    expect((watchers[0].props as { launchBase?: unknown }).launchBase).toBe(PERSONAL_BASE);
    expect((watchers[0].props as { scopeBase?: unknown }).scopeBase).toBeNull();
  });

  it("B3: a TEAM-anchored run is unchanged, both bases are the team's", async () => {
    row.anchor = TEAM_ANCHOR;
    nav.pathname = `${TEAM_BASE}${BARE_RUN}`;
    const elements = await runPage({ scopeBase: TEAM_BASE, launchScope: TEAM_SCOPE });
    expect(stepperOf(elements).launchBase).toBe(TEAM_BASE);
    const bases = propsOf(elements, "reviewHrefBase");
    for (const base of bases) expect(base).toBe(`${TEAM_BASE}${BARE_RUN}/review`);
  });

  it("B3: an UNANCHORED run is unchanged, the successor keeps the bare road", async () => {
    row.anchor = null;
    nav.pathname = BARE_RUN;
    expect(stepperOf(await runPage({})).launchBase).toBeNull();
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

/**
 * AND NO LINK MAY FALL BACK TO AN ADDRESS WITH NO SCOPE IN IT (cinatra#3693,
 * the second fix leg).
 *
 * The Run button's destination used to be optional over a bare
 * `/agents/<slug>/<run>/data` fallback. Its one caller has always passed a
 * scoped address, so the fallback was unreachable — and a second caller added
 * without one would have escaped the scope silently. The prop is required now,
 * which the type checker enforces at every call site; this pins that the
 * fallback text is actually gone rather than merely unreached.
 */
describe("the Run button names its own destination (cinatra#3693)", () => {
  it("keeps no bare fallback address in the dialog at all", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "run-dialog.tsx"),
      "utf8",
    );
    // No fallback expression, and no address composed here from the slug: the
    // helper that built one is gone with it.
    expect(source).not.toMatch(/redirectTo\s*\?\?/);
    expect(source).not.toMatch(/encodeSlug/);
    // The destination is the caller's, it is not optional, and it is the only
    // thing this dialog navigates to.
    expect(source).toContain("redirectTo: string;");
    expect(source).toContain("router.push(redirectTo);");
    expect(source.match(/router\.push\(/g)).toHaveLength(1);
  });
});
