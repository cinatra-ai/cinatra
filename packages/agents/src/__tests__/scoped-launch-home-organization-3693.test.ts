// @vitest-environment jsdom
/**
 * A RUN STARTED FROM A SCOPE BELONGS TO THAT SCOPE'S ORGANIZATION (cinatra#3693).
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-launch-home-organization-3693.test.ts
 *
 * The owner's decision on cinatra#3693: "A run started from the Agents tab of an
 * organization's, team's or project's scope belongs to **that scope's
 * organization**, whatever the session's active organization is." The ratified
 * drawing: "A run started from an organization's, a team's or a project's scope
 * belongs to that scope's organization, whatever organization the session has
 * active."
 *
 * C1 — a launch from organization B's scope while A is active creates the run
 *      in B, and a launch from a team and a project of B the same.
 * C2 — a launch from the workspace scope, the personal scope and the bare
 *      launcher creates the run in the active organization A, as before.
 * C3 — a reader the scope resolves no member organization for gets no run: the
 *      launcher answers not-found and creates nothing. (The membership
 *      authority the create mints in that organization stays the create's own,
 *      and fails closed on its own for a non-member.)
 *
 * The scope's organization is read the way the scope's own Agents tab reads it
 * — through the eligibility loader's membership-fenced vantage — so it is
 * stubbed here at that one seam, with the store and the create.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_A = "org-A";
const ORG_B = "org-B";
const AGENT_ID = "cinatra-ai/blog-idea-generator";

const mocks = vi.hoisted(() => ({
  createAndTriggerRunWithContext: vi.fn(),
  readScopeSurfaceOrganizationId: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1", name: "A", email: "a@b.c" },
    session: { activeOrganizationId: ORG_A },
  })),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  requireActorContext: vi.fn(),
  resolveActorGrantsForUserInOrg: vi.fn(async () => []),
}));

vi.mock("@/lib/scope-surface-eligibility.server", () => ({
  readScopeSurfaceOrganizationId: mocks.readScopeSurfaceOrganizationId,
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readProjectOrganizationFacts: vi.fn(async () => []),
  readProjectAgentTemplateBindings: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: vi.fn(async () => ({
    id: "tmpl-3693",
    name: "Blog Idea Generator",
    packageName: "@cinatra-ai/blog-idea-generator",
    packageVersion: "1.0.0",
  })),
  readAgentRunById: vi.fn(async () => null),
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

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: mocks.createAndTriggerRunWithContext,
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
}));

vi.mock("../run-sharing-actions", () => ({ removeRunOwner: vi.fn() }));

// The rest of the run page's data layer, stubbed as its other suites stub it:
// the launcher reads none of it, but the module graph imports it.
vi.mock("../artifact-review-gate-store", () => ({
  listReviewGatesForRun: vi.fn(async () => []),
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
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));
vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));
vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => null),
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
vi.mock("../run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { SetupScreen } from "../instance-screens";
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectOrganizationFacts,
  readProjectsForUser,
} from "@/lib/better-auth-db";

async function launch(
  launchScope: ScopeSurfaceRef | undefined,
  scopeBase: string | undefined,
): Promise<string | null> {
  try {
    await SetupScreen({ agentId: AGENT_ID, instanceId: "new", scopeBase, launchScope });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeEach(() => {
  mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: true, runId: "run-new" });
  mocks.readScopeSurfaceOrganizationId.mockResolvedValue(ORG_B);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("C1: a launch from a scope of organization B creates the run in B while A is active (cinatra#3693)", () => {
  for (const [scope, base] of [
    [{ kind: "organization", id: ORG_B }, `/organizations/${ORG_B}`],
    [{ kind: "team", id: "team-of-B" }, "/teams/team-of-B"],
    [{ kind: "project", id: "project-of-B" }, "/projects/project-of-B"],
  ] as const) {
    it(`${scope.kind} — the run's organization is the scope's, not the session's`, async () => {
      const message = await launch(scope, base);
      expect(message).toBe(`REDIRECT:${base}/agents/${AGENT_ID}/run-new`);
      expect(mocks.readScopeSurfaceOrganizationId).toHaveBeenCalledWith(scope);
      expect(mocks.createAndTriggerRunWithContext).toHaveBeenCalledTimes(1);
      const [userId, orgId, , anchor] = mocks.createAndTriggerRunWithContext.mock.calls[0];
      expect(userId).toBe("user-1");
      expect(orgId).toBe(ORG_B);
      // The anchor is still the vantage the run was launched from.
      expect(anchor).toEqual({ v: 1, kind: scope.kind, id: scope.id });
    });
  }
});

describe("C2: a launch from the workspace, the personal scope or the bare launcher stays in A (cinatra#3693)", () => {
  for (const [label, scope, base] of [
    ["workspace", { kind: "workspace" }, "/workspace"],
    ["personal", { kind: "personal" }, "/personal"],
    ["bare launcher", undefined, undefined],
  ] as const) {
    it(`${label} — the run is created in the session's active organization`, async () => {
      await launch(scope, base);
      expect(mocks.readScopeSurfaceOrganizationId).not.toHaveBeenCalled();
      expect(mocks.createAndTriggerRunWithContext).toHaveBeenCalledTimes(1);
      expect(mocks.createAndTriggerRunWithContext.mock.calls[0][1]).toBe(ORG_A);
    });
  }
});

describe("C3: a reader the scope resolves no member organization for gets no run (cinatra#3693)", () => {
  it("answers not-found and creates nothing", async () => {
    mocks.readScopeSurfaceOrganizationId.mockResolvedValue(null);
    const message = await launch({ kind: "organization", id: "org-C" }, "/organizations/org-C");
    expect(message).toBe("NEXT_NOT_FOUND");
    expect(mocks.createAndTriggerRunWithContext).not.toHaveBeenCalled();
  });
});

describe("C4: the scope's organization is read through the reader's membership-fenced vantage (cinatra#3693)", () => {
  // The REAL resolver, over the membership stores stubbed at their boundary: the
  // reader is a member of A (active) and of B; team-of-B belongs to B; the
  // project's row carries no organization of its own and is owned by team-of-B,
  // so it derives B as the eligibility loader derives it. org-C and team-of-C
  // are reached through no membership.
  type Resolver = typeof import("@/lib/scope-surface-eligibility.server");
  let actual: Resolver["readScopeSurfaceOrganizationId"];

  beforeEach(async () => {
    actual = (await vi.importActual<Resolver>("@/lib/scope-surface-eligibility.server"))
      .readScopeSurfaceOrganizationId;
    mocks.readScopeSurfaceOrganizationId.mockImplementation((scope: ScopeSurfaceRef) => actual(scope));
    vi.mocked(readOrgsWithTeamsForUserActiveOnly).mockResolvedValue([
      { id: ORG_A, teams: [{ id: "team-of-A" }] },
      { id: ORG_B, teams: [{ id: "team-of-B" }] },
    ] as never);
    vi.mocked(readProjectsForUser).mockImplementation((async () => [{ id: "project-of-B" }]) as never);
    vi.mocked(readProjectOrganizationFacts).mockResolvedValue([
      { id: "project-of-B", organizationId: null, ownerLevel: "team", ownerId: "team-of-B" },
    ] as never);
  });

  for (const [scope, expected] of [
    [{ kind: "organization", id: ORG_B }, ORG_B],
    [{ kind: "team", id: "team-of-B" }, ORG_B],
    [{ kind: "project", id: "project-of-B" }, ORG_B],
    [{ kind: "organization", id: "org-C" }, null],
    [{ kind: "team", id: "team-of-C" }, null],
    [{ kind: "workspace" }, null],
  ] as const) {
    it(`${scope.kind} ${"id" in scope ? scope.id : ""} resolves ${expected ?? "no organization"}`, async () => {
      expect(await actual(scope as ScopeSurfaceRef)).toBe(expected);
    });
  }

  it("a launch from team-of-B creates the run in B through the real resolver", async () => {
    const message = await launch({ kind: "team", id: "team-of-B" }, "/teams/team-of-B");
    expect(message).toBe(`REDIRECT:/teams/team-of-B/agents/${AGENT_ID}/run-new`);
    expect(mocks.createAndTriggerRunWithContext.mock.calls[0][1]).toBe(ORG_B);
  });

  it("a launch from a non-member organization's scope is not-found and creates nothing", async () => {
    const message = await launch({ kind: "organization", id: "org-C" }, "/organizations/org-C");
    expect(message).toBe("NEXT_NOT_FOUND");
    expect(mocks.createAndTriggerRunWithContext).not.toHaveBeenCalled();
  });
});
