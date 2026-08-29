// THE ARMED SCHEDULE IS CHANGED FROM ITS OWN WINDOW (cinatra#2934, lifecycle-b
// W5c — the armed-trigger tab, owed by this pull request's Deviation 1 and
// asked for by the maintainer's CHANGES REQUESTED reading):
//
//   · issue 2934 acceptance 1: "an armed one-off changed before firing and
//     refused after";
//   · plan §5: "fixtures on the run page, the step-by-step screen, the schedule
//     screen, the armed-trigger tab and the review page";
//   · plan §4: "When you plainly ask, in the same message, for it to be
//     submitted, the assistant submits through the same checked, server-side
//     action the button uses — one road for the press and for the ask — and the
//     fields still show what was sent."
//
// The REAL handlers run. What is substituted is the world under them — the
// resolver's rows, the window store, the standing lookup and the card's own
// decide entry — so what these cases prove is WHICH authority each road demands
// and WHAT reaches the schedule.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-armed-window";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));

const appended: Array<Record<string, unknown>> = [];
const windowRows: Array<Record<string, unknown>> = [];
vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  appendRunWindowMessage: async (input: Record<string, unknown>) => {
    appended.push(input);
    const row = { ...input, id: `m${appended.length}`, sequence: appended.length, createdAt: new Date() };
    windowRows.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...windowRows],
  readRunWindowFillsForMessage: async (_runId: string, ref: string, messageId: string) =>
    windowRows
      .filter((r) => r.messageId === messageId)
      .map((r) => r.fill as { ref: string; values: Record<string, unknown> } | undefined)
      .filter((f): f is { ref: string; values: Record<string, unknown> } => !!f && f.ref === ref),
  // The armed form's save reads what is PLACED AND NOT YET SAVED (cinatra#2934,
  // the armed-schedule change road): this message's own fills, plus this
  // person's earlier placements since the trigger row was last written.
  readRunWindowPlacedFills: async (
    _runId: string,
    ref: string,
    opts: { messageId: string; placedBy?: string | null; since?: Date | null },
  ) =>
    windowRows
      .filter((r) => {
        const fill = r.fill as { ref: string } | undefined;
        if (!fill || fill.ref !== ref) return false;
        if (r.messageId === opts.messageId) return true;
        if (!opts.placedBy || r.placedBy !== opts.placedBy) return false;
        if (opts.since && (r.createdAt as Date) < opts.since) return false;
        return true;
      })
      .map((r) => r.fill as { ref: string; values: Record<string, unknown> }),
  readRunWindowAttachmentsForMessage: async () => null,
}));

/** The single-use ledger, as the two roads really use it: the fill CLAIMS it
 *  without spending, the save SPENDS it once and never again. */
let grantSpent = false;
vi.mock("../lent-action-grant-store", () => ({
  lentActionGrantIsSpendable: async () => !grantSpent,
  consumeLentActionGrant: async () => {
    if (grantSpent) return { outcome: "refused" };
    grantSpent = true;
    return { outcome: "consumed", messageText: "move it to Tuesdays at 9" };
  },
  recordLentActionGrant: async () => true,
  sweepExpiredLentActionGrants: async () => undefined,
}));

let mayRespond = true;
vi.mock("../run-window-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-window-turn")>();
  return {
    boundScreenClaimForSurface: actual.boundScreenClaimForSurface,
    canActorRespondToRun: async () => mayRespond,
  };
});

vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({ readRunTriggerByRunId: vi.fn() }));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import {
  DEFAULT_RECURRING_CONFIG,
  applyArmedScheduleFill,
  armedScheduleFormValues,
} from "@cinatra-ai/agents/trigger-recurrence";
import { SAVE_SCHEDULE_REFUSALS } from "@cinatra-ai/agents/trigger-service";
import { decodeScheduleRunRef, encodeScheduleRunRef } from "../lifecycle-card-ref";
import { LENT_ACTION_CONTROLS, mintLentActionGrant } from "../lent-action-grant";
import {
  ARMED_SCHEDULE_FORM_X_RENDERER,
  armedScheduleFormSchema,
  scheduleFormRowNames,
} from "../schedule-form-screen";
import { controlsLentBy } from "../bound-reference-resolver";
import { primaryControlFor } from "../bound-card-binding";
import { recordBoundScreenFill } from "../bound-screen-fill";
import {
  BOUND_SCREEN_FILL_UNAVAILABLE,
  handleBoundScreenFill,
} from "../bound-screen-fill-mcp";
import { handleLentAction } from "../lent-action-mcp";
import { boundScreenClaimForSurface } from "../run-window-turn";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_armed_1";
const REF = encodeScheduleRunRef({ runId: RUN })!;

const ACTOR: ReviewActorContext = {
  actor: {
    actorType: "human",
    source: "agent",
    userId: PERSON.userId,
    orgId: PERSON.orgId,
  },
  orgId: PERSON.orgId,
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

/** The armed schedule the card is drawing — a weekly recurrence in Berlin. */
const ARMED = {
  kind: "recurring" as const,
  selection: { ...DEFAULT_RECURRING_CONFIG, weekdays: [1], hour: 8, minute: 0 },
  timezone: "Europe/Berlin",
};

function armedResolution(over: Record<string, unknown> = {}) {
  const schedule = (over.schedule as typeof ARMED) ?? ARMED;
  return {
    kind: "armed_schedule_form" as const,
    runId: RUN,
    xRenderer: ARMED_SCHEDULE_FORM_X_RENDERER,
    canSave: true,
    refusal: null,
    schedule,
    form: { schema: armedScheduleFormSchema(), values: armedScheduleFormValues(schedule) },
    ...over,
  };
}

const resolveArmed = vi.fn(async () => armedResolution() as never);
const resolveActor = vi.fn(async () => ACTOR as never);

function mint(control: "save" | "submit", ref = REF) {
  const minted = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId: "msg_1",
    cardRef: ref,
    control,
  });
  if (!minted) throw new Error("mint failed");
  return minted;
}

beforeEach(() => {
  frame.store = undefined;
  appended.length = 0;
  windowRows.length = 0;
  grantSpent = false;
  mayRespond = true;
  resolveArmed.mockClear().mockImplementation(async () => armedResolution() as never);
  resolveActor.mockClear().mockImplementation(async () => ACTOR as never);
});

// ---------------------------------------------------------------------------
// The armed-trigger tab's window is bound to the ARMED FORM.
// ---------------------------------------------------------------------------
describe("the armed-trigger tab binds the form the person is looking at", () => {
  it("the turn mints the run's own schedule ref for it — not the run's waiting screen", () => {
    const claim = boundScreenClaimForSurface("armed-trigger", RUN);
    expect(claim.screenRunIds).toEqual([]);
    expect(claim.candidateRefs).toHaveLength(1);
    // The ref is authenticated-encrypted, so two mints of one run are two
    // different strings: it is compared by what it ADDRESSES.
    expect(decodeScheduleRunRef(claim.candidateRefs[0]!)).toEqual({ runId: RUN });
  });

  it("the armed form lends a fill AND a save, and a save is a pressable control", () => {
    expect(controlsLentBy(armedResolution() as never)).toEqual(["fill", "save"]);
    expect(primaryControlFor(armedResolution() as never)).toBe("save");
    expect(LENT_ACTION_CONTROLS).toContain("save");
    // Filling is still never an authority a grant can spend.
    expect(LENT_ACTION_CONTROLS).not.toContain("fill");
  });

  it("its descriptor joins the per-screen set with the scheduler form's own rows", () => {
    expect(ARMED_SCHEDULE_FORM_X_RENDERER).toBe("armed-schedule-form");
    const props = (armedScheduleFormSchema() as { properties: Record<string, unknown> })
      .properties;
    for (const row of ["scheduledAt", "timezone", "frequency", "interval", "weekdays", "hour", "minute"]) {
      expect(Object.keys(props), row).toContain(row);
    }
    // The SAME closed set as the scheduling step's own form — one declaration.
    expect(Object.keys(props)).toEqual([...scheduleFormRowNames()]);
    // And no raw cron row, on either form.
    expect(Object.keys(props)).not.toContain("cronExpression");
  });
});

// ---------------------------------------------------------------------------
// (1) A described change lands in the form's own rows. NOTHING is saved.
// ---------------------------------------------------------------------------
describe("a described change lands in the armed form's rows and saves nothing", () => {
  it("places Run at / Timezone / the recurring rows and records no write", async () => {
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9, timezone: "Europe/Lisbon" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => !grantSpent,
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    expect(outcome).toEqual({
      kind: "filled",
      ref: REF,
      applied: ["timezone", "weekdays", "hour"],
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toBe("");
    expect(appended[0]!.surface).toBe("armed-trigger");
    expect(appended[0]!.fill).toEqual({
      ref: REF,
      values: { timezone: "Europe/Lisbon", weekdays: [2], hour: 9 },
    });
    // The grant was CLAIMED, never spent: the person still presses Save changes.
    expect(grantSpent).toBe(false);
  });

  it("a row the armed form does not draw is dropped rather than placed", async () => {
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { cronExpression: "0 9 * * 2", nonsense: true },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveArmed as never },
    });
    expect(outcome.kind).toBe("no-fields");
    expect(appended).toHaveLength(0);
  });

  it("the placed values move the form's OWN selections, exactly as its controls do", () => {
    const next = applyArmedScheduleFill(ARMED, {
      weekdays: [2],
      hour: 9,
      timezone: "Europe/Lisbon",
    });
    expect(next).toEqual({
      kind: "recurring",
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Lisbon",
    });
    // A one-off asked for by its time alone stays a one-off on the row it names.
    expect(
      applyArmedScheduleFill(
        { kind: "scheduled", runAt: "2026-09-01T09:00", timezone: "UTC" },
        { scheduledAt: "2026-09-02T10:30" },
      ),
    ).toEqual({ kind: "scheduled", runAt: "2026-09-02T10:30", timezone: "UTC" });
    // And the rows read back are what the card is drawing.
    expect(armedScheduleFormValues(ARMED)).toMatchObject({
      triggerType: "recurring",
      timezone: "Europe/Berlin",
      weekdays: [1],
      hour: 8,
    });
  });
});

// ---------------------------------------------------------------------------
// (2) The same message plainly asking for it to be saved goes down the SAME
// checked road the Save changes button uses — once.
// ---------------------------------------------------------------------------
describe("asking for it to be saved takes the button's own road", () => {
  const decide = vi.fn(async (_input: Record<string, unknown>) =>
    ({ kind: "saved", runId: RUN }) as never,
  );

  beforeEach(() => {
    decide.mockClear().mockImplementation(async () => ({ kind: "saved", runId: RUN }) as never);
  });

  it("calls the card's own save op with the rows the person was shown", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    // The same message fills first — that is what a press has to show.
    await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect(decide).toHaveBeenCalledTimes(1);
    const call = decide.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.op).toBe("save");
    expect(call.ref).toBe(REF);
    expect(call.schedule).toEqual({
      kind: "recurring",
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Berlin",
    });
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it("reads the trigger row back, so the rows still show what was saved", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    const saved = {
      kind: "recurring" as const,
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Berlin",
    };
    // The FIRST resolve is the card as it stood; the one AFTER the write is the
    // trigger row read back.
    resolveArmed
      .mockImplementationOnce(async () => armedResolution() as never)
      .mockImplementationOnce(async () => armedResolution({ schedule: saved }) as never);
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const body = res.structuredContent as { ok: boolean; outcome: { rows: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.outcome.rows).toMatchObject({ weekdays: [2], hour: 9 });
  });

  it("is idempotent under a double press: the second ask writes nothing", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    const deps = {
      resolve: resolveArmed as never,
      resolveActor: resolveActor as never,
      decideSchedule: decide as never,
    };
    const first = await handleLentAction({ ref: REF }, deps);
    const second = await handleLentAction({ ref: REF }, deps);
    expect((first.structuredContent as { ok: boolean }).ok).toBe(true);
    expect((second.structuredContent as { ok: boolean }).ok).toBe(false);
    // ONE write. The grant is spent once, before the effect.
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("a message that placed nothing presses nothing", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (3) A form that can no longer be edited: the window says so and touches
// nothing.
// ---------------------------------------------------------------------------
describe("a schedule that can no longer be changed is refused, in words", () => {
  const frozen = () =>
    armedResolution({ canSave: false, refusal: SAVE_SCHEDULE_REFUSALS.firedOneOff }) as never;

  it("the fill answers with the state and writes no row", async () => {
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: vi.fn(async () => frozen()) as never },
    });
    expect(outcome).toEqual({
      kind: "not-editable",
      message: SAVE_SCHEDULE_REFUSALS.firedOneOff,
    });
    expect(appended).toHaveLength(0);
  });

  it("and the window relays that sentence rather than the blank refusal", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    const res = await handleBoundScreenFill(
      { ref: REF, values: { hour: 9 } },
      {
        resolveActor: resolveActor as never,
        record: (async () => ({
          kind: "not-editable",
          message: SAVE_SCHEDULE_REFUSALS.firedOneOff,
        })) as never,
      },
    );
    const body = res.structuredContent as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toBe(SAVE_SCHEDULE_REFUSALS.firedOneOff);
    expect(body.message).not.toBe(BOUND_SCREEN_FILL_UNAVAILABLE);
  });

  it("the ask-to-save is refused before the grant is even spent", async () => {
    const decide = vi.fn();
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: vi.fn(async () => frozen()) as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(grantSpent).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// WHAT IS SAVED IS WHAT THE ROWS SHOW (convergence round 2, findings 2 and 3).
//
// The card moves its draft ONE FILL AT A TIME. If the save road folded this
// message's fills into the row values the card is currently holding and applied
// them once, the placement rule would read a `triggerType` the person never
// typed — and a one-off asked to repeat would SHOW recurring in the rows while
// the write armed the one-off. And a read-back that could not be taken is not a
// read-back: the values held BEFORE the write are what was SENT, not what was
// ARMED.
// ---------------------------------------------------------------------------
describe("the save applies this message's fills the way the card does", () => {
  const ONEOFF = {
    kind: "scheduled" as const,
    runAt: "2026-09-01T09:00",
    timezone: "UTC",
  };
  const decide = vi.fn(async (_input: Record<string, unknown>) =>
    ({ kind: "saved", runId: RUN }) as never,
  );

  beforeEach(() => {
    decide.mockClear().mockImplementation(async () => ({ kind: "saved", runId: RUN }) as never);
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("save").grant,
    };
  });

  it("recurrence rows placed on a ONE-OFF save the recurring schedule the rows show", async () => {
    const resolveOneOff = vi.fn(async () => armedResolution({ schedule: ONEOFF }) as never);
    await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveOneOff as never, surface: "armed-trigger" },
    });
    await handleLentAction(
      { ref: REF },
      {
        resolve: resolveOneOff as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const call = decide.mock.calls[0]![0] as Record<string, unknown>;
    // THE BROWSER'S OWN ARITHMETIC, to the letter: the card writes
    // `applyArmedScheduleFill(prev, values)` into its draft with the values the
    // turn placed and nothing else.
    expect(call.schedule).toEqual(applyArmedScheduleFill(ONEOFF, { weekdays: [2], hour: 9 }));
    expect((call.schedule as { kind: string }).kind).toBe("recurring");
  });

  it("two fills in one message are applied in the order they were placed", async () => {
    const resolveOneOff = vi.fn(async () => armedResolution({ schedule: ONEOFF }) as never);
    for (const values of [{ weekdays: [2] }, { timezone: "Europe/Lisbon" }]) {
      await recordBoundScreenFill({
        ref: REF,
        values,
        actorCtx: ACTOR,
        messageId: "msg_1",
        deps: { resolve: resolveOneOff as never, surface: "armed-trigger" },
      });
    }
    await handleLentAction(
      { ref: REF },
      {
        resolve: resolveOneOff as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const call = decide.mock.calls[0]![0] as Record<string, unknown>;
    const sequential = [{ weekdays: [2] }, { timezone: "Europe/Lisbon" }].reduce(
      (sel, values) => applyArmedScheduleFill(sel, values),
      ONEOFF as ReturnType<typeof applyArmedScheduleFill>,
    );
    expect(call.schedule).toEqual(sequential);
    expect(call.schedule).toMatchObject({ kind: "recurring", timezone: "Europe/Lisbon" });
  });

  it("a read-back that cannot be taken is not reported as one", async () => {
    await recordBoundScreenFill({
      ref: REF,
      values: { weekdays: [2], hour: 9 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    resolveArmed
      .mockImplementationOnce(async () => armedResolution() as never)
      .mockImplementationOnce(async () => {
        throw new Error("the row could not be read");
      });
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const body = res.structuredContent as {
      ok: boolean;
      outcome: { kind: string; rows: unknown };
    };
    // The write STANDS — it is the reading that is missing, and it says so
    // rather than answering with the rows the card held before the write.
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("saved");
    expect(body.outcome.rows).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
