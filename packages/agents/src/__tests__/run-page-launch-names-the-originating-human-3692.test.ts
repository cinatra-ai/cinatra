/**
 * A RUN STARTED FROM THE RUN PAGE NAMES THE HUMAN WHO STARTED IT (cinatra#3692).
 *
 * WHAT WENT WRONG. The context routes offer a run the person's own artifacts
 * only when the run's frozen scope snapshot names the originating human and
 * that human is the run's owner. The snapshot takes the originating human ONLY
 * from an explicit `HumanUser` scope actor on the create input, and the run
 * page's three launch producers passed none — so every run started from the run
 * page froze a snapshot that named nobody, and its context gate silently lost
 * the personal layer.
 *
 * WHAT IS TRUE NOW. Each producer resolves the session's own actor, the way the
 * assistant's in-process producer does, and passes it as the scope actor only
 * when it is the same human in the same organization as the session the run is
 * created for. With no resolvable actor, or a mismatched one, the run is created
 * exactly as before, with no scope actor.
 *
 * The store is mocked as a recorder with the REAL launch coordinator between the
 * producer and it, and the snapshot is computed by the store's own derivation
 * from the recorded input — so the assertion reads what the row would freeze.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { buildRunCreationAssignmentScopeSnapshot } from "../assignment-scope-snapshot";

const USER = "user-3692";
const ORG = "org-3692";
const RUN_ID = "run-3692";

const { StubRunTransitionError, TEMPLATE } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
  TEMPLATE: {
    id: "tmpl-3692",
    name: "Blog Draft Writer",
    packageName: "@cinatra/blog-draft-writer-agent",
    lifecycleConfig: null,
  },
}));

const readAgentRunById = vi.fn();
const transitionRunStatus = vi.fn();
const createAgentRunPendingInput = vi.fn();
const enqueueAgentRun = vi.fn();
const requireAuthSession = vi.fn();
const getActorContext = vi.fn();
const verifySessionAuthority = vi.fn();
const recordRunLifecycleMoment = vi.fn();

vi.mock("../store", () => ({
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: vi.fn(async () => ({ ...TEMPLATE })),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: vi.fn(async () => undefined),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  createAgentRun: vi.fn(),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...a),
  slugifyAgentTemplateName: (n: string) => n,
  readAllHitlPromptsForRun: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  getActorContext: (...a: unknown[]) => getActorContext(...a),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../auth-policy", () => ({ resolveTemplateVisibilityActor: vi.fn(async () => null) }));
vi.mock("../runtime-install-gate", () => ({
  assertAgentPackageRunnable: vi.fn(async () => null),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ markTriggerReleased: vi.fn(async () => undefined) }));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));
vi.mock("@/lib/org-archive/dispatch-precheck", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("../agent-run-serde", () => ({
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
}));

import {
  createPendingRunForZeroInputTemplate,
  createAndTriggerRun,
  createAndTriggerRunWithContext,
  startDevChildPreviewRun,
} from "../run-actions";
import type { AgentTemplateRecord } from "../store";

/** The session's own actor, as `getActorContext()` resolves it for a member. */
function sessionActor(over: Record<string, unknown> = {}) {
  return {
    principalType: "HumanUser",
    principalId: USER,
    organizationId: ORG,
    orgRole: "member",
    teamIds: ["team-3692"],
    projectGrants: [],
    ...over,
  };
}

const createdRun = {
  id: RUN_ID,
  templateId: TEMPLATE.id,
  orgId: ORG,
  runBy: USER,
  status: "pending_input",
  inputParams: {},
  lifecycleMoment: null,
};

/** The create input the store received for the Nth run this case created. */
function recordedInput(n = 0): Record<string, unknown> {
  const call = createAgentRunPendingInput.mock.calls[n];
  if (!call) throw new Error(`no run was created (call ${n})`);
  return call[0] as Record<string, unknown>;
}

/** The snapshot the store would freeze for that input — its own derivation. */
function frozenSnapshot(n = 0) {
  return buildRunCreationAssignmentScopeSnapshot(
    recordedInput(n) as Parameters<typeof buildRunCreationAssignmentScopeSnapshot>[0],
  );
}

/** Every run-page road, each called the way its surface calls it. */
const ROADS: ReadonlyArray<readonly [string, () => Promise<{ ok: boolean }>]> = [
  ["run_page_pending", () => createPendingRunForZeroInputTemplate({ templateSlug: "blog" })],
  ["run_page_create_and_trigger", () => createAndTriggerRun({ templateSlug: "blog" })],
  [
    "run_page_create_and_trigger (with context)",
    () =>
      createAndTriggerRunWithContext(USER, ORG, { ...TEMPLATE } as unknown as AgentTemplateRecord),
  ],
  ["run_page_dev_preview", () => startDevChildPreviewRun("@cinatra/blog-draft-writer-agent")],
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({
    user: { id: USER, role: "user" },
    session: { activeOrganizationId: ORG },
  });
  getActorContext.mockResolvedValue(sessionActor());
  verifySessionAuthority.mockResolvedValue({ kind: "session" });
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  createAgentRunPendingInput.mockResolvedValue({ ...createdRun });
  readAgentRunById.mockResolvedValue({ ...createdRun });
  transitionRunStatus.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
});

afterAll(() => {
  vi.clearAllMocks();
  for (const path of [
    "../store",
    "@/lib/auth-session",
    "@/lib/org-write/authority",
    "@/lib/org-write/run-creation-authority",
    "../auth-policy",
    "../runtime-install-gate",
    "../recommendation-hold",
    "@/lib/agent-run-enqueue",
    "../trigger-store",
    "../trigger-schedule",
    "../trigger-gate",
    "@/lib/pm-integration-providers",
    "@/lib/agent-run-readiness",
    "@/lib/org-archive/dispatch-precheck",
    "../agent-run-serde",
  ]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

describe("a run started from the run page names the human who started it (cinatra#3692)", () => {
  it("R1 run_page_pending: the snapshot carries the originating human", async () => {
    const result = await createPendingRunForZeroInputTemplate({ templateSlug: "blog" });
    expect(result.ok).toBe(true);

    const input = recordedInput();
    expect(input.launchProducer).toBe("run_page_pending");
    expect(input.scopeActor).toMatchObject({ principalType: "HumanUser", principalId: USER });
    expect(frozenSnapshot().originatingHumanUserId).toBe(USER);
    expect(frozenSnapshot().teamIds).toEqual(["team-3692"]);
  });

  it("R2 run_page_create_and_trigger (both callers): the snapshot carries the originating human", async () => {
    const plain = await createAndTriggerRun({ templateSlug: "blog" });
    expect(plain.ok).toBe(true);
    const withContext = await createAndTriggerRunWithContext(
      USER,
      ORG,
      { ...TEMPLATE } as unknown as AgentTemplateRecord,
    );
    expect(withContext.ok).toBe(true);

    for (const n of [0, 1]) {
      const input = recordedInput(n);
      expect(input.launchProducer).toBe("run_page_create_and_trigger");
      expect(input.scopeActor).toMatchObject({ principalType: "HumanUser", principalId: USER });
      expect(frozenSnapshot(n).originatingHumanUserId).toBe(USER);
    }
  });

  it("R3 run_page_dev_preview: the snapshot carries the originating human", async () => {
    const result = await startDevChildPreviewRun("@cinatra/blog-draft-writer-agent");
    expect(result.ok).toBe(true);

    const input = recordedInput();
    expect(input.launchProducer).toBe("run_page_dev_preview");
    expect(input.scopeActor).toMatchObject({ principalType: "HumanUser", principalId: USER });
    expect(frozenSnapshot().originatingHumanUserId).toBe(USER);
  });

  it("P1 with no resolvable actor every road creates the run exactly as before, naming nobody", async () => {
    getActorContext.mockResolvedValue(undefined);
    for (const [, road] of ROADS) {
      expect((await road()).ok).toBe(true);
    }
    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(ROADS.length);
    ROADS.forEach((_, n) => {
      expect("scopeActor" in recordedInput(n)).toBe(false);
      expect(frozenSnapshot(n).originatingHumanUserId).toBeUndefined();
    });
  });

  it("P5 a resolver that fails is no resolvable actor: every road still creates the run, naming nobody", async () => {
    getActorContext.mockRejectedValue(new Error("grant read failed"));
    for (const [, road] of ROADS) {
      expect((await road()).ok).toBe(true);
    }
    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(ROADS.length);
    ROADS.forEach((_, n) => {
      expect("scopeActor" in recordedInput(n)).toBe(false);
      expect(frozenSnapshot(n).originatingHumanUserId).toBeUndefined();
    });
  });

  it("P2 a mismatched actor is never borrowed: another human, another organization or a non-human principal", async () => {
    const mismatches = [
      sessionActor({ principalId: "someone-else" }),
      sessionActor({ organizationId: "another-org" }),
      sessionActor({ principalType: "ServiceAccount" }),
    ];
    let n = 0;
    for (const actor of mismatches) {
      getActorContext.mockResolvedValue(actor);
      for (const [, road] of ROADS) {
        expect((await road()).ok).toBe(true);
        expect("scopeActor" in recordedInput(n)).toBe(false);
        expect(frozenSnapshot(n).originatingHumanUserId).toBeUndefined();
        n += 1;
      }
    }
    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(mismatches.length * ROADS.length);
  });
});
