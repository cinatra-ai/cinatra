// @vitest-environment jsdom
/**
 * A PERSONAL RUN NAMES ITS OWNER BESIDE ITS NAME (cinatra#3693).
 *
 * cinatra#2809, Change item 2, verbatim: "Flat fallbacks: unanchored/legacy/A2A
 * instances and PERSONAL-anchored ones (`/personal` is actor-relative; a run can
 * have other authorized viewers) stay on the bare routes, labeled Global /
 * Legacy / Personal (owner)." A personal run already stays on the bare route —
 * `/personal` means "mine" to whoever reads it, so it cannot be a run's home —
 * but nothing on its page said whose it was: the label had a function and no
 * caller.
 *
 * C1 — a personal-anchored run publishes "Personal (owner)" beside the run's
 *      name in the crumb that names the run; the trail still starts with Agents.
 * C2 — a scoped run and an unanchored run publish no owner label. (Global and
 *      Legacy are recorded, not drawn, in this slice: drawing them would change
 *      every existing bare run page.)
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/personal-run-owner-label-3693.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const ORG_BASE = scopeSurfaceBase(ORG_SCOPE);
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const RUN_NAME = "Blog Draft Writer Agent (1)";
const OWNER_LABEL = "Personal (owner)";
const ORG_ANCHOR = { v: 1, kind: "organization", id: ORG_ID };
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
import { PermissionsScreen, SetupScreen, TriggerScreen } from "../instance-screens";

beforeEach(() => {
  clearCrumbContributions();
  row.status = "pending_approval";
  row.anchor = USER_ANCHOR;
  row.gates = [];
  row.denied = false;
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

function renderBareRun(ownerLabel?: string) {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId={AGENT_ID}
        instanceId={RUN_ID}
        activeTab="run"
        templateName="Blog Draft Writer Agent"
        initialRunName={RUN_NAME}
        runId={RUN_ID}
        {...(ownerLabel ? { ownerLabel } : {})}
      >
        <section />
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

function trailOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  }).map((c) => ({ label: c.label, href: c.href }));
}

describe("the crumb that names the run", () => {
  it("C1: names the owner beside the run's name, the trail still starting with Agents", () => {
    renderBareRun(OWNER_LABEL);
    expect(trailOn(BARE_RUN)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: `${RUN_NAME} · ${OWNER_LABEL}`, href: BARE_RUN },
    ]);
  });

  it("C2: without an owner label it is exactly the run's name, as before", () => {
    renderBareRun();
    expect(trailOn(BARE_RUN)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: RUN_NAME, href: BARE_RUN },
    ]);
  });
});

type Screen = typeof SetupScreen;
const SCREENS: ReadonlyArray<[string, Screen]> = [
  ["the run page", SetupScreen],
  ["the schedule page", TriggerScreen],
  ["the permissions page", PermissionsScreen],
];

async function ownerLabelOn(screen: Screen, scoped: Record<string, unknown> = {}) {
  const layouts = elementsOf(await screen({ agentId: AGENT_ID, instanceId: RUN_ID, ...scoped })).filter(
    (el) => (el.props as { activeTab?: unknown }).activeTab !== undefined,
  );
  expect(layouts).toHaveLength(1);
  return (layouts[0].props as { ownerLabel?: unknown }).ownerLabel ?? null;
}

describe.each(SCREENS)("%s hands the owner label to its layout", (_name, screen) => {
  it("C1: a personal-anchored run carries Personal (owner)", async () => {
    expect(await ownerLabelOn(screen)).toBe(OWNER_LABEL);
  });

  it("C2: an unanchored run carries none", async () => {
    row.anchor = null;
    expect(await ownerLabelOn(screen)).toBeNull();
  });

  it("C2: a scoped run carries none", async () => {
    row.anchor = ORG_ANCHOR;
    expect(
      await ownerLabelOn(screen, { scopeBase: ORG_BASE, launchScope: ORG_SCOPE, scopeTitle: "Acme" }),
    ).toBeNull();
  });
});
