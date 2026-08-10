/**
 * cinatra#2148 findings 2 + 3 — the two run-start paths that BYPASSED the
 * run-start recommendation hold now consult it.
 *
 *   finding 2  startDevChildPreviewRun (Dev Stepper child preview) marked its
 *              run humanPresent and transitioned/enqueued DIRECTLY.
 *   finding 3  setRunTriggerForActor with triggerType:"immediate" transitioned
 *              pending_input → queued DIRECTLY.
 *
 * Both are proved here on the SAME axes:
 *   - HELD    ⇒ no status transition, no enqueue (the run stays pending_input
 *               and the chip-row renders);
 *   - RELEASED⇒ the canonical `triggerAgentRun` (what the chip-row's
 *               confirm/adjust/skip calls) dispatches the run — park-then-release
 *               end to end;
 *   - NOT HELD⇒ byte-identical to the pre-fix behaviour (transition + enqueue);
 *   - THROWS  ⇒ fails OPEN to the pre-fix behaviour (a hold must never block a run);
 *   - HEADLESS⇒ the hold's own `humanPresent` gate is the only discriminator, so
 *               a headless run is untouched (asserted via the real hold in
 *               recommendation-hold.test.ts and the real store integration test).
 *
 * Only the hold decision + the DB seams are mocked; the two call sites under
 * test run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeHoldRunForRecommendation = vi.fn();
const readRecommendationParkForRun = vi.fn();

const requireAuthSession = vi.fn();
const verifySessionAuthority = vi.fn();
const resolveTemplateVisibilityActor = vi.fn();

const readAgentTemplateBySlug = vi.fn();
const readAgentTemplateById = vi.fn();
const readAgentRunById = vi.fn();
const createAgentRunPendingInput = vi.fn();
const transitionRunStatus = vi.fn();
const clearAgentRunFailureMetadata = vi.fn();
const slugifyAgentTemplateName = vi.fn((n: string) => n);
const readAllHitlPromptsForRun = vi.fn(async (...a: unknown[]) => (void a, []));

const enqueueAgentRun = vi.fn();
const enqueueDepsForTemplate = vi.fn((template?: unknown) => (void template, {}));

const readRunTriggerByRunId = vi.fn();
const createOrUpdateRunTrigger = vi.fn();
const deleteRunTriggerByRunId = vi.fn();
const scheduleTrigger = vi.fn();
const cancelTriggerSchedule = vi.fn();
const markTriggerReleased = vi.fn();
const syncRunTriggerPmTask = vi.fn(async (input?: unknown) => void input);
const deleteRunTriggerPmTask = vi.fn(async (input?: unknown) => void input);

vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: (...a: unknown[]) => maybeHoldRunForRecommendation(...a),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("../auth-policy", () => ({
  resolveTemplateVisibilityActor: (...a: unknown[]) => resolveTemplateVisibilityActor(...a),
}));
vi.mock("../store", () => ({
  // Declared INSIDE the factory: `vi.mock` is hoisted above every top-level
  // binding, so a class declared at module scope is still in its TDZ here.
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: (...a: unknown[]) => readAgentTemplateBySlug(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: (...a: unknown[]) => clearAgentRunFailureMetadata(...a),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  slugifyAgentTemplateName: (name: string) => slugifyAgentTemplateName(name),
  readAllHitlPromptsForRun: (...a: unknown[]) => readAllHitlPromptsForRun(...a),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: (template: unknown) => enqueueDepsForTemplate(template),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: (...a: unknown[]) => readRunTriggerByRunId(...a),
  createOrUpdateRunTrigger: (...a: unknown[]) => createOrUpdateRunTrigger(...a),
  deleteRunTriggerByRunId: (...a: unknown[]) => deleteRunTriggerByRunId(...a),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: (...a: unknown[]) => scheduleTrigger(...a),
  cancelTriggerSchedule: (...a: unknown[]) => cancelTriggerSchedule(...a),
}));
vi.mock("../trigger-gate", () => ({
  markTriggerReleased: (...a: unknown[]) => markTriggerReleased(...a),
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: (input: unknown) => syncRunTriggerPmTask(input),
  deleteRunTriggerPmTask: (input: unknown) => deleteRunTriggerPmTask(input),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));

import { startDevChildPreviewRun, triggerAgentRun } from "../run-actions";
import { setRunTriggerForActor } from "../trigger-service";

const USER = "user-1";
const ORG = "org-1";
const TEMPLATE = {
  id: "tpl-1",
  name: "Blog Agent",
  packageName: "@vendor/blog-agent",
  lifecycleConfig: null as string | null,
};
/** The status the fake run row is in — the CAS-shaped transition stub reads it. */
let runStatus = "pending_input";
/** The RunTransitionError the `../store` mock exports — declared via
 *  `vi.hoisted` so BOTH the hoisted mock factory and the CAS stub below share
 *  ONE class. The service branches on `err instanceof RunTransitionError`, so a
 *  second look-alike class would be rethrown instead of advancing the ladder. */
const { StubRunTransitionError } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
}));

const CREATED_RUN = {
  id: "run-1",
  templateId: TEMPLATE.id,
  orgId: ORG,
  runBy: USER,
  sourceType: "agent_builder",
  humanPresent: true,
  inputParams: {},
  status: "pending_input",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({
    user: { id: USER },
    session: { activeOrganizationId: ORG },
  });
  verifySessionAuthority.mockResolvedValue({ kind: "member", userId: USER, orgId: ORG });
  resolveTemplateVisibilityActor.mockResolvedValue({});
  readAgentTemplateBySlug.mockResolvedValue(TEMPLATE);
  readAgentTemplateById.mockResolvedValue(TEMPLATE);
  readAgentRunById.mockResolvedValue({ ...CREATED_RUN });
  createAgentRunPendingInput.mockResolvedValue({ ...CREATED_RUN });
  // cinatra#2523: CAS-shaped, not always-succeed. The immediate branch now
  // walks a ladder of legal `from` states (pending_trigger → pending_input →
  // armed), so only the rung matching the row may succeed — otherwise the
  // "pending_input → queued" assertions below would pass on the wrong edge.
  // The status advances on success, exactly like the real row.
  runStatus = CREATED_RUN.status;
  transitionRunStatus.mockImplementation(async (_runId: string, from: string, to: string) => {
    if (from !== runStatus) {
      throw new StubRunTransitionError("stale_from_status", `${from} -> ${to}`);
    }
    runStatus = to;
  });
  enqueueAgentRun.mockResolvedValue(undefined);
  enqueueDepsForTemplate.mockReturnValue({});
  readRunTriggerByRunId.mockResolvedValue(null);
  createOrUpdateRunTrigger.mockResolvedValue(undefined);
  scheduleTrigger.mockResolvedValue({ jobSchedulerId: null });
  markTriggerReleased.mockResolvedValue(undefined);
  readRecommendationParkForRun.mockResolvedValue(null);
  maybeHoldRunForRecommendation.mockResolvedValue({ held: false, reason: "no candidates" });
  delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
});

// ---------------------------------------------------------------------------
// finding 2 — Dev-Stepper child preview.
// ---------------------------------------------------------------------------
describe("startDevChildPreviewRun consults the run-start hold (cinatra#2148 finding 2)", () => {
  it("HELD ⇒ no transition, no enqueue — but the panel metadata is still returned", async () => {
    maybeHoldRunForRecommendation.mockResolvedValue({
      held: true,
      parkId: "park-1",
      reason: "recommendation fired",
    });

    const out = await startDevChildPreviewRun("@vendor/blog-agent");

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.runId).toBe("run-1");
      expect(out.agentSlug).toBe("vendor/blog-agent");
      expect(out.templateName).toBe("Blog Agent");
      expect(out.agUiEnabled).toBe(true);
      // The caller needs this to render the chip-row and to treat the run as
      // pending_input instead of showing a permanent "Queueing agent…".
      expect(out.heldForRecommendation).toBe(true);
    }
    expect(maybeHoldRunForRecommendation).toHaveBeenCalledTimes(1);
    // The hold is consulted with the RUN it just created + the template's
    // lifecycle manifest — the same envelope every other run-start uses.
    expect(maybeHoldRunForRecommendation).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1", humanPresent: true, runBy: USER }),
      template: { packageName: "@vendor/blog-agent", lifecycleConfig: null },
    });
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("RELEASED ⇒ the canonical triggerAgentRun dispatches the parked run (park-then-release)", async () => {
    maybeHoldRunForRecommendation.mockResolvedValueOnce({
      held: true,
      parkId: "park-1",
      reason: "recommendation fired",
    });
    await startDevChildPreviewRun("@vendor/blog-agent");
    expect(transitionRunStatus).not.toHaveBeenCalled();

    // The chip-row decision releases the park; the shared release-and-dispatch
    // helper calls `triggerAgentRun`, which sees a RELEASED (not parked) park and
    // a decided run, so the hold returns held:false and the run dispatches.
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });
    maybeHoldRunForRecommendation.mockResolvedValue({
      held: false,
      reason: "recommendation released",
    });

    const dispatched = await triggerAgentRun({ runId: "run-1", templateSlug: TEMPLATE.id });
    expect(dispatched).toEqual({ ok: true });
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
    );
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("NOT HELD ⇒ byte-identical to the pre-fix path (transition + enqueue)", async () => {
    const out = await startDevChildPreviewRun("@vendor/blog-agent");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.heldForRecommendation).toBe(false);
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
    );
    expect(enqueueAgentRun).toHaveBeenCalledWith({ runId: "run-1" }, { jobId: "run-1" });
  });

  it("a THROWING hold fails OPEN to the pre-fix dispatch", async () => {
    maybeHoldRunForRecommendation.mockRejectedValue(new Error("park store down"));
    const out = await startDevChildPreviewRun("@vendor/blog-agent");
    expect(out.ok).toBe(true);
    expect(transitionRunStatus).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// finding 3 — immediate trigger.
// ---------------------------------------------------------------------------
describe("setRunTriggerForActor immediate consults the run-start hold (cinatra#2148 finding 3)", () => {
  const actor = { userId: USER, role: null, source: "ui" as const };

  it("HELD ⇒ the trigger is configured + released but the run does NOT transition", async () => {
    maybeHoldRunForRecommendation.mockResolvedValue({
      held: true,
      parkId: "park-1",
      reason: "recommendation fired",
    });

    const res = await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "immediate",
    });

    expect(res).toEqual({ ok: true, runId: "run-1", jobSchedulerId: null });
    // The trigger row + gate are still durable (the gate opened by scheduleTrigger).
    expect(createOrUpdateRunTrigger).toHaveBeenCalled();
    expect(scheduleTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", triggerType: "immediate" }),
    );
    // ...but the run stays pending_input awaiting the chip-row decision.
    expect(transitionRunStatus).not.toHaveBeenCalled();
    // The PM mirror still runs — the hold gates DISPATCH, not trigger config.
    expect(syncRunTriggerPmTask).toHaveBeenCalledTimes(1);
  });

  it("RELEASED ⇒ triggerAgentRun dispatches the parked run (park-then-release)", async () => {
    maybeHoldRunForRecommendation.mockResolvedValueOnce({
      held: true,
      parkId: "park-1",
      reason: "recommendation fired",
    });
    await setRunTriggerForActor(actor, { runId: "run-1", triggerType: "immediate" });
    expect(transitionRunStatus).not.toHaveBeenCalled();

    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });
    maybeHoldRunForRecommendation.mockResolvedValue({
      held: false,
      reason: "recommendation released",
    });

    const dispatched = await triggerAgentRun({ runId: "run-1", templateSlug: TEMPLATE.id });
    expect(dispatched).toEqual({ ok: true });
    // `triggerAgentRun` is strictly OWNER-bound (`run.runBy !== userId` ⇒
    // reject), so `run_by` already IS the acting principal and the call keeps
    // the 5-arg shape — no `actingUserId` to thread.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
    );
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("a RETRIED immediate trigger on an ALREADY-parked run still does NOT dispatch", async () => {
    // The hold answers `held:true` for a run that is already parked, so the
    // retry cannot sail past the live park the human is still deciding on.
    maybeHoldRunForRecommendation.mockResolvedValue({
      held: true,
      parkId: "park-1",
      reason: "recommendation already parked",
    });
    await setRunTriggerForActor(actor, { runId: "run-1", triggerType: "immediate" });
    const retry = await setRunTriggerForActor(actor, { runId: "run-1", triggerType: "immediate" });
    expect(retry.ok).toBe(true);
    expect(maybeHoldRunForRecommendation).toHaveBeenCalledTimes(2);
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  // cinatra#2523 (codex round-1 finding): the canonical run-start dispatcher —
  // which the recommendation chip-row's decision calls — must accept BOTH
  // pre-dispatch waiting states, or a run parked from the setup-success state
  // could never be released.
  it("triggerAgentRun dispatches a RELEASED park from the setup-success state (pending_trigger → queued)", async () => {
    readAgentRunById.mockResolvedValue({ ...CREATED_RUN, status: "pending_trigger" });
    runStatus = "pending_trigger";
    // The evidence that put the run here: a run-start recommendation park the
    // chip-row decision has already released.
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });

    const res = await triggerAgentRun({ runId: "run-1", templateSlug: TEMPLATE.id });

    expect(res.ok).toBe(true);
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_trigger",
      "queued",
      undefined,
      expect.anything(),
    );
    expect(enqueueAgentRun).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());
  });

  // cinatra#2523 (codex round-2 finding). `triggerAgentRun` is a PUBLIC server
  // action, so "the owner asked" must not be enough to admit `pending_trigger`:
  // that would dispatch a run straight past the trigger step the state exists to
  // wait for. Without a park, the run is refused and stays where it is.
  it("triggerAgentRun REFUSES a pending_trigger run that never parked — the trigger step is not bypassable", async () => {
    readAgentRunById.mockResolvedValue({ ...CREATED_RUN, status: "pending_trigger" });
    runStatus = "pending_trigger";
    readRecommendationParkForRun.mockResolvedValue(null);

    const res = await triggerAgentRun({ runId: "run-1", templateSlug: TEMPLATE.id });

    expect(res.ok).toBe(false);
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("triggerAgentRun still refuses a run in no dispatchable state at all", async () => {
    readAgentRunById.mockResolvedValue({ ...CREATED_RUN, status: "completed" });
    runStatus = "completed";

    const res = await triggerAgentRun({ runId: "run-1", templateSlug: TEMPLATE.id });

    expect(res.ok).toBe(false);
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("NOT HELD ⇒ the run really dispatches (pending_input → queued, then enqueued)", async () => {
    const res = await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "immediate",
    });
    expect(res.ok).toBe(true);
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
      // cinatra#2485 C: the DISPATCHING actor rides the guard — `isOwnerOrAdmin`
      // admits a non-owner admin, so `run_by` alone is not the scope subject.
      { actingUserId: actor.userId },
    );
    // cinatra#2523: the transition is followed by a real enqueue. Before it, this
    // path wrote a status and put nothing on any queue — the run only ever ran
    // when some other job happened to be parked on the trigger gate.
    expect(enqueueAgentRun).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());
  });

  it("a THROWING hold fails OPEN to the pre-fix transition", async () => {
    maybeHoldRunForRecommendation.mockRejectedValue(new Error("park store down"));
    const res = await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "immediate",
    });
    expect(res.ok).toBe(true);
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
      // cinatra#2485 C: the DISPATCHING actor rides the guard — `isOwnerOrAdmin`
      // admits a non-owner admin, so `run_by` alone is not the scope subject.
      { actingUserId: actor.userId },
    );
  });

  it("SCHEDULED / RECURRING never consult the hold (they arm, they do not dispatch)", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
    await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "scheduled",
      scheduledAt: future,
      timezone: "UTC",
    });
    await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "recurring",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });
    expect(maybeHoldRunForRecommendation).not.toHaveBeenCalled();
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "armed",
      undefined,
      expect.anything(),
    );
  });

  it("a HEADLESS run's immediate trigger is untouched — the hold itself returns held:false", async () => {
    // The presence gate lives INSIDE the hold (`run.humanPresent !== true`), so
    // a headless run reaches the same call site and dispatches unheld.
    readAgentRunById.mockResolvedValue({ ...CREATED_RUN, humanPresent: null });
    maybeHoldRunForRecommendation.mockResolvedValue({ held: false, reason: "headless" });
    const res = await setRunTriggerForActor(actor, {
      runId: "run-1",
      triggerType: "immediate",
    });
    expect(res.ok).toBe(true);
    expect(maybeHoldRunForRecommendation).toHaveBeenCalledWith({
      run: expect.objectContaining({ humanPresent: null }),
      template: { packageName: "@vendor/blog-agent", lifecycleConfig: null },
    });
    expect(transitionRunStatus).toHaveBeenCalledWith(
      "run-1",
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
      // cinatra#2485 C: the DISPATCHING actor rides the guard — `isOwnerOrAdmin`
      // admits a non-owner admin, so `run_by` alone is not the scope subject.
      { actingUserId: actor.userId },
    );
  });
});
