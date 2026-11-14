/**
 * NO LATER DECLARED PAUSE READS SETTLED BEFORE THE RUN REACHED IT (cinatra#3035).
 *
 * `buildSubmissionMapByStepIndex` ties the run's stored human-gate answers to
 * the declared pauses by POSITION, in capture order. A review step marked by
 * the template (`artifactReviewTargetsInput`) is decided through its review
 * gate, which writes no human-gate answer, so the walk handed the NEXT pause's
 * answer to the marked review and left that next pause unanswered. Only when
 * the review core declines does the marked step pause as an ordinary gate and
 * store an answer of its own.
 *
 * The answer's keys cannot tell those two apart: the stored answer of an
 * ordinary gate is the card's whole envelope `{<field>, approved, approvedAt}`,
 * an answer with attachments is stored as `{text, attachments}`, and a bare
 * approval may store nothing at all. So the walk reads IDENTITY first (an
 * answer's `stepKey` is the task id its pause's gate group carries after
 * `wayflow-`), then TIME, only where it proves the order: a marked pause whose
 * next review-gate group (`wayflow-<task>`, `#2`, ...) was created at least
 * 2 ms before the next stored answer was decided through that group. Where the
 * order is not proven the walk stops, so no pause shows another pause's answer.
 *
 * What this locks:
 *   W1  a marked review decided through its gate takes no answer; the next
 *       pause keeps its own;
 *   W2  a marked review that fell back keeps its own answer, stored as the
 *       real envelope `{reviewApproval, approved, approvedAt}`;
 *   W3  W4  after a gate-decided marked review, a next pause that stored `null`
 *       or `{}` keeps that answer;
 *   W5  a marked step whose schema declares no properties still keeps its own
 *       envelope-only answer;
 *   W6  an attachment answer `{text, attachments}` of a fallen-back marked step
 *       stays its own;
 *   W7  `gateCount: 2` with two gate groups leaves the next pause its answer;
 *   W8  a huge or infinite `gateCount` ends the walk: every pass consumes a
 *       gate group or an answer (a guard row fails the test after 1000 reads
 *       instead of hanging it);
 *   W9  an answer stored through the run resume road while the marked
 *       review's gate was open is that pause's, never the next pause's;
 *   W10 an answer and a later marked step's gate read at one millisecond, or
 *       one millisecond apart, have no proven order: the walk stops before the
 *       marked steps, and no later marked step takes the earlier answer;
 *   W11 a gate list that cannot be read, a gate time that is not a time, or an
 *       answer time that is not a time stops the walk at the marked step,
 *       instead of handing the next pause's answer to it;
 *   W12 a marked review decided through an earlier gate group, followed by an
 *       answer the resume road stored for the next marked pause's group: the
 *       earlier group is consumed by its proven time, the answer stays with
 *       its own pause, and the walk goes on to the next pause;
 *   W13 where the walk stops at a marked step (a gate list it cannot read, or
 *       an answer 1 ms before the next marked step's gate) it reports that
 *       step, and the run page's rail, given the report, places no gate by
 *       position: the next marked step's pending gate never stands in the
 *       first marked step's place.
 *
 * The session, the run/answer readers and the gate-time reader are mocked the
 * way run-output-evidence-scan-window.test.ts mocks them; the walk runs for
 * real, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --maxWorkers=2 --no-coverage \
 *     src/__tests__/submission-map-marked-review-3035.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "run-3035-walk";
const ORG_ID = "org-3035";
const USER_ID = "user-3035";
const AGENT_ID = "@cinatra-ai/web-research-agent";

const authSession = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: USER_ID },
    session: { activeOrganizationId: ORG_ID },
  })),
  requireActorContext: vi.fn(async () => ({ principalId: USER_ID })),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForSession: vi.fn(async () => "owner"),
}));

type AnswerRow = {
  submittedValues: Record<string, unknown> | null;
  schemaSnapshot: Record<string, unknown> | null;
  stepKey: string;
  capturedAt: Date;
};

type GateTime = { reviewTaskId: string; createdAt: Date };

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunMessages: vi.fn(async (): Promise<{ id: string }[]> => []),
  readAllHitlPromptsForRun: vi.fn(async (): Promise<AnswerRow[]> => []),
  readReviewGateTimesForRun: vi.fn(async (): Promise<GateTime[]> => []),
}));
const objectsStore = vi.hoisted(() => ({ listObjectsByFilter: vi.fn(() => []) }));
const artifactService = vi.hoisted(() => ({ readArtifactForDetail: vi.fn() }));

vi.mock("@/lib/auth-session", () => authSession);
vi.mock("@/lib/authz", () => ({ AuthzError: class AuthzError extends Error {} }));
vi.mock("../store", () => store);
vi.mock("@/lib/objects-store", () => objectsStore);
vi.mock("@/lib/artifacts/artifact-service", () => artifactService);

import { buildSubmissionMapByStepIndex } from "../run-actions";
import { buildRunStepRail } from "../run-step-rail";

afterAll(() => {
  for (const path of [
    "@/lib/auth-session",
    "@/lib/authz",
    "../store",
    "@/lib/objects-store",
    "@/lib/artifacts/artifact-service",
  ]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const MARKED_STEP = {
  stepNumber: 5,
  xRenderer: "schema-field",
  artifactReviewTargetsInput: "reviewTargets",
  inputMessageSchema: {
    type: "object",
    properties: { reviewApproval: { type: "string" } },
    required: ["reviewApproval"],
  },
};

/** Four declared pauses; the third marks its review. */
const POLICY_STEPS = [
  {
    stepNumber: 1,
    xRenderer: "idea-selection",
    inputMessageSchema: { type: "object", properties: { selectedIdeaJson: { type: "string" } } },
  },
  {
    stepNumber: 2,
    xRenderer: "schema-field",
    inputMessageSchema: { type: "object", properties: { brandVoice: { type: "string" } } },
  },
  MARKED_STEP,
  {
    stepNumber: 6,
    xRenderer: "schema-field",
    inputMessageSchema: { type: "object", properties: { linkedinPost: { type: "string" } } },
  },
];

const HITL_STEPS = [
  { index: 1, stepNumber: 1 },
  { index: 2, stepNumber: 2 },
  { index: 3, stepNumber: 5 },
  { index: 4, stepNumber: 6 },
];

/** A minute of the run's one morning, so rows and gates share one clock. */
function at(minute: number): Date {
  return new Date(`2026-11-11T10:${String(minute).padStart(2, "0")}:00Z`);
}

function answer(stepKey: string, submittedValues: Record<string, unknown> | null, minute: number): AnswerRow {
  return { submittedValues, schemaSnapshot: null, stepKey, capturedAt: at(minute) };
}

function gateAt(reviewTaskId: string, minute: number): GateTime {
  return { reviewTaskId, createdAt: at(minute) };
}

// The run's stored answers, in capture order.
const IDEA = answer("step-idea", { selectedIdeaJson: '{"id":"idea-1"}' }, 1);
const VOICE = answer("step-voice", { brandVoice: "Plain and direct." }, 2);
const CONTEXT_A = answer("step-context-a", {
  slotId: "slot-a",
  selectedRefs: [],
  resolutionMode: "override",
}, 3);
const CONTEXT_B = answer("step-context-b", {
  slotId: "slot-b",
  selectedRefs: [
    { artifactId: "artifact-1", representationRevisionId: "revision-1", semanticAssertionId: "assertion-1" },
  ],
  resolutionMode: "accumulate",
}, 3);
/** The marked step's own answer as the card stores it: its field plus the envelope. */
const REVIEW_ENVELOPE = answer("step-review", {
  reviewApproval: "Tighten the opening.",
  approved: true,
  approvedAt: "2026-11-11T10:04:30.000Z",
}, 5);
const POST = answer("step-post", { linkedinPost: "A short post." }, 6);

/** The marked pause's review gates, both artifacts of one pause, one instant. */
const REVIEW_GATES = [gateAt("wayflow-task-review", 4), gateAt("wayflow-task-review#2", 4)];

async function walk(
  rows: AnswerRow[],
  gates: GateTime[] = [],
  policySteps: Parameters<typeof buildSubmissionMapByStepIndex>[2] = POLICY_STEPS,
  hitlSteps = HITL_STEPS,
) {
  store.readAllHitlPromptsForRun.mockResolvedValue(rows);
  store.readReviewGateTimesForRun.mockResolvedValue(gates);
  const entries = await buildSubmissionMapByStepIndex(RUN_ID, AGENT_ID, policySteps, hitlSteps);
  return new Map(entries.map(([index, entry]) => [index, entry.stepKey]));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    runBy: USER_ID,
    orgId: ORG_ID,
    status: "pending_approval",
    stepResults: null,
  });
});

describe("the stored answers are tied to the declared pauses (cinatra#3035)", () => {
  it("W1 a marked review decided through its gate takes no answer, so the next pause keeps its own", async () => {
    const map = await walk([IDEA, VOICE, CONTEXT_A, CONTEXT_B, POST], REVIEW_GATES);
    expect(map.has(3)).toBe(false);
    expect(map.get(4)).toBe("step-post");
    expect([...map.keys()]).toEqual([1, 2, 4]);
  });

  it("W2 a marked review that fell back to the ordinary gate keeps its own answer, stored as the card's envelope", async () => {
    const map = await walk([IDEA, VOICE, CONTEXT_A, CONTEXT_B, REVIEW_ENVELOPE, POST]);
    expect(map.get(3)).toBe("step-review");
    expect(map.get(4)).toBe("step-post");
    expect([...map.keys()]).toEqual([1, 2, 3, 4]);
  });

  it("W3 after a gate-decided marked review, a next pause that stored null keeps it", async () => {
    const map = await walk([IDEA, VOICE, answer("step-post", null, 6)], REVIEW_GATES);
    expect(map.has(3)).toBe(false);
    expect(map.get(4)).toBe("step-post");
  });

  it("W4 after a gate-decided marked review, a next pause that stored {} keeps it", async () => {
    const map = await walk([IDEA, VOICE, answer("step-post", {}, 6)], REVIEW_GATES);
    expect(map.has(3)).toBe(false);
    expect(map.get(4)).toBe("step-post");
  });

  it("W5 a marked step whose schema declares no properties keeps its own envelope-only answer", async () => {
    const policy = POLICY_STEPS.map((step) =>
      step === MARKED_STEP ? { ...MARKED_STEP, inputMessageSchema: { type: "object" } } : step,
    );
    const bare = answer("step-review", { approved: true, approvedAt: "2026-11-11T10:04:30.000Z" }, 5);
    const map = await walk([IDEA, VOICE, bare, POST], [], policy);
    expect(map.get(3)).toBe("step-review");
    expect(map.get(4)).toBe("step-post");
  });

  it("W6 a fallen-back marked step's attachment answer {text, attachments} stays its own", async () => {
    const withAttachment = answer("step-review", {
      text: '{"reviewApproval":"Tighten the opening."}',
      attachments: [{ artifactId: "artifact-9", representationRevisionId: "revision-9" }],
    }, 5);
    const map = await walk([IDEA, VOICE, withAttachment, POST]);
    expect(map.get(3)).toBe("step-review");
    expect(map.get(4)).toBe("step-post");
  });

  it("W7 a marked step pausing twice, both times through its gate, leaves the next pause its answer", async () => {
    const policy = POLICY_STEPS.map((step) => (step === MARKED_STEP ? { ...MARKED_STEP, gateCount: 2 } : step));
    const map = await walk(
      [IDEA, VOICE, POST],
      [gateAt("wayflow-task-first", 4), gateAt("wayflow-task-second", 5)],
      policy,
    );
    expect(map.has(3)).toBe(false);
    expect(map.get(4)).toBe("step-post");
  });

  it("W8 a huge or infinite gateCount on a marked step still ends the walk", async () => {
    for (const gateCount of [1_000_000_000, Number.POSITIVE_INFINITY]) {
      let reads = 0;
      const guard = {
        schemaSnapshot: null,
        stepKey: "step-post",
        capturedAt: at(6),
        get submittedValues() {
          reads += 1;
          if (reads > 1000) throw new Error("the walk did not advance");
          return { linkedinPost: "A short post." };
        },
      } as AnswerRow;
      const map = await walk(
        [guard],
        [gateAt("wayflow-task-review", 4)],
        [{ ...MARKED_STEP, gateCount }],
        [{ index: 3, stepNumber: 5 }],
      );
      expect(reads).toBeLessThan(10);
      // The first pass is the gate group, the next takes the one answer, and
      // the walk stops when the answers run out.
      expect([...map.keys()]).toEqual([3]);
    }
  });

  it("W9 an answer stored through the resume road while the marked review's gate was open is that pause's, never the next one's", async () => {
    // The run resume road stores the answer under the pause's own task id, the
    // id its gate group carries after `wayflow-`.
    const resumed = answer("task-review", { reviewApproval: "Looks right." }, 5);
    const map = await walk([IDEA, VOICE, resumed, POST], REVIEW_GATES);
    expect(map.get(4)).toBe("step-post");
    expect([...map.keys()]).toEqual([1, 2, 4]);
  });

  it("W10 an answer and a later marked step's gate a millisecond or less apart have no proven order", async () => {
    const SECOND_MARKED = { ...MARKED_STEP, stepNumber: 7 };
    const policy = [POLICY_STEPS[0], POLICY_STEPS[1], MARKED_STEP, SECOND_MARKED, POLICY_STEPS[3]];
    const hitl = [
      { index: 1, stepNumber: 1 },
      { index: 2, stepNumber: 2 },
      { index: 3, stepNumber: 5 },
      { index: 4, stepNumber: 7 },
      { index: 5, stepNumber: 6 },
    ];
    // The first marked step fell back and stored its answer; the second one's
    // gate followed within the same millisecond, which the readers cannot split.
    const instant = new Date("2026-11-11T10:05:00.123Z");
    const fellBack = { ...REVIEW_ENVELOPE, capturedAt: instant };
    for (const offset of [0, -1, 1]) {
      const map = await walk(
        [IDEA, VOICE, fellBack, POST],
        [{ reviewTaskId: "wayflow-task-second", createdAt: new Date(instant.getTime() + offset) }],
        policy,
        hitl,
      );
      expect(map.get(4)).not.toBe("step-review");
      expect([...map.keys()]).toEqual([1, 2]);
    }
  });

  it("W11 an unreadable gate list, gate time or answer time stops the walk at the marked step", async () => {
    store.readAllHitlPromptsForRun.mockResolvedValue([IDEA, VOICE, POST]);
    store.readReviewGateTimesForRun.mockRejectedValue(new Error("the gate list is unavailable"));
    const unreadable = await buildSubmissionMapByStepIndex(RUN_ID, AGENT_ID, POLICY_STEPS, HITL_STEPS);
    expect(unreadable.map(([index]) => index)).toEqual([1, 2]);

    const badGateTime = await walk(
      [IDEA, VOICE, POST],
      [{ reviewTaskId: "wayflow-task-review", createdAt: new Date("not a time") }],
    );
    expect([...badGateTime.keys()]).toEqual([1, 2]);

    const badAnswerTime = await walk(
      [IDEA, VOICE, { ...POST, capturedAt: new Date("not a time") }],
      REVIEW_GATES,
    );
    expect([...badAnswerTime.keys()]).toEqual([1, 2]);
  });

  /** Two marked pauses, A (step 5) and B (step 7), before the last pause. */
  const SECOND_MARKED = { ...MARKED_STEP, stepNumber: 7 };
  const TWO_MARKED = [POLICY_STEPS[0], POLICY_STEPS[1], MARKED_STEP, SECOND_MARKED, POLICY_STEPS[3]];
  const TWO_MARKED_HITL = [
    { index: 1, stepNumber: 1 },
    { index: 2, stepNumber: 2 },
    { index: 3, stepNumber: 5 },
    { index: 4, stepNumber: 7 },
    { index: 5, stepNumber: 6 },
  ];

  it("W12 an earlier gate group proven by time is consumed before an answer tied to the next marked pause's group", async () => {
    const resumedSecond = answer("task-second", { reviewApproval: "Fine." }, 6);
    const map = await walk(
      [IDEA, VOICE, resumedSecond, answer("step-post", { linkedinPost: "A short post." }, 7)],
      [gateAt("wayflow-task-first", 4), gateAt("wayflow-task-second", 5)],
      TWO_MARKED,
      TWO_MARKED_HITL,
    );
    expect([...map.keys()]).toEqual([1, 2, 5]);
    expect(map.get(5)).toBe("step-post");
  });

  it("W13 where the walk stops at a marked step it says so, and the rail then ties no gate to a marked step by position", async () => {
    const instant = new Date("2026-11-11T10:05:00.123Z");
    const fellBack = { ...REVIEW_ENVELOPE, capturedAt: instant };
    const secondGate = { reviewTaskId: "wayflow-task-second", createdAt: new Date(instant.getTime() + 1) };
    const railGate = {
      gateId: "gate-second",
      reviewTaskId: "wayflow-task-second",
      status: "pending" as const,
      disposition: null,
      createdAt: secondGate.createdAt,
    };
    const inputs: Array<{ name: string; gates: () => void }> = [
      // (a) the walk's gate reader fails while the rail's own gate read succeeds.
      { name: "unreadable", gates: () => store.readReviewGateTimesForRun.mockRejectedValue(new Error("unavailable")) },
      // (b) A's answer was stored 1 ms before B's gate was created.
      { name: "one millisecond", gates: () => store.readReviewGateTimesForRun.mockResolvedValue([secondGate]) },
    ];
    for (const input of inputs) {
      store.readAllHitlPromptsForRun.mockResolvedValue([IDEA, VOICE, fellBack, POST]);
      input.gates();
      const report: { stoppedAtStepNumber?: number } = {};
      const entries = await buildSubmissionMapByStepIndex(RUN_ID, AGENT_ID, TWO_MARKED, TWO_MARKED_HITL, report);
      expect(entries.map(([index]) => index), input.name).toEqual([1, 2]);
      expect(report.stoppedAtStepNumber, input.name).toBe(5);

      const rail = buildRunStepRail({
        templateSteps: TWO_MARKED_HITL.map((h) => ({
          index: h.index,
          stepNumber: h.stepNumber,
          label: `Step ${h.stepNumber}`,
          ...(h.stepNumber === 5 || h.stepNumber === 7 ? { marksReview: true } : {}),
        })),
        submissions: entries.map(([stepIndex, entry]) => ({ stepIndex, answered: entry.submittedValues != null })),
        submissionsStoppedAtStep: report.stoppedAtStepNumber,
        gates: [railGate],
      });
      expect(rail.entries.find((e) => e.key === "gate:wayflow-task-second")?.onStep, input.name).toBeUndefined();
      expect(rail.entries.some((e) => e.key === "step:5"), input.name).toBe(true);
      expect(rail.entries.some((e) => e.key === "step:7"), input.name).toBe(true);
    }
  });
});
