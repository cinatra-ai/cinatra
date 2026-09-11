// A CARD THAT IS NOT THIS PERSON'S TO ACT ON (cinatra#2934, the FOURTH graded
// capture of this pull request).
//
// WHAT THE CAPTURE MEASURED. A second person, signed up through the app's own
// form, opened the same run's schedule surface. Their described change was
// PLACED into the card owner's form rows, **Save changes** was drawn LIVE for
// them, and one of their asks was answered "Saved." while the trigger row never
// moved at all. Two of their four replies were the owner-shaped sentences —
// including the fields-do-not-exist one — so at no point was the true reason
// stated.
//
// THE RULE, from plan (A) §1.2 "Who sees a card": "If you may see it but not act
// on it, the card is drawn in full with its buttons disabled and the reason on
// the card." And §7.1's own sentence for this surface: "Who may do what: Cancel
// is the run's owner or an administrator."
//
// THE CAUSE IN CODE. `canSaveInstalled` is a reading of the SCHEDULE — arming,
// stopped, released, in the future — and asks nothing about the person. Every
// surface downstream of it (the card's live Save changes, the resolver's
// `canSave`, the fill road, the turn's own context) therefore offered what the
// write itself would refuse, because the write is the ONLY place the owner rule
// was asked.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-nonowner";

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
  SAVE_SCHEDULE_REFUSALS,
  armedScheduleFormValues,
  mayChangeRunSchedule,
} from "@cinatra-ai/agents/trigger-recurrence";
import { encodeScheduleRunRef } from "../lifecycle-card-ref";
import { resolveBoundReference } from "../bound-reference-resolver";
import { recordBoundScreenFill } from "../bound-screen-fill";
import { armedScheduleFormSchema, ARMED_SCHEDULE_FORM_X_RENDERER } from "../schedule-form-screen";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const RUN = "run_nonowner";
const REF = encodeScheduleRunRef({ runId: RUN })!;
const OWNER = "usr_owner";
const OTHER = "usr_second_person";

function actorFor(userId: string, platformRole = "member"): ReviewActorContext {
  return {
    actor: { actorType: "human", source: "agent", userId, orgId: "org_1" },
    orgId: "org_1",
    roleHints: { platformRole, orgRole: "member", actorOrganizationId: "org_1" },
  } as unknown as ReviewActorContext;
}

const SCHEDULE = {
  kind: "scheduled" as const,
  runAt: "2026-09-01T09:00",
  timezone: "Europe/Berlin",
};

function portsFor(): Record<string, unknown> {
  return {
    enforceRunRead: async () => true,
    readRunTrigger: async () => null,
    readArmedSchedule: async () => ({
      phase: "settled",
      runId: RUN,
      agentName: "an agent",
      triggerType: "scheduled",
      scheduleCopy: "Once",
      timezone: "Europe/Berlin",
      schedule: SCHEDULE,
      released: false,
      arming: false,
      firedOnce: false,
      stopped: false,
      // THE SCHEDULE'S OWN READING SAYS YES — it is armed, in the future, not
      // stopped and not arming. Whether THIS person may change it is a separate
      // question, and it is the one the capture found nobody asking.
      canSave: true,
      saveRefusal: null,
      runOwnerId: OWNER,
      superseded: false,
    }),
    armedScheduleRefusal: async () => SAVE_SCHEDULE_REFUSALS.released,
  };
}

describe("who may change a run's schedule", () => {
  it("is the run's owner or an administrator, and nobody else", () => {
    expect(mayChangeRunSchedule({ actorUserId: OWNER, isAdmin: false, runOwnerId: OWNER })).toBe(true);
    expect(mayChangeRunSchedule({ actorUserId: OTHER, isAdmin: true, runOwnerId: OWNER })).toBe(true);
    expect(mayChangeRunSchedule({ actorUserId: OTHER, isAdmin: false, runOwnerId: OWNER })).toBe(false);
    // An unowned run needs an administrator — the same fail-closed reading the
    // write itself has always taken.
    expect(mayChangeRunSchedule({ actorUserId: OTHER, isAdmin: false, runOwnerId: null })).toBe(false);
    expect(mayChangeRunSchedule({ actorUserId: null, isAdmin: false, runOwnerId: null })).toBe(false);
  });
});

describe("a second person on someone else's armed schedule", () => {
  it("is told the true reason, and the form lends them no save", async () => {
    const bound = await resolveBoundReference({
      ref: REF,
      actorCtx: actorFor(OTHER),
      ports: portsFor() as never,
    });
    expect(bound.kind).toBe("armed_schedule_form");
    const armed = bound as Extract<typeof bound, { kind: "armed_schedule_form" }>;
    expect(armed.canSave).toBe(false);
    expect(armed.refusal).toBe(SAVE_SCHEDULE_REFUSALS.notYours);
    // AND IT IS NOT THE STATE SENTENCE. The schedule is perfectly changeable;
    // saying it is over would be as false as saying the field does not exist.
    expect(armed.refusal).not.toBe(SAVE_SCHEDULE_REFUSALS.released);
    expect(armed.refusal).not.toBe(SAVE_SCHEDULE_REFUSALS.firedOneOff);
  });

  it("the card owner is unaffected", async () => {
    const bound = await resolveBoundReference({
      ref: REF,
      actorCtx: actorFor(OWNER),
      ports: portsFor() as never,
    });
    const armed = bound as Extract<typeof bound, { kind: "armed_schedule_form" }>;
    expect(armed.canSave).toBe(true);
    expect(armed.refusal).toBeNull();
  });

  it("an administrator may change it", async () => {
    const bound = await resolveBoundReference({
      ref: REF,
      actorCtx: actorFor(OTHER, "platform_admin"),
      ports: portsFor() as never,
    });
    const armed = bound as Extract<typeof bound, { kind: "armed_schedule_form" }>;
    expect(armed.canSave).toBe(true);
  });

  it("their described change places NOTHING in the owner's rows", async () => {
    const append = vi.fn(async () => ({}) as never);
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { scheduledAt: "2026-09-02T15:00" },
      actorCtx: actorFor(OTHER),
      messageId: "their_turn",
      deps: {
        resolve: (async () =>
          ({
            kind: "armed_schedule_form",
            runId: RUN,
            xRenderer: ARMED_SCHEDULE_FORM_X_RENDERER,
            canSave: false,
            refusal: SAVE_SCHEDULE_REFUSALS.notYours,
            schedule: SCHEDULE,
            form: {
              schema: armedScheduleFormSchema(),
              values: armedScheduleFormValues(SCHEDULE as never),
            },
          }) as never) as never,
        canRespond: (async () => true) as never,
        append: append as never,
      },
    });
    expect(outcome.kind).toBe("not-editable");
    expect((outcome as { message: string }).message).toBe(SAVE_SCHEDULE_REFUSALS.notYours);
    // NOTHING WAS RECORDED, so nothing reaches the owner's form rows and no
    // later bare save can commit it either.
    expect(append).not.toHaveBeenCalled();
  });
});
