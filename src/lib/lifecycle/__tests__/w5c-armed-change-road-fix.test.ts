// THE ARMED-SCHEDULE CHANGE ROAD, AFTER THE GRADED RE-SHOOT (cinatra#2934,
// lifecycle-b W5c).
//
// The re-shoot measured the road on real runs and found four defects. Three of
// them are server-side and are pinned here; the fourth (a fired schedule's
// window) is a drawing and is pinned beside the card.
//
//   (1) THE ROAD WAS INTERMITTENT. A described change reached the rows on the
//       first ask of one run and on none of six asks of another, and every
//       failure answered the same sentence. The cause is not the model's mood:
//       an ARMED SCHEDULE FORM had NO system context of its own, so the turn
//       fell through to the REVIEW card's text — which tells the assistant it
//       is bound to "a review", names one pressable control, and never names
//       the fill road or the form's rows at all. Whether a described change
//       landed therefore depended on the assistant guessing a tool it was never
//       told about, and following the instruction it WAS given lost the turn.
//
//   (2) A BARE "Save that." SAVED NOTHING. The save arm read the fills of THIS
//       message only, so the fields the previous turn had placed — the ones the
//       person is looking at while they type "save that" — were invisible to
//       it. Issue #2934's own wording is that the person places the change and
//       then asks for it to be saved.
//
//   (3) THE REFUSAL NAMED THE WRONG REASON. "That card is not available to
//       you." went to the card's own owner with their own Save changes live in
//       the same frame. A card that IS available and simply has nothing placed
//       to save says that instead.
//
// The REAL handlers run; the world under them is substituted, exactly as the
// sibling armed-window suite does it.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-armed-change-road";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));

type Fill = { ref: string; values: Record<string, unknown> };
const windowRows: Array<Record<string, unknown>> = [];
let rowClock = new Date("2026-08-29T10:00:00.000Z");

vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  appendRunWindowMessage: async (input: Record<string, unknown>) => {
    const row = {
      ...input,
      id: `m${windowRows.length + 1}`,
      sequence: windowRows.length + 1,
      createdAt: new Date(rowClock),
    };
    windowRows.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...windowRows],
  readRunWindowFillsForMessage: async (_runId: string, ref: string, messageId: string) =>
    windowRows
      .filter((r) => r.messageId === messageId)
      .map((r) => r.fill as Fill | undefined)
      .filter((f): f is Fill => !!f && f.ref === ref),
  // THE READER THIS LEG ADDS: what is placed on that form and NOT YET SAVED.
  // The MOCK mirrors the real reader's shape — the form asked of `refMatches`
  // rather than matched on the bytes, the boundary resolved lazily and
  // FAIL-CLOSED, carried rows strictly newer than the write, this message's own
  // last. The reader itself is proven against a real database in
  // `armed-schedule-save-road.integration.test.ts`; what is exercised here is
  // the handler above it.
  readRunWindowPlacedFills: async (
    _runId: string,
    ref: string,
    opts: {
      messageId: string;
      placedBy?: string | null;
      since?: Date | null;
      resolveSince?: () => Promise<Date | null>;
      refMatches?: (rowRef: string) => boolean;
    },
  ) => {
    const sameForm = opts.refMatches ?? ((rowRef: string) => rowRef === ref);
    const onForm = windowRows.filter((r) => {
      const fill = r.fill as { ref: string } | undefined;
      return !!fill && sameForm(fill.ref);
    });
    const own = onForm.filter((r) => r.messageId === opts.messageId);
    const carried: Array<Record<string, unknown>> = [];
    if (opts.placedBy) {
      let since = opts.since ?? null;
      if (!since && opts.resolveSince) {
        since = await opts.resolveSince().catch(() => null);
      }
      if (since) {
        for (const r of onForm) {
          if (r.messageId === opts.messageId) continue;
          if (r.placedBy !== opts.placedBy) continue;
          if ((r.createdAt as Date).getTime() <= since.getTime()) continue;
          carried.push(r);
        }
      }
    }
    return [...carried, ...own].map(
      (r) => r.fill as { ref: string; values: Record<string, unknown> },
    );
  },
  readRunWindowAttachmentsForMessage: async () => null,
}));

let grantSpent = false;
vi.mock("../lent-action-grant-store", () => ({
  lentActionGrantIsSpendable: async () => !grantSpent,
  consumeLentActionGrant: async () => {
    if (grantSpent) return { outcome: "refused" };
    grantSpent = true;
    return { outcome: "consumed", messageText: "save that" };
  },
  recordLentActionGrant: async () => true,
  sweepExpiredLentActionGrants: async () => undefined,
}));

vi.mock("../run-window-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-window-turn")>();
  return {
    boundScreenClaimForSurface: actual.boundScreenClaimForSurface,
    canActorRespondToRun: async () => true,
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
const triggerRow: { row: Record<string, unknown> | null } = { row: null };
vi.mock("@cinatra-ai/agents/trigger-store", () => ({
  readRunTriggerByRunId: async () => triggerRow.row,
}));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import {
  DEFAULT_RECURRING_CONFIG,
  armedScheduleFormValues,
} from "@cinatra-ai/agents/trigger-recurrence";
import { SAVE_SCHEDULE_REFUSALS } from "@cinatra-ai/agents/trigger-service";
import { encodeScheduleRunRef } from "../lifecycle-card-ref";
import { mintLentActionGrant } from "../lent-action-grant";
import {
  ARMED_SCHEDULE_FORM_X_RENDERER,
  armedScheduleFormSchema,
} from "../schedule-form-screen";
import { recordBoundScreenFill } from "../bound-screen-fill";
import {
  LENT_ACTION_CARD_UNAVAILABLE,
  LENT_ACTION_NOTHING_PLACED_TO_SAVE,
  handleLentAction,
} from "../lent-action-mcp";
import { issueTurnLentActionGrant } from "../bound-card-binding";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const OTHER = { userId: "usr_2", orgId: "org_1" };
const RUN = "run_armed_fix3";
const REF = encodeScheduleRunRef({ runId: RUN })!;
/** THE SAME FORM, ADDRESSED AGAIN. Every turn mints the armed form's reference
 *  fresh and the encoding is randomised, so this is a DIFFERENT STRING for the
 *  same run — which is what the road really sees on the turn after a fill. */
const REF_NEXT_TURN = encodeScheduleRunRef({ runId: RUN })!;

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
const decide = vi.fn(async (_i: Record<string, unknown>) => ({ kind: "saved", runId: RUN }) as never);

function mint(messageId: string) {
  const minted = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId,
    cardRef: REF,
    control: "save",
  });
  if (!minted) throw new Error("mint failed");
  return minted;
}

/** The person sends a message with the armed form bound: a grant on the frame. */
function sendAs(messageId: string) {
  grantSpent = false;
  frame.store = {
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    lentActionGrant: mint(messageId).grant,
  };
}

beforeEach(() => {
  frame.store = undefined;
  windowRows.length = 0;
  grantSpent = false;
  rowClock = new Date("2026-08-29T10:00:00.000Z");
  triggerRow.row = {
    runId: RUN,
    triggerType: "recurring",
    scheduledAt: null,
    updatedAt: new Date("2026-08-29T09:00:00.000Z"),
  };
  resolveArmed.mockClear().mockImplementation(async () => armedResolution() as never);
  resolveActor.mockClear().mockImplementation(async () => ACTOR as never);
  decide.mockClear().mockImplementation(async () => ({ kind: "saved", runId: RUN }) as never);
});

// ---------------------------------------------------------------------------
// DEFECT 1 — the turn is TOLD about the road it is supposed to take.
// ---------------------------------------------------------------------------
describe("an armed schedule form gets its own turn context", () => {
  async function contextFor(resolution: Record<string, unknown>) {
    const out = await issueTurnLentActionGrant({
      claim: { candidateRefs: [REF], focusedRef: REF },
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      messageId: "msg_1",
      messageText: "move it to Tuesdays at 9",
      deps: {
        resolveActor: (async () => ACTOR) as never,
        resolveBinding: (async () => ({
          kind: "bound",
          ref: REF,
          resolution,
          controls: ["fill", "save"],
        })) as never,
        record: (async () => true) as never,
        sweep: (async () => undefined) as never,
      },
    });
    return out.systemContext;
  }

  it("names the FILL road and the form's own rows — it is not a review", async () => {
    const ctx = await contextFor(armedResolution());
    expect(ctx).toContain("lifecycle_bound_screen_fill");
    // The rows the form actually draws, so the assistant addresses those and
    // not the schema's inner keys.
    for (const row of ["scheduledAt", "timezone", "weekdays", "hour", "minute"]) {
      expect(ctx, row).toContain(row);
    }
    // The review card's own text must never stand in for this form's.
    expect(ctx).not.toContain("a review the person is looking at");
    expect(ctx).toContain("BOUND SCREEN");
  });

  it("names the SAVE as the separate thing that must be asked for, and the order", async () => {
    const ctx = await contextFor(armedResolution());
    expect(ctx).toContain("lifecycle_bound_card_decide");
    expect(ctx).toContain("FILL IT FIRST");
  });

  it("a schedule that can no longer be changed says so, and lends no press", async () => {
    const ctx = await contextFor(
      armedResolution({ canSave: false, refusal: SAVE_SCHEDULE_REFUSALS.released }),
    );
    expect(ctx).toContain(SAVE_SCHEDULE_REFUSALS.released);
    expect(ctx).toContain("CANNOT BE CHANGED");
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — the person places the change, THEN asks for it to be saved.
// ---------------------------------------------------------------------------
describe("a bare ask to save saves what the earlier turn placed", () => {
  async function placeOn(messageId: string, values: Record<string, unknown>, who = ACTOR) {
    const out = await recordBoundScreenFill({
      ref: REF,
      values,
      actorCtx: who,
      messageId,
      deps: { resolve: resolveArmed as never, surface: "armed-trigger" },
    });
    expect(out.kind).toBe("filled");
  }

  it("turn 1 places the rows; turn 2 says only 'save that' and the row moves", async () => {
    await placeOn("msg_1", { weekdays: [2], hour: 9 });
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_2");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
    const call = decide.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.op).toBe("save");
    expect(call.schedule).toEqual({
      kind: "recurring",
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Berlin",
    });
  });

  it("every fill placed since the last save is carried, in the order placed", async () => {
    await placeOn("msg_1", { weekdays: [2] });
    rowClock = new Date("2026-08-29T10:02:00.000Z");
    await placeOn("msg_2", { hour: 9 });
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_3");
    await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const call = decide.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.schedule).toEqual({
      kind: "recurring",
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Berlin",
    });
  });

  it("the form's reference is a DIFFERENT STRING next turn — the carry still finds it", async () => {
    // THE DEFECT THIS PINS (convergence round 2, finding 1). Turn 1 records its
    // fill under the reference IT was handed; turn 2 is handed a freshly minted
    // one for the same run. Matched on the bytes, the placement is invisible and
    // the person is told nothing was placed while they look at a full form.
    expect(REF_NEXT_TURN).not.toBe(REF);
    await placeOn("msg_1", { weekdays: [2], hour: 9 });
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    grantSpent = false;
    const minted = mintLentActionGrant({
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      messageId: "msg_2",
      cardRef: REF_NEXT_TURN,
      control: "save",
    })!;
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: minted.grant,
    };
    const res = await handleLentAction(
      { ref: REF_NEXT_TURN },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
    expect((decide.mock.calls[0]![0] as Record<string, unknown>).schedule).toEqual({
      kind: "recurring",
      selection: { ...ARMED.selection, weekdays: [2], hour: 9 },
      timezone: "Europe/Berlin",
    });
  });

  it("no readable boundary carries NOTHING — the look-back is never unbounded", async () => {
    // The form's own row cannot be read, so "not already saved" has no meaning.
    // Carrying everything would re-apply a placement the person walked away
    // from; the turn answers what is true instead (convergence round 2, finding 2).
    await placeOn("msg_1", { weekdays: [2], hour: 9 });
    triggerRow.row = null;
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_2");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
  });

  it("a placement stamped at the instant of the write counts as SAVED", async () => {
    // Two clocks, not one: the row's stamp comes from the database and the
    // form's from the application. On a tie the placement is treated as saved,
    // because re-applying a change the person already saved is the outcome they
    // did not ask for (convergence round 2, finding 2).
    rowClock = new Date("2026-08-29T10:01:00.000Z");
    await placeOn("msg_1", { weekdays: [2], hour: 9 });
    triggerRow.row = {
      runId: RUN,
      triggerType: "recurring",
      scheduledAt: null,
      updatedAt: new Date("2026-08-29T10:01:00.000Z"),
    };
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_2");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
  });

  it("a fill ALREADY SAVED is not carried into a later bare ask", async () => {
    await placeOn("msg_1", { weekdays: [2], hour: 9 });
    // The save landed: the trigger row was written after that placement.
    triggerRow.row = {
      runId: RUN,
      triggerType: "recurring",
      scheduledAt: null,
      updatedAt: new Date("2026-08-29T10:01:00.000Z"),
    };
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_2");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
  });

  it("ANOTHER person's placement never travels under this person's ask", async () => {
    const otherActor = {
      ...ACTOR,
      actor: { ...(ACTOR as never as { actor: object }).actor, userId: OTHER.userId },
    } as unknown as ReviewActorContext;
    await placeOn("msg_other", { weekdays: [5], hour: 23 }, otherActor);
    rowClock = new Date("2026-08-29T10:05:00.000Z");
    sendAs("msg_2");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
  });

  it("N identical asks in a row all land, every one of them", async () => {
    for (let i = 0; i < 8; i += 1) {
      windowRows.length = 0;
      decide.mockClear();
      rowClock = new Date(`2026-08-29T10:${String(10 + i).padStart(2, "0")}:00.000Z`);
      await placeOn(`fill_${i}`, { weekdays: [2], hour: 9 });
      rowClock = new Date(`2026-08-29T10:${String(11 + i).padStart(2, "0")}:00.000Z`);
      sendAs(`save_${i}`);
      const res = await handleLentAction(
        { ref: REF },
        {
          resolve: resolveArmed as never,
          resolveActor: resolveActor as never,
          decideSchedule: decide as never,
        },
      );
      expect((res.structuredContent as { ok: boolean }).ok, `ask ${i}`).toBe(true);
      expect(decide, `ask ${i}`).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — the sentence names the TRUE reason.
// ---------------------------------------------------------------------------
describe("a refusal never states an authorization reason the owner disproves", () => {
  it("nothing placed to save says exactly that — not 'not available to you'", async () => {
    sendAs("msg_1");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: resolveArmed as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    const body = res.structuredContent as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toBe(LENT_ACTION_NOTHING_PLACED_TO_SAVE);
    expect(body.message).not.toBe(LENT_ACTION_CARD_UNAVAILABLE);
  });

  it("each state that can no longer be saved answers with its own reason", async () => {
    const table = [
      SAVE_SCHEDULE_REFUSALS.firedOneOff,
      SAVE_SCHEDULE_REFUSALS.released,
      SAVE_SCHEDULE_REFUSALS.stopped,
      SAVE_SCHEDULE_REFUSALS.arming,
      SAVE_SCHEDULE_REFUSALS.noTrigger,
    ];
    for (const refusal of table) {
      sendAs("msg_r");
      const res = await handleLentAction(
        { ref: REF },
        {
          resolve: (async () =>
            armedResolution({ canSave: false, refusal }) as never) as never,
          resolveActor: resolveActor as never,
          decideSchedule: decide as never,
        },
      );
      const body = res.structuredContent as { ok: boolean; message: string };
      expect(body.ok).toBe(false);
      expect(body.message, refusal).toBe(refusal);
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("a card that is genuinely not this person's keeps the one fixed sentence", async () => {
    sendAs("msg_1");
    const res = await handleLentAction(
      { ref: REF },
      {
        resolve: (async () => ({ kind: "absent" }) as never) as never,
        resolveActor: resolveActor as never,
        decideSchedule: decide as never,
      },
    );
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_CARD_UNAVAILABLE,
    );
  });
});
