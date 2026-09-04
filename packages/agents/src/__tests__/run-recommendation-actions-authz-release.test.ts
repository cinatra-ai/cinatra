/**
 * cinatra#2148 (codex round) — two defects the actor-threading fix exposed in
 * the chip-row DECISION actions:
 *
 *   1. `getRunRecommendationHoldStateAction` loaded the run with a BARE
 *      `readAgentRunById(runId)`, which SKIPS `enforceRunAccess`. Any
 *      authenticated caller holding a run id could read the hold state — and,
 *      once the candidate set became actor-scoped, the run owner's scoped skill
 *      names with it. The run must now load THROUGH the access door, and the
 *      presented set must be intersected with the VIEWER's own entitlement.
 *   2. `releaseAndDispatch` swallowed a failed park release. `triggerAgentRun`
 *      then short-circuited on the still-LIVE park and returned ok, so the
 *      action reported `dispatched: true` for a run that never moved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const resolveRecommendationCandidateSkillIds = vi.fn();
const getRunRecommendations = vi.fn();
const triggerAgentRun = vi.fn();
const confirmRunSkillSelectionAction = vi.fn();
const readRunSelectedSkillRevisions = vi.fn();
const readRunRejectedRecommendations = vi.fn();
const hasRunRecommendationSkip = vi.fn();
const readRunCoOwners = vi.fn();
const enforceRunAccess = vi.fn();
const writeRunRejectedRecommendations = vi.fn();
const writeRunRecommendationSkip = vi.fn();
const publishRecommendationHoldResume = vi.fn();
const readRunRecommendationOfferedSet = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", async (importOriginal) => ({
  // Keep the module's PURE exports (decidedSkillsFromEvidence and the row
  // types' runtime constants) real; stub only the store reads/writes.
  ...(await importOriginal<typeof import("@/lib/run-selected-skill-revisions")>()),
  readRunSelectedSkillRevisions: (...a: unknown[]) => readRunSelectedSkillRevisions(...a),
  readRunRejectedRecommendations: (...a: unknown[]) => readRunRejectedRecommendations(...a),
  hasRunRecommendationSkip: (...a: unknown[]) => hasRunRecommendationSkip(...a),
  // cinatra#2790 — the hold's OWN offer, which the settled reading carries so
  // the row can state an outcome for a skill that left no decision row.
  readRunRecommendationOfferedSet: (...a: unknown[]) => readRunRecommendationOfferedSet(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  writeRunRecommendationSkip: (...a: unknown[]) => writeRunRecommendationSkip(...a),
  // The pre-start selection clear (cinatra#3047) is a STORE write, so it is
  // stubbed like the rest of them even though the surrounding spread keeps
  // the module's pure exports real.
  clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
  // The pre-start selection REPLACE (cinatra#3047) — the hold-bound confirm's
  // one guarded write. `true` = it applied, which is what a pre-start run gives.
  replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
// The redraw's READ-ONLY reading (cinatra#2841) asks the SAME execute-tier gate
// the confirm path enforces, so the gate is the seam this suite flips. Only that
// one export is replaced; the rest of the policy module is the real one.
vi.mock("../auth-policy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enforceRunAccess: (...a: unknown[]) => enforceRunAccess(...a),
}));
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "This run's skill selection cannot be decided from here.",
  RECOMMENDATION_SKIP_NOT_RECORDED:
    "your skip was not recorded — the run is still waiting, please retry",
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE: "recommendation_skip_not_recorded",
  decodeRecommendationHoldRef: () => null,
  encodeRecommendationHoldRef: () => "ref-park-1",
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
  // cinatra#2568 — the wire seam the release now rides. Inert here; the
  // RESUME-vs-verified-release contract is pinned in
  // run-recommendation-actions-hold-wire.test.ts.
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
  getRunRecommendationHoldStateAction,
  skipRunRecommendationAction,
} from "../run-recommendation-actions";

const USER = "user-1";
const RUN = {
  id: "run-1",
  templateId: "tpl-1",
  orgId: "org-1",
  runBy: USER,
  sourceType: "agent_builder",
  inputParams: { prompt: "write a blog" },
  status: "pending_input",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({ user: { id: USER } });
  requireActorContext.mockResolvedValue({
    principalId: USER,
    organizationId: "org-1",
    teamIds: ["team-a"],
    projectIds: ["proj-a"],
    projectGrants: [{ projectId: "proj-a", role: "read" }],
    platformRole: "platform_admin",
    orgRole: "org_admin",
  });
  readAgentRunById.mockResolvedValue({ ...RUN });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@vendor/agent" });
  readRecommendationParkForRun.mockResolvedValue({
    id: "park-1",
    checkpoint: "recommendation",
    status: "parked",
  });
  resolveRecommendationCandidateSkillIds.mockResolvedValue(["s1", "org-scoped-skill"]);
  getRunRecommendations.mockResolvedValue([
    {
      skillId: "org-scoped-skill",
      // The catalog name is the SLUG for an extension-owned skill; the label a
      // surface prints is the manifest title (cinatra#2841). Fixtures keep the
      // two DIFFERENT so a regression back onto `name` fails loudly.
      name: "org-scoped",
      displayName: "Org Scoped",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ]);
  releaseRecommendationParkForRun.mockResolvedValue(true);
  triggerAgentRun.mockResolvedValue({ ok: true });
  readRunSelectedSkillRevisions.mockReturnValue([]);
  readRunRejectedRecommendations.mockReturnValue([]);
  hasRunRecommendationSkip.mockReturnValue(false);
  // The run-level skip marker writer VERIFIES its write and returns whether the
  // marker read back (cinatra#2794); the happy path is "it landed".
  writeRunRecommendationSkip.mockReturnValue(true);
  readRunCoOwners.mockResolvedValue([]);
  // The DEFAULT is a hold that owns no claim — one parked before cinatra#2906 —
  // so every arm written before this field existed keeps its exact reading.
  readRunRecommendationOfferedSet.mockResolvedValue([]);
  enforceRunAccess.mockResolvedValue(undefined);
});

describe("getRunRecommendationHoldStateAction — run access door (cinatra#2148)", () => {
  it("loads the run THROUGH the access door WITH role hints (no over-admit, no false deny)", async () => {
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state.state).toBe("held");
    expect(readAgentRunById).toHaveBeenCalledWith(
      "run-1",
      { actorType: "human", source: "ui", userId: USER },
      // Without these hints the door falsely DENIES a platform-admin /
      // org-admin / policy-authorized same-org reader.
      {
        platformRole: "platform_admin",
        orgRole: "org_admin",
        teamIds: ["team-a"],
        projectGrants: [{ projectId: "proj-a", role: "read" }],
        actorOrganizationId: "org-1",
      },
    );
  });

  it("a DENIED run read yields no row — and never even probes the park", async () => {
    // enforceRunAccess throws AuthzError for a run this session may not read.
    readAgentRunById.mockRejectedValue(new Error("AuthzError: forbidden"));
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toEqual({ state: "none" });
    expect(readRecommendationParkForRun).not.toHaveBeenCalled();
    expect(resolveRecommendationCandidateSkillIds).not.toHaveBeenCalled();
  });

  it("presents the candidate set INTERSECTED with the viewer's own entitlement", async () => {
    await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(resolveRecommendationCandidateSkillIds).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1", runBy: USER }),
      packageName: "@vendor/agent",
      viewer: {
        principalId: USER,
        teamIds: ["team-a"],
        projectIds: ["proj-a"],
        organizationId: "org-1",
      },
    });
  });

  it("FAIL-CLOSED: an unresolvable viewer scope renders no row", async () => {
    requireActorContext.mockRejectedValue(new Error("no actor"));
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toEqual({ state: "none" });
    expect(resolveRecommendationCandidateSkillIds).not.toHaveBeenCalled();
  });
});

describe("releaseAndDispatch — a live park is never reported as dispatched (cinatra#2148)", () => {
  it("a FAILED release returns a retryable error, not a false success", async () => {
    releaseRecommendationParkForRun.mockResolvedValue(false);
    // The park is STILL live after the release attempt.
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not release/i);
    // Critically: we never claim a dispatch that did not happen.
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("a THROWING release is equally a retryable error (never swallowed into success)", async () => {
    releaseRecommendationParkForRun.mockRejectedValue(new Error("sweeper down"));
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an UNREADABLE park after release is treated as still-held", async () => {
    // "I could not confirm the release" must never become "dispatched".
    releaseRecommendationParkForRun.mockResolvedValue(false);
    readRecommendationParkForRun.mockImplementation(async () => {
      throw new Error("park read down");
    });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not release/i);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("a SUCCESSFUL release dispatches through the canonical triggerAgentRun", async () => {
    releaseRecommendationParkForRun.mockResolvedValue(true);
    readRecommendationParkForRun
      // 1st call: the skip-evidence path's own park read is not used; the
      // post-release verification sees a RELEASED park.
      .mockResolvedValue({ id: "park-1", checkpoint: "recommendation", status: "released" });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res).toEqual({ ok: true, dispatched: true });
    expect(triggerAgentRun).toHaveBeenCalledWith({ runId: "run-1", templateSlug: "tpl-1" });
  });

  // cinatra#2523 (codex round-1 finding). Setup now ends on `pending_trigger`,
  // so an immediate trigger chosen there can park at the run-start
  // recommendation interception FROM that state. This guard used to read any
  // status other than `pending_input` as "already advanced" and answer
  // `{ok:true, dispatched:false}` — a run that never moved, reported as a
  // success. That is precisely the false-success shape #2148's verification and
  // this issue's ruling both forbid.
  it("dispatches a run parked from the setup-success state (pending_trigger) — cinatra#2523", async () => {
    readAgentRunById.mockResolvedValue({ ...RUN, status: "pending_trigger" });
    releaseRecommendationParkForRun.mockResolvedValue(true);
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res).toEqual({ ok: true, dispatched: true });
    expect(triggerAgentRun).toHaveBeenCalledWith({ runId: "run-1", templateSlug: "tpl-1" });
  });

  // The "already advanced" arm still exists — it just no longer swallows the
  // new waiting state.
  it("still reports a genuinely advanced run without re-dispatching it", async () => {
    readAgentRunById.mockResolvedValue({ ...RUN, status: "running" });
    releaseRecommendationParkForRun.mockResolvedValue(true);
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res).toEqual({ ok: true, dispatched: false });
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE §V REDRAW'S TWO SERVER-SIDE READINGS (cinatra#2841)
// ---------------------------------------------------------------------------
//
// The redrawn card draws one chip per skill in its SETTLED state too, each
// stating what it recorded, and draws a READ-ONLY row for a reader who may see
// the proposal but not shape it. Both are derived here from evidence the run
// ALREADY writes — no new store semantics — so both are pinned here.

describe("the settled reading — one mark per skill, derived from the run's own evidence", () => {
  beforeEach(() => {
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "released",
    });
  });

  it("reads confirmed / adjusted / skipped off the selection and rejection rows", async () => {
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-kept", selectionSource: "recommended_confirmed" },
      { skillId: "s-forced", selectionSource: "user_forced" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([
      { skillId: "s-dropped", recommendationSource: "recommended_not_kept" },
    ]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state.state).toBe("confirmed");
    expect(state).toMatchObject({
      decided: [
        // Ordered by skill id, so the settled row is stable across reads.
        { skillId: "s-dropped", mark: "skipped" },
        { skillId: "s-forced", mark: "adjusted" },
        { skillId: "s-kept", mark: "confirmed" },
      ],
    });
  });

  it("a whole-row SKIP still names every skill it left out, so the settled row has chips", async () => {
    readRunSelectedSkillRevisions.mockReturnValue([]);
    hasRunRecommendationSkip.mockReturnValue(true);
    readRunRejectedRecommendations.mockReturnValue([
      { skillId: "s-a", recommendationSource: "user_skipped" },
      { skillId: "s-b", recommendationSource: "user_skipped" },
    ]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toEqual({
      state: "skipped",
      // The three fields a settled answer carries so the selection is not frozen
      // (cinatra#3047): the hold a re-decision binds to, whether the run has
      // started, and this reader's own standing.
      holdRef: "ref-park-1",
      runStarted: false,
      canDecide: true,
      decided: [
        // No name resolves for either id here, so each keeps its id as its
        // label — the truest one available (cinatra#2841).
        { skillId: "s-a", name: "s-a", mark: "skipped" },
        { skillId: "s-b", name: "s-b", mark: "skipped" },
      ],
      // This hold owns no claim, so there is no offer to carry and the settled
      // row reads exactly the evidence, as it did before cinatra#2790.
      candidates: [],
    });
  });

  it("a rejection row for a skill that is ALSO in the selection reads as kept, not skipped", async () => {
    // The efficacy split can record a skill on both halves across re-decisions.
    // Being in the run's authoritative set is the stronger fact.
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-both", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([
      { skillId: "s-both", recommendationSource: "recommended_not_kept" },
    ]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({ decided: [{ skillId: "s-both", mark: "confirmed" }] });
  });

  it("an unreadable rejection store costs the marks, never the settled card", async () => {
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-kept", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockImplementation(() => {
      throw new Error("store down");
    });

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "confirmed",
      skillNames: ["s-kept"],
      decided: [{ skillId: "s-kept", name: "s-kept", mark: "confirmed" }],
    });
  });

  // -------------------------------------------------------------------------
  // THE GRADED §V FINDINGS (cinatra#2841 / PR #2866), server side
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // THE HOLD'S OWN OFFER, carried into the settled reading (cinatra#2790 S9f)
  //
  // §V: "SETTLED — ONE CHIP PER SKILL, EACH SHOWING WHAT IT RECORDED". A skill
  // settled by pressing its own Skip writes NO decision row — the selection
  // store records what the run will use, and the rejected half is written only
  // for a candidate the scorer RECOMMENDED — so on a force-add offer the
  // evidence alone cannot name it. The offer can, and it is durable.
  // -------------------------------------------------------------------------

  it("carries the hold's OFFER, so a skill that left no decision row can still be drawn", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      { skillId: "org-scoped-skill", skillRevisionId: "rev-1", recommended: false, rank: 1 },
      { skillId: "s-kept", skillRevisionId: "rev-2", recommended: false, rank: 2 },
    ]);
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-kept", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);
    resolveRecommendationCandidateSkillIds.mockResolvedValue(["org-scoped-skill", "s-kept"]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "confirmed",
      // ONE entry per skill the reader was ASKED about, in the order the hold
      // offered them, each carrying the label the held chip carried.
      candidates: [
        { skillId: "org-scoped-skill", name: "Org Scoped" },
        { skillId: "s-kept", name: "s-kept" },
      ],
      // The evidence itself is unchanged — the offer is carried BESIDE it.
      decided: [{ skillId: "s-kept", name: "s-kept", mark: "confirmed" }],
    });
    // It is read for THIS hold, not for the run.
    expect(readRunRecommendationOfferedSet).toHaveBeenCalledWith("park-1");
  });

  it("INTERSECTS the offer with the viewer's own entitlement, as the held row does", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      { skillId: "org-scoped-skill", skillRevisionId: "rev-1", recommended: false, rank: 1 },
      { skillId: "not-mine", skillRevisionId: "rev-9", recommended: false, rank: 2 },
    ]);
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "org-scoped-skill", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);
    // The VIEWER-scoped call is the narrower one; the unscoped call (used only
    // to resolve labels) still answers with the wider set.
    resolveRecommendationCandidateSkillIds.mockImplementation(
      async (input: { viewer?: unknown }) =>
        input.viewer ? ["org-scoped-skill"] : ["org-scoped-skill", "not-mine"],
    );

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      candidates: [{ skillId: "org-scoped-skill", name: "Org Scoped" }],
    });
    // The skill this reader may not see is not named to them by the settled row.
    expect(JSON.stringify(state)).not.toContain("not-mine");
  });

  it("an UNREADABLE offer costs the extra chips, never the settled card", async () => {
    readRunRecommendationOfferedSet.mockRejectedValue(new Error("offer store down"));
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-kept", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "confirmed",
      decided: [{ skillId: "s-kept", name: "s-kept", mark: "confirmed" }],
      candidates: [],
    });
  });

  it("finding 1 — a `user_adjusted` selection row reads back as ADJUSTED", async () => {
    // The mark the redraw could not reach. `user_forced` is stamped only for an
    // id OUTSIDE the scored set, and the chip row offers exactly the scored set,
    // so an in-set Adjust used to be written `recommended_confirmed` and read
    // back `Confirmed`. `user_adjusted` is the in-set edit's own source.
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-adjusted", selectionSource: "user_adjusted" },
      { skillId: "s-plain", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      decided: [
        { skillId: "s-adjusted", mark: "adjusted" },
        { skillId: "s-plain", mark: "confirmed" },
      ],
    });
  });

  it("finding 1 — a headless AUTO-APPLIED row is confirmed, not adjusted (negative control)", async () => {
    // Only the two HUMAN-edit sources read as `adjusted`. A run nobody shaped
    // must never claim a reader shaped it.
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-auto", selectionSource: "recommended_auto_applied" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({ decided: [{ skillId: "s-auto", mark: "confirmed" }] });
  });

  it("finding 2 — the settled rows carry the DISPLAY NAME, resolved the way the held branch resolves it", async () => {
    // §V names skills on BOTH readings. The evidence rows are ids, so the names
    // are joined in from the same candidate seam + scorer the held branch uses.
    // The name taken is the ranked row's `displayName` — the owning extension's
    // manifest title — NOT its catalog `name`, which for these ids is the slug.
    getRunRecommendations.mockResolvedValue([
      {
        skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
        skillRevisionId: "rev-b",
        name: "blog-writing",
        displayName: "Blog Writing Skill",
        score: 0.9,
        rank: 1,
        recommended: true,
        scoredFeatures: [],
      },
      {
        skillId: "@cinatra-ai/outreach-skill:schedule-send",
        skillRevisionId: "rev-s",
        name: "schedule-send",
        displayName: "Schedule Send Skill",
        score: 0.2,
        rank: 2,
        recommended: true,
        scoredFeatures: [],
      },
    ]);
    readRunSelectedSkillRevisions.mockReturnValue([
      {
        skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
        selectionSource: "recommended_confirmed",
      },
    ]);
    readRunRejectedRecommendations.mockReturnValue([
      {
        skillId: "@cinatra-ai/outreach-skill:schedule-send",
        recommendationSource: "recommended_not_kept",
      },
    ]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "confirmed",
      // The field is called `skillNames`; it now truthfully holds names.
      skillNames: ["Blog Writing Skill"],
      decided: [
        {
          skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
          name: "Blog Writing Skill",
          mark: "confirmed",
        },
        {
          skillId: "@cinatra-ai/outreach-skill:schedule-send",
          name: "Schedule Send Skill",
          mark: "skipped",
        },
      ],
    });
    // THE GRADED DEFECT, pinned as a negative: neither settled chip may print
    // the slug the catalog row carries.
    const settled = state.state === "confirmed" ? state.decided : [];
    expect(settled.map((d) => d.name)).not.toContain("blog-writing");
    expect(settled.map((d) => d.name)).not.toContain("schedule-send");
    // The name join is NOT viewer-intersected — the decided summary is the set
    // THIS run resolved, exactly as the branch's own comment states.
    expect(resolveRecommendationCandidateSkillIds).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1" }),
      packageName: "@vendor/agent",
    });
  });

  it("finding 2 — the HELD row hands the card the SAME resolved label, never the slug", async () => {
    // The other half of "held and settled label a skill identically": the held
    // branch maps the ranked row onto `RecommendedSkillForChip`, whose `name` IS
    // the label the chip prints. It must be the manifest title too. This
    // describe's `beforeEach` releases the park to reach the settled branch, so
    // the LIVE hold is put back for this one case.
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "held",
      recommendations: [
        expect.objectContaining({ skillId: "org-scoped-skill", name: "Org Scoped" }),
      ],
    });
    const held = state.state === "held" ? state.recommendations : [];
    expect(held.map((r) => r.name)).not.toContain("org-scoped");
  });

  it("finding 2 — an unresolvable name costs the label, never the settled card", async () => {
    getRunRecommendations.mockRejectedValue(new Error("scorer down"));
    readRunSelectedSkillRevisions.mockReturnValue([
      { skillId: "s-kept", selectionSource: "recommended_confirmed" },
    ]);
    readRunRejectedRecommendations.mockReturnValue([]);

    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({
      state: "confirmed",
      skillNames: ["s-kept"],
      decided: [{ skillId: "s-kept", name: "s-kept", mark: "confirmed" }],
    });
  });
});

describe("the read-only reading — canDecide rides the SAME execute gate the confirm enforces", () => {
  it("a reader the execute gate admits gets the affordances", async () => {
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({ state: "held", canDecide: true });
    expect(enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      expect.anything(),
      "execute",
      expect.objectContaining({ platformRole: "platform_admin" }),
    );
  });

  it("a reader the execute gate REFUSES still gets the card, drawn read-only", async () => {
    enforceRunAccess.mockRejectedValue(new Error("forbidden"));
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    // The proposal is still shown — §V draws the chips disabled with the reason,
    // it does not withhold the card.
    expect(state).toMatchObject({ state: "held", canDecide: false });
  });

  it("FAIL-OPEN on a derivation that cannot answer — the flag is presentation, never authority", async () => {
    // The decision actions re-authorize on their own, so an unresolvable hint
    // must not strip the affordances from a reader who may in fact decide.
    readRunCoOwners.mockRejectedValue(new Error("co-owner store down"));
    enforceRunAccess.mockResolvedValue(undefined);
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toMatchObject({ state: "held", canDecide: true });
  });
});
