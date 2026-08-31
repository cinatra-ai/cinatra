// The schedule card's RUN identity — the run_card and page_gate_region binding
// (cinatra#2788, epic #2784 S9d).
//
// §VI's card has two identities because its subject has two lives. In a
// conversation the ref IS the proposal. On the run page and the review page
// there is no token to carry, so the card is addressed by the run it settled
// into and the resolver re-derives the plan's (viewer, organization, template)
// binding from the proposal's own consume row.
//
// What this suite proves:
//
//   1. The ref families are CRYPTOGRAPHICALLY DISJOINT. A gate ref presented to
//      the schedule decoder does not decode, and a schedule ref presented to the
//      gate decoder does not either — so "one ref addresses one kind of thing"
//      is a property of the key, not of a discriminator byte a caller could flip.
//   2. The run path answers `absent` for every binding that does not hold: a run
//      no proposal produced, a reader who is not the person who confirmed it, a
//      different organization, a vanished template, a run with nothing installed.
//   3. It answers the SETTLED body, with **Cancel schedule** offered only for a
//      recurring schedule that has fired once, when it does (cinatra#2972).
//   4. `absent` never carries a body — the privacy contract, on this path too.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  describeProposalSchedule: () => "Every weekday at 9:00 AM",
}));

import {
  decodeLifecycleGateRef,
  decodeScheduleRunRef,
  encodeLifecycleGateRef,
  encodeScheduleRunRef,
} from "../lifecycle-card-ref";
import { resolveTriggerScheduleProposalCard } from "../trigger-schedule-proposal-card";

const READER = { userId: "u-1", orgId: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  resolveProposalForReader.mockResolvedValue({ phase: "absent" });
});

describe("the two ref families are disjoint", () => {
  it("a run ref round-trips, and carries nothing readable", () => {
    const ref = encodeScheduleRunRef({ runId: "run-42" })!;
    expect(ref).toBeTruthy();
    expect(decodeScheduleRunRef(ref)).toEqual({ runId: "run-42" });
    // Opaque: the run id is not recoverable by reading the ref.
    expect(ref).not.toContain("run-42");
  });

  it("a GATE ref does not decode as a schedule ref, and vice versa", () => {
    const gate = encodeLifecycleGateRef({ runId: "run-42", reviewTaskId: "task-1" })!;
    const run = encodeScheduleRunRef({ runId: "run-42" })!;
    expect(decodeScheduleRunRef(gate)).toBeNull();
    expect(decodeLifecycleGateRef(run)).toBeNull();
  });

  it("a tampered ref, a foreign string and an oversized one all decode to nothing", () => {
    const ref = encodeScheduleRunRef({ runId: "run-42" })!;
    expect(decodeScheduleRunRef(`${ref.slice(0, -2)}AB`)).toBeNull();
    expect(decodeScheduleRunRef("not-a-ref")).toBeNull();
    expect(decodeScheduleRunRef("x".repeat(600))).toBeNull();
    expect(decodeScheduleRunRef("")).toBeNull();
  });

  it("a run id that does not fit the bounds mints no ref at all", () => {
    expect(encodeScheduleRunRef({ runId: "" })).toBeNull();
    expect(encodeScheduleRunRef({ runId: "r".repeat(200) })).toBeNull();
  });
});

describe("the run-scoped resolve", () => {
  const RUN_REF = encodeScheduleRunRef({ runId: "run-42" })!;

  it("routes a run ref to the RUN path and a token to the reader path — never both", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "absent" });
    await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(resolveProposalForRun).toHaveBeenCalledWith(
      "run-42",
      { userId: "u-1", orgId: "org-1" },
      // cinatra#3004: the run path also carries the reader's STANDING, because a
      // run whose schedule came from its own scheduling step is read under the
      // RUN's access control. `undefined` where the caller presented none — the
      // service then falls back to the run's own owner.
      undefined,
    );
    expect(resolveProposalForReader).not.toHaveBeenCalled();

    vi.clearAllMocks();
    resolveProposalForReader.mockResolvedValue({ phase: "absent" });
    await resolveTriggerScheduleProposalCard({ ref: "cst_token", ...READER });
    // The TOKEN path takes no standing: a proposal is bound to one person, and
    // that binding is the token's own.
    expect(resolveProposalForReader).toHaveBeenCalledWith("cst_token", {
      userId: "u-1",
      orgId: "org-1",
    });
    expect(resolveProposalForRun).not.toHaveBeenCalled();
  });

  it("hands the run path the standing the caller presented, and never one it made up", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "absent" });
    const access = {
      actor: { userId: "u-1" } as never,
      roles: { orgRole: "admin", actorOrganizationId: "org-1" } as never,
    };
    await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER, access });
    expect(resolveProposalForRun).toHaveBeenCalledWith(
      "run-42",
      { userId: "u-1", orgId: "org-1" },
      access,
    );
  });

  it("a run the binding does not hold for draws NO card and carries NO body", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "absent" });
    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(card.state).toEqual({ state: "absent" });
    expect(card.view).toBeNull();
  });

  // cinatra#2972 AMENDED THIS TEST'S SUBJECT. It used to read "a settled run
  // draws the trigger's chrome, and Release is admin-only" and asserted a
  // `canRelease` that varied by standing. Plan (A) §7.2 as amended 2026-08-25
  // withdrew Run now from every surface, and rewrote what Cancel schedule is
  // offered for: "shown only for a recurring schedule that has fired once".
  it("a settled recurring run that has FIRED offers Cancel schedule", async () => {
    resolveProposalForRun.mockResolvedValue({
      phase: "settled" as const,
      runId: "run-42",
      agentName: "Weekly cohort sweep",
      triggerType: "recurring" as const,
      scheduleCopy: "Every weekday at 9:00 AM",
      timezone: "Europe/Berlin",
      released: false,
      arming: false,
      firedOnce: true,
      stopped: false,
      // AND THIS READER MAY ACT ON IT (cinatra#2934, the convergence round of
      // the fourth fix leg). Cancel schedule is the run owner's control or an
      // administrator's, plan (A) §7.1 — the resolver answers that question
      // once and both floor controls read it, so the fixture has to say who
      // the reader is rather than leaving it unsaid.
      mayAct: true,
    });

    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(card.state).toEqual({ state: "settled" });
    expect(card.view).toMatchObject({
      phase: "settled",
      runId: "run-42",
      scheduleCopy: "Every weekday at 9:00 AM",
      canCancel: true,
    });
    // THE WITHDRAWN CONTROL IS DEAD, NOT ABSENT FROM THE WIRE (cinatra#2972,
    // codex round 2). The key is still emitted as a constant false, so a stale
    // bundle whose strict settled schema still requires it goes on parsing
    // settled cards through a rolling deploy. What is gone is the control, the
    // confirm strip and the `release` op — nothing can read this back into one.
    expect(card.view).toMatchObject({ canRelease: false });
  });

  it("a recurring schedule that has NOT fired yet offers no control", async () => {
    resolveProposalForRun.mockResolvedValue({
      phase: "settled",
      runId: "run-42",
      agentName: "a",
      triggerType: "recurring",
      scheduleCopy: "Every weekday at 9:00 AM",
      timezone: "UTC",
      released: false,
      arming: false,
      firedOnce: false,
      stopped: false,
    });
    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(card.view).toMatchObject({ canCancel: false });
  });

  it("a ONE-OFF that has fired offers no control, whatever its stamps say", async () => {
    resolveProposalForRun.mockResolvedValue({
      phase: "settled",
      runId: "run-42",
      agentName: "a",
      triggerType: "scheduled",
      scheduleCopy: "Once, at 2026-09-01 09:00 UTC",
      timezone: "UTC",
      released: true,
      arming: false,
      firedOnce: true,
      stopped: false,
    });
    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(card.view).toMatchObject({ released: true, canCancel: false });
  });

  it("while the install is still draining, no control is offered", async () => {
    resolveProposalForRun.mockResolvedValue({
      phase: "settled",
      runId: "run-42",
      agentName: "a",
      triggerType: "recurring",
      scheduleCopy: "Every weekday at 9:00 AM",
      timezone: "UTC",
      released: false,
      arming: true,
      firedOnce: true,
      stopped: false,
    });
    const card = await resolveTriggerScheduleProposalCard({
      ref: RUN_REF,
      ...READER,
    });
    expect(card.view).toMatchObject({ arming: true, canCancel: false });
  });

  it("a STOPPED recurring schedule offers no control and says so on the wire", async () => {
    resolveProposalForRun.mockResolvedValue({
      phase: "settled",
      runId: "run-42",
      agentName: "a",
      triggerType: "recurring",
      scheduleCopy: "Every weekday at 9:00 AM",
      timezone: "UTC",
      released: false,
      arming: false,
      firedOnce: true,
      stopped: true,
    });
    const card = await resolveTriggerScheduleProposalCard({
      ref: RUN_REF,
      ...READER,
    });
    expect(card.view).toMatchObject({ stopped: true, canCancel: false });
  });

  it("a reader with no attributable user or org resolves nothing at all", async () => {
    for (const bad of [{ userId: "", orgId: "org-1" }, { userId: "u-1", orgId: "" }]) {
      const card = await resolveTriggerScheduleProposalCard({
        ref: RUN_REF,
        ...bad,
      });
      expect(card.state).toEqual({ state: "absent" });
      expect(card.view).toBeNull();
    }
    expect(resolveProposalForRun).not.toHaveBeenCalled();
  });

  it("a store failure is an `absent`, not an existence signal", async () => {
    resolveProposalForRun.mockRejectedValue(new Error("store down"));
    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });
    expect(card.state).toEqual({ state: "absent" });
    expect(card.view).toBeNull();
  });
});
