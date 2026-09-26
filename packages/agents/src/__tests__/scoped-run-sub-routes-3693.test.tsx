// @vitest-environment jsdom
/**
 * A SCOPED RUN'S SCHEDULE AND PERMISSIONS PAGES LIVE AT ITS HOME (cinatra#3693).
 *
 * cinatra#2809's acceptance, verbatim: "the bare route redirects anchored
 * non-personal instances after authorization; after authorization, a wrong
 * scoped instance path redirects to the canonical home and renders no instance
 * content before the redirect". The run page itself has kept that promise since
 * #2809; its two sub-screens did not. They took no scope, ran no home check and
 * published no scope crumb, so the scoped shell could not mount them at all.
 *
 * A2 — each sub-screen, AFTER its access door, compares ITS OWN address (its
 * scope base plus its own sub-path) with the run's canonical home plus the SAME
 * sub-path, exactly as the run page compares its own. The bare address and
 * another scope's address of an anchored run redirect there; the home address
 * renders; a flat run (unanchored, legacy, personal) stays on the bare route.
 * Comparing a bare path against a scoped one would redirect for ever, which is
 * why the base travels down rather than being assumed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-run-sub-routes-3693.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const TEAM_ID = "5d1c2b3a-7e6f-4a1b-8c9d-0e1f2a3b4c5d";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const TEAM_SCOPE: ScopeSurfaceRef = { kind: "team", id: TEAM_ID };
const ORG_BASE = scopeSurfaceBase(ORG_SCOPE);
const TEAM_BASE = scopeSurfaceBase(TEAM_SCOPE);
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const RUN_NAME = "Blog Draft Writer Agent (1)";
const ORG_ANCHOR = { v: 1, kind: "organization", id: ORG_ID };
const USER_ANCHOR = { v: 1, kind: "user", id: "user-1" };

const routerPush = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/agents" }));
const setRunTriggerMock = vi.hoisted(() => vi.fn());
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  anchor: null as unknown,
  gates: [] as unknown[],
  denied: false,
}));

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

async function thrownBy(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

import { PermissionsScreen, TriggerScreen } from "../instance-screens";

type SubScreen = typeof TriggerScreen;
const SUB_SCREENS: ReadonlyArray<[string, SubScreen]> = [
  ["trigger", TriggerScreen],
  ["permissions", PermissionsScreen],
];

beforeEach(() => {
  row.status = "pending_approval";
  row.anchor = ORG_ANCHOR;
  row.gates = [];
  row.denied = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe.each(SUB_SCREENS)("A2: the /%s sub-screen of an organization-anchored run", (sub, Screen) => {
  const home = `${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}/${sub}`;

  it("redirects the bare address to the run's home plus the same sub-path", async () => {
    const message = await thrownBy(() => Screen({ agentId: AGENT_ID, instanceId: RUN_ID }));
    expect(message).toBe(`redirect:${home}`);
  });

  it("redirects another scope's address to the run's own home", async () => {
    const message = await thrownBy(() =>
      Screen({
        agentId: AGENT_ID,
        instanceId: RUN_ID,
        scopeBase: TEAM_BASE,
        launchScope: TEAM_SCOPE,
        scopeTitle: "Growth",
      }),
    );
    expect(message).toBe(`redirect:${home}`);
  });

  it("renders at the home address, with the scope base and the scope's crumbs on its layout", async () => {
    const tree = await Screen({
      agentId: AGENT_ID,
      instanceId: RUN_ID,
      scopeBase: ORG_BASE,
      launchScope: ORG_SCOPE,
      scopeTitle: "Acme",
    });
    const layouts = elementsOf(tree).filter(
      (el) => (el.props as { activeTab?: unknown }).activeTab !== undefined,
    );
    expect(layouts).toHaveLength(1);
    const props = layouts[0].props as { scopeBase?: unknown; scopeCrumbEntries?: unknown };
    expect(props.scopeBase).toBe(ORG_BASE);
    expect(props.scopeCrumbEntries).toEqual([
      { prefix: ORG_BASE, label: "Acme" },
      { prefix: `${ORG_BASE}/agents`, label: "Agents" },
    ]);
  });

  it("answers a reader the access door refuses with not-found, never with the run's home", async () => {
    row.denied = true;
    const message = await thrownBy(() => Screen({ agentId: AGENT_ID, instanceId: RUN_ID }));
    expect(message).toBe("notFound");
  });
});

describe.each(SUB_SCREENS)("A2: the /%s sub-screen of a flat run stays on the bare route", (sub, Screen) => {
  it("an unanchored run renders at the bare address, as it always has", async () => {
    row.anchor = null;
    const tree = await Screen({ agentId: AGENT_ID, instanceId: RUN_ID });
    expect(elementsOf(tree).length).toBeGreaterThan(0);
  });

  it("a personal-anchored run read under /personal goes back to the bare address", async () => {
    row.anchor = USER_ANCHOR;
    const message = await thrownBy(() =>
      Screen({
        agentId: AGENT_ID,
        instanceId: RUN_ID,
        scopeBase: "/personal",
        launchScope: { kind: "personal" },
        scopeTitle: null,
      }),
    );
    expect(message).toBe(`redirect:/agents/${AGENT_ID}/${RUN_ID}/${sub}`);
  });
});
