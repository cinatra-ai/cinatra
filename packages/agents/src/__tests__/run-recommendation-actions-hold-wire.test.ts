/**
 * cinatra#2568 (epic #2564 S4) — the CONFIRM PATH's wire contract.
 *
 * The hold's decisions (confirm / adjust / skip) already released the park and
 * dispatched. This slice binds the wire to that same verification:
 *
 *   RESUME IS EMITTED ONLY AFTER THE RELEASE IS VERIFIED. Never on "the action
 *   was called", never on the fail-closed branches. The wire may under-report
 *   the end of a hold — the next subscribe re-derives from the park — but it
 *   must never announce that a run was freed while it is still waiting.
 *
 * And the refusal contract: a caller who may not decide learns ONE thing, the
 * same thing in every case. The authorization decisions themselves are
 * unchanged; what a refused caller can INFER from them is what changed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const resolveRecommendationCandidateSkillIds = vi.fn();
const publishRecommendationHoldResume = vi.fn();
const getRunRecommendations = vi.fn();
const triggerAgentRun = vi.fn();
const confirmRunSkillSelectionAction = vi.fn();
const readRunSelectedSkillRevisions = vi.fn();
const hasRunRecommendationSkip = vi.fn();
const writeRunRejectedRecommendations = vi.fn();
const writeRunRecommendationSkip = vi.fn();
const decodeRecommendationHoldRef = vi.fn();
const encodeRecommendationHoldRef = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: (...a: unknown[]) => readRunSelectedSkillRevisions(...a),
  hasRunRecommendationSkip: (...a: unknown[]) => hasRunRecommendationSkip(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  writeRunRecommendationSkip: (...a: unknown[]) => writeRunRecommendationSkip(...a),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "This run's skill selection cannot be decided from here.",
  RECOMMENDATION_SKIP_NOT_RECORDED:
    "your skip was not recorded — the run is still waiting, please retry",
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE: "recommendation_skip_not_recorded",
  decodeRecommendationHoldRef: (...a: unknown[]) => decodeRecommendationHoldRef(...a),
  encodeRecommendationHoldRef: (...a: unknown[]) => encodeRecommendationHoldRef(...a),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
  publishRecommendationHoldResume: (...a: unknown[]) => publishRecommendationHoldResume(...a),
  recommendationHoldThreadId: (run: { id: string; templateId?: string | null }) =>
    run.templateId && run.templateId.length > 0 ? run.templateId : run.id,
}));
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: (...a: unknown[]) => getRunRecommendations(...a),
}));
vi.mock("../run-actions", () => ({
  triggerAgentRun: (...a: unknown[]) => triggerAgentRun(...a),
}));
vi.mock("../server-actions", () => ({
  confirmRunSkillSelectionAction: (...a: unknown[]) => confirmRunSkillSelectionAction(...a),
}));

import {
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} from "../run-recommendation-actions";
// The refusal string lives with the hold, not with the `"use server"` actions —
// a server-action module may export async functions only.
import { RECOMMENDATION_DECISION_REFUSAL } from "../recommendation-hold";

const USER = "user-1";
const RUN = {
  id: "run-1",
  templateId: "tpl-1",
  orgId: "org-1",
  runBy: USER,
  inputParams: { prompt: "write a blog" },
  status: "pending_input",
};

const CONFIRM_INPUT = {
  runId: "run-1",
  agentPackageName: "@vendor/agent",
  confirmedSkillIds: ["s1", "s2"],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({ user: { id: USER } });
  requireActorContext.mockResolvedValue({ principalId: USER, organizationId: "org-1" });
  readAgentRunById.mockResolvedValue({ ...RUN });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@vendor/agent" });
  // Default: the release succeeded and the park is verifiably no longer live.
  releaseRecommendationParkForRun.mockResolvedValue(true);
  readRecommendationParkForRun.mockResolvedValue({
    id: "park-1",
    checkpoint: "recommendation",
    status: "released",
  });
  resolveRecommendationCandidateSkillIds.mockResolvedValue(["s1"]);
  getRunRecommendations.mockResolvedValue([]);
  confirmRunSkillSelectionAction.mockResolvedValue({ ok: true, written: 2 });
  triggerAgentRun.mockResolvedValue({ ok: true });
  publishRecommendationHoldResume.mockResolvedValue(undefined);
  encodeRecommendationHoldRef.mockReturnValue("ref-park-1");
  decodeRecommendationHoldRef.mockImplementation((ref: string) =>
    ref === "ref-park-1" ? { runId: "run-1", holdId: "park-1" } : null,
  );
  // The run-level skip marker writer VERIFIES its write and returns whether the
  // marker read back (cinatra#2794); the happy path is "it landed".
  writeRunRecommendationSkip.mockReturnValue(true);
});

describe("RESUME rides the VERIFIED release, never the call", () => {
  it("CONFIRM: writes the selection, then RESUMEs, then dispatches", async () => {
    const res = await confirmRunRecommendationAction(CONFIRM_INPUT);
    expect(res).toEqual({ ok: true, dispatched: true });
    expect(confirmRunSkillSelectionAction).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", confirmedSkillIds: ["s1", "s2"] }),
    );
    expect(publishRecommendationHoldResume).toHaveBeenCalledWith({
      runId: "run-1",
      threadId: "tpl-1",
      holdId: "park-1",
    });
    expect(triggerAgentRun).toHaveBeenCalledWith({ runId: "run-1", templateSlug: "tpl-1" });
  });

  it("SKIP: RESUMEs on the same verified release", async () => {
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res).toEqual({ ok: true, dispatched: true });
    expect(publishRecommendationHoldResume).toHaveBeenCalledTimes(1);
  });

  it("a STILL-LIVE park emits NO resume — the run is genuinely still held", async () => {
    releaseRecommendationParkForRun.mockResolvedValue(false);
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res.ok).toBe(false);
    expect(publishRecommendationHoldResume).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("an UNREADABLE park emits NO resume (fail-closed: unconfirmed ≠ released)", async () => {
    readRecommendationParkForRun.mockRejectedValue(new Error("park read down"));
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    expect(publishRecommendationHoldResume).not.toHaveBeenCalled();
  });

  it("an UNAUTHORIZED confirm never touches the wire", async () => {
    confirmRunSkillSelectionAction.mockResolvedValue({ ok: false, written: 0 });
    const res = await confirmRunRecommendationAction(CONFIRM_INPUT);
    expect(res.ok).toBe(false);
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(publishRecommendationHoldResume).not.toHaveBeenCalled();
  });

  it("RESUMEs even when a concurrent decision already dispatched the run", async () => {
    // The hold IS over; the card must clear on every surface regardless of
    // which tab won the dispatch race.
    readAgentRunById.mockResolvedValue({ ...RUN, status: "running" });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res).toEqual({ ok: true, dispatched: false });
    expect(publishRecommendationHoldResume).toHaveBeenCalledTimes(1);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("RESUMEs when the dispatch fails a preflight — the hold ended either way", async () => {
    triggerAgentRun.mockResolvedValue({
      ok: false,
      error: "connect an LLM provider",
      settingsHref: "/settings/llm",
    });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // The actionable preflight message survives — it is about the CALLER'S
      // own next step, so it is not collapsed into the generic refusal.
      expect(res.error).toBe("connect an LLM provider");
      expect(res.settingsHref).toBe("/settings/llm");
    }
    expect(publishRecommendationHoldResume).toHaveBeenCalledTimes(1);
  });

  it("a wire failure never turns a real dispatch into a failure", async () => {
    publishRecommendationHoldResume.mockRejectedValue(new Error("redis down"));
    // The publisher swallows internally; assert the action is unaffected even
    // if a future edit made it reject.
    const res = await skipRunRecommendationAction({ runId: "run-1" }).catch(() => ({
      ok: false as const,
      error: "threw",
    }));
    expect(res).toEqual({ ok: true, dispatched: true });
  });
});

describe("the refusal is ONE non-enumerating answer", () => {
  it("an unauthenticated caller gets the generic refusal", async () => {
    requireAuthSession.mockResolvedValue(null);
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
  });

  it("a MISSING run and a FORBIDDEN run are indistinguishable", async () => {
    readAgentRunById.mockResolvedValue(null);
    const missing = await skipRunRecommendationAction({ runId: "run-1" });

    vi.clearAllMocks();
    requireAuthSession.mockResolvedValue({ user: { id: USER } });
    readAgentRunById.mockResolvedValue({ ...RUN, runBy: "someone-else" });
    const forbidden = await skipRunRecommendationAction({ runId: "run-1" });

    expect(missing).toEqual(forbidden);
    expect(missing).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
  });

  it("an un-authorized CONFIRM gives the same answer as a missing run", async () => {
    confirmRunSkillSelectionAction.mockResolvedValue({ ok: false, written: 0 });
    const res = await confirmRunRecommendationAction(CONFIRM_INPUT);
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
  });

  it("carries no run id, no park id and no skill name", async () => {
    readAgentRunById.mockResolvedValue(null);
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain("run-1");
      expect(res.error).not.toContain("park");
      expect(res.error).not.toMatch(/not found|forbidden|unauthorized/i);
    }
  });
});

describe("the hold-instance CAS — a decision binds to the hold it was taken against", () => {
  beforeEach(() => {
    // The run is HELD by park-1 when the decision arrives (the CAS read), and
    // verifiably released afterwards.
    readRecommendationParkForRun
      .mockResolvedValueOnce({ id: "park-1", checkpoint: "recommendation", status: "parked" })
      .mockResolvedValue({ id: "park-1", checkpoint: "recommendation", status: "released" });
  });

  it("accepts a decision naming the CURRENT hold and releases THAT hold", async () => {
    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });
    expect(res).toEqual({ ok: true, dispatched: true });
    // Instance-bound: the sweep names the park the decision resolved to, never
    // "whichever park is live when the helper happens to read".
    expect(releaseRecommendationParkForRun).toHaveBeenCalledWith("run-1", "park-1");
  });

  it("REFUSES a decision naming a hold the run has moved past (re-parked run)", async () => {
    // The card was showing park-1; the run has since been decided, dispatched
    // and parked AGAIN as park-2. Applying the old decision would dispatch the
    // run with a selection made for a different candidate set.
    readRecommendationParkForRun.mockReset();
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-2",
      checkpoint: "recommendation",
      status: "parked",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });

    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
    expect(publishRecommendationHoldResume).not.toHaveBeenCalled();
    // AND it left no trace on the run it was not aimed at.
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
  });

  it("ACCEPTS a retry of the SAME hold that is already released — idempotence, not staleness", async () => {
    // A decision whose response was lost and is retried names a hold that is
    // now released. That is still this run's hold, so it is not a stale
    // decision; refusing it would turn an ambiguous transport failure into a
    // dead end. The downstream path is idempotent on its own.
    readRecommendationParkForRun.mockReset();
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });
    readAgentRunById.mockResolvedValue({ ...RUN, status: "running" });

    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });

    expect(res).toEqual({ ok: true, dispatched: false });
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("REFUSES a decision naming a hold that is not this run's park at all", async () => {
    readRecommendationParkForRun.mockReset();
    readRecommendationParkForRun.mockResolvedValue(null);
    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
  });

  it("REFUSES a named decision when the park cannot be READ (fail-closed)", async () => {
    readRecommendationParkForRun.mockReset();
    readRecommendationParkForRun.mockRejectedValue(new Error("park store down"));
    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
  });

  it("REFUSES an undecodable ref, indistinguishably from an unauthorized caller", async () => {
    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "forged" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
  });

  it("REFUSES a ref minted for ANOTHER run", async () => {
    decodeRecommendationHoldRef.mockReturnValue({ runId: "run-other", holdId: "park-1" });
    const res = await skipRunRecommendationAction({ runId: "run-1", holdRef: "ref-park-1" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
  });

  it("CONFIRM takes the same CAS before it writes nothing further", async () => {
    readRecommendationParkForRun.mockReset();
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-2",
      checkpoint: "recommendation",
      status: "parked",
    });
    const res = await confirmRunRecommendationAction({ ...CONFIRM_INPUT, holdRef: "ref-park-1" });
    expect(res).toEqual({ ok: false, error: RECOMMENDATION_DECISION_REFUSAL });
    // The CAS runs BEFORE the write: a refused decision must not have mutated
    // the run's authoritative selection on its way to being refused.
    expect(confirmRunSkillSelectionAction).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
  });

  it("a caller that names NO hold keeps the pre-#2568 run-scoped behaviour", async () => {
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res).toEqual({ ok: true, dispatched: true });
  });
});
