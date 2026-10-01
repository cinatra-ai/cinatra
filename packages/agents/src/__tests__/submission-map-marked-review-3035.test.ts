/**
 * NO LATER DECLARED PAUSE READS SETTLED BEFORE THE RUN REACHED IT (cinatra#3035).
 *
 * `buildSubmissionMapByStepIndex` ties the run's stored human-gate answers to
 * the declared pauses by POSITION, in capture order. Two readings shifted that
 * walk on a real run:
 *
 *   * a context answer stored as its own top-level `slotId`, `resolutionMode`
 *     and `selectedRefs` was counted as a step answer, so two context answers
 *     completed two declared pauses the run had not reached;
 *   * a review step marked by the template is decided through its gate, which
 *     writes no human-gate answer, so the walk handed the NEXT pause's answer to
 *     the marked review and left that next pause unanswered.
 *
 * What this locks (B1..B4): the context shape takes no slot; a marked review
 * takes the answer at the cursor only when that answer is its own declared
 * field (or carries no values); the envelope shapes already dropped stay
 * dropped.
 *
 * The session and the run/answer readers are mocked the way
 * run-output-evidence-scan-window.test.ts mocks them; the walk runs for real,
 * so no database is needed.
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
};

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunMessages: vi.fn(async (): Promise<{ id: string }[]> => []),
  readAllHitlPromptsForRun: vi.fn(async (): Promise<AnswerRow[]> => []),
}));
const objectsStore = vi.hoisted(() => ({ listObjectsByFilter: vi.fn(() => []) }));
const artifactService = vi.hoisted(() => ({ readArtifactForDetail: vi.fn() }));

vi.mock("@/lib/auth-session", () => authSession);
vi.mock("@/lib/authz", () => ({ AuthzError: class AuthzError extends Error {} }));
vi.mock("../store", () => store);
vi.mock("@/lib/objects-store", () => objectsStore);
vi.mock("@/lib/artifacts/artifact-service", () => artifactService);

import { buildSubmissionMapByStepIndex } from "../run-actions";

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
  {
    stepNumber: 5,
    xRenderer: "schema-field",
    artifactReviewTargetsInput: "reviewTargets",
    inputMessageSchema: {
      type: "object",
      properties: { reviewApproval: { type: "string" } },
      required: ["reviewApproval"],
    },
  },
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

function answer(stepKey: string, submittedValues: Record<string, unknown> | null): AnswerRow {
  return { submittedValues, schemaSnapshot: null, stepKey };
}

// The run's six stored answers, in capture order.
const IDEA = answer("step-idea", { selectedIdeaJson: '{"id":"idea-1"}' });
const VOICE = answer("step-voice", { brandVoice: "Plain and direct." });
const CONTEXT_A = answer("step-context-a", {
  slotId: "slot-a",
  selectedRefs: [],
  resolutionMode: "auto",
});
const CONTEXT_B = answer("step-context-b", {
  slotId: "slot-b",
  selectedRefs: [{ id: "ref-1" }],
  resolutionMode: "manual",
});
const REVIEW = answer("step-review", { reviewApproval: "Tighten the opening." });
const POST = answer("step-post", { linkedinPost: "A short post." });

async function walk(rows: AnswerRow[]) {
  store.readAllHitlPromptsForRun.mockResolvedValue(rows);
  const entries = await buildSubmissionMapByStepIndex(RUN_ID, AGENT_ID, POLICY_STEPS, HITL_STEPS);
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
  it("a context answer carried as its own slotId, resolutionMode and selectedRefs takes no step slot (cinatra#3035)", async () => {
    // Cut where the run parked at its review: the first four answers.
    const map = await walk([IDEA, VOICE, CONTEXT_A, CONTEXT_B]);
    expect([...map.keys()]).toEqual([1, 2]);
    expect(map.get(1)).toBe("step-idea");
    expect(map.get(2)).toBe("step-voice");
  });

  it("a marked review decided through its gate takes no answer, so the next pause keeps its own", async () => {
    const map = await walk([IDEA, VOICE, CONTEXT_A, CONTEXT_B, POST]);
    expect(map.has(3)).toBe(false);
    expect(map.get(4)).toBe("step-post");
    expect([...map.keys()]).toEqual([1, 2, 4]);
  });

  it("a marked review that fell back to the ordinary human gate keeps its own answer", async () => {
    const map = await walk([IDEA, VOICE, CONTEXT_A, CONTEXT_B, REVIEW, POST]);
    expect(map.get(3)).toBe("step-review");
    expect(map.get(4)).toBe("step-post");
    expect([...map.keys()]).toEqual([1, 2, 3, 4]);
  });

  it("the envelope shapes already dropped stay dropped", async () => {
    const map = await walk([
      answer("step-envelope", {
        userResponse: JSON.stringify({ slotId: "slot-c", resolutionMode: "auto", selectedRefs: [] }),
      }),
      answer("step-slot-meta", { slotMeta: { slotId: "slot-d" }, selectedRefs: [] }),
    ]);
    expect(map.size).toBe(0);
  });

  it("a context answer carried as its own values stays dropped whatever userResponse it also carries", async () => {
    const withText = answer("step-context-text", {
      slotId: "slot-e",
      resolutionMode: "auto",
      selectedRefs: [],
      userResponse: "approved",
    });
    const withEmptyJson = answer("step-context-json", {
      slotId: "slot-f",
      resolutionMode: "manual",
      selectedRefs: [],
      userResponse: "{}",
    });
    const map = await walk([IDEA, withText, withEmptyJson, VOICE]);
    expect(map.get(1)).toBe("step-idea");
    expect(map.get(2)).toBe("step-voice");
    expect([...map.keys()]).toEqual([1, 2]);
  });
});
