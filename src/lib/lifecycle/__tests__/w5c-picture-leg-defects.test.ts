// THE THREE DEFECTS THE PICTURE LEG FOUND, each pinned where it was caused
// (cinatra#2934, lifecycle-b W5c).
//
// The leg was taken on the real running app and graded seven cells. Two failed
// and a third defect fell out of the readbacks:
//
//   1. THE RUN PAGE — the fill was recorded and reported and never reached the
//      field in view. The closed set was read from the interrupt's own
//      `properties`, which for a setup-loop gate are the INNER keys of the
//      template's single object-valued property; the screen draws that whole
//      object as ONE control. Measured: `field-idea` "" -> "" while a fill row
//      `{"title":"…"}` was recorded and the answer claimed the values were
//      placed on the person's screen.
//   2. THE SCHEDULE SCREEN — the window was offered the wrong screen's fields.
//      For a run waiting on its trigger the bound screen was still the run's
//      HITL gate row while the surface in view is the SCHEDULER FORM. Measured:
//      "This screen can't schedule the run. It only has these fields: title /
//      summary / outline"; `scheduledAt` "" -> "".
//   3. (in `packages/agents`) the fill counter was never seeded from the fills
//      the run already held.
//
// The REAL handlers run; what is substituted is the world under them.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-picture-leg";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));

const appended: Array<Record<string, unknown>> = [];
const windowRows: Array<Record<string, unknown>> = [];
vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  appendRunWindowMessage: async (input: Record<string, unknown>) => {
    appended.push(input);
    const row = { ...input, id: `m${appended.length}`, sequence: appended.length };
    windowRows.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...windowRows],
  readRunWindowFillsForMessage: async () => [],
  readRunWindowAttachmentsForMessage: async () => null,
}));

let grantIsSpendable = true;
vi.mock("../lent-action-grant-store", () => ({
  lentActionGrantIsSpendable: async () => grantIsSpendable,
  consumeLentActionGrant: async () => ({ outcome: "refused" }),
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
  approveReviewTaskInternal: vi.fn(async () => {}),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);

let runReadable = true;
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: async () => ({ ok: runReadable }),
  readGatePinnedTargets: async () => ({ status: "resolved", targets: [] }),
}));
let parkedScreen: Record<string, unknown> | null = null;
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: async () => parkedScreen,
}));
let triggerRow: Record<string, unknown> | null = null;
vi.mock("@cinatra-ai/agents/trigger-store", () => ({
  readRunTriggerByRunId: async () => triggerRow,
}));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import {
  encodeLifecycleGateRef,
  encodeScheduleFormRef,
  decodeLifecycleGateRef,
  decodeScheduleFormRef,
} from "../lifecycle-card-ref";
import {
  LENT_ACTION_CONTROLS,
  LENT_ACTION_GRANT_CONTROLS,
  matchLentActionGrant,
  matchLentActionGrantCard,
  mintLentActionGrant,
} from "../lent-action-grant";
import {
  drawnScreenControls,
  drawnScreenForm,
  fillableFieldNames,
  selectDrawnFillValues,
} from "../bound-screen-controls";
import { recordBoundScreenFill } from "../bound-screen-fill";
import { handleBoundScreenFill } from "../bound-screen-fill-mcp";
import { handleLentAction } from "../lent-action-mcp";
import { controlsLentBy, resolveBoundReference } from "../bound-reference-resolver";
import {
  grantedControlFor,
  primaryControlFor,
  resolveBoundCard,
} from "../bound-card-binding";
import { boundScreenClaimForSurface } from "../run-window-turn";
import { scheduleFormRowNames, scheduleFormValues } from "../schedule-form-screen";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_1";
const SCREEN = "setup-run_1";
const GATE_REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: SCREEN })!;
const FORM_REF = encodeScheduleFormRef({ runId: RUN })!;

const ACTOR: ReviewActorContext = {
  actor: {
    actorType: "human",
    source: "ui",
    userId: PERSON.userId,
    organizationId: PERSON.orgId,
    roles: [],
  },
  orgId: PERSON.orgId,
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

// ---------------------------------------------------------------------------
// The blog-draft-writer's setup gate, EXACTLY as the store holds it: the INNER
// schema of the template's single object-valued `idea` property, with the
// property's own name beside it.
// ---------------------------------------------------------------------------
const IDEA_INNER_SCHEMA = {
  type: "object",
  "x-object-text-property": "title",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    outline: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
};
const IDEA_FORM = { schema: IDEA_INNER_SCHEMA, values: {}, fieldName: "idea" };

/** The email-outreach agent's GROUPED setup gate — the shape whose cells passed. */
const OUTREACH_FORM = {
  schema: {
    type: "object",
    properties: {
      offeringCompanyWebsite: { type: "string" },
      callToAction: { type: "string" },
      senderName: { type: "string" },
    },
  },
  values: {},
};

function mint(control: string, ref: string) {
  const minted = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId: "msg_1",
    cardRef: ref,
    control: control as never,
  });
  if (!minted) throw new Error("mint failed");
  return minted;
}

function bindFrame(control: string, ref: string) {
  frame.store = {
    lentActionGrant: mint(control, ref).grant,
    userId: PERSON.userId,
    orgId: PERSON.orgId,
  };
}

const resolveActor = vi.fn(async () => ACTOR as never);

beforeEach(() => {
  frame.store = undefined;
  appended.length = 0;
  windowRows.length = 0;
  grantIsSpendable = true;
  mayRespond = true;
  runReadable = true;
  parkedScreen = null;
  triggerRow = null;
  resolveActor.mockClear().mockImplementation(async () => ACTOR as never);
});

// ---------------------------------------------------------------------------
// DEFECT 1 — the closed set is the DRAWN controls of the screen in view.
// ---------------------------------------------------------------------------
describe("the fill's closed set is what the screen draws", () => {
  it("a setup-loop screen draws ONE control, named by the gate's own field", () => {
    // The defect, stated as the thing that must no longer be true: the raw
    // schema's properties are the INNER keys.
    expect(fillableFieldNames(IDEA_INNER_SCHEMA)).toEqual(["title", "summary", "outline"]);
    // What the screen actually renders.
    expect(drawnScreenControls(IDEA_FORM)).toEqual(["idea"]);
    expect(drawnScreenForm(IDEA_FORM).schema).toEqual({
      type: "object",
      properties: { idea: IDEA_INNER_SCHEMA },
    });
  });

  it("a text ask lands in the drawn control through its x-object-text-property", () => {
    expect(
      selectDrawnFillValues(IDEA_FORM, {
        idea: "A weekly publishing rhythm beats a burst of posts",
      }),
    ).toEqual({ idea: { title: "A weekly publishing rhythm beats a burst of posts" } });
  });

  it("further keys land only when the ask names them, and companions survive", () => {
    const held = { ...IDEA_FORM, values: { idea: { title: "old", summary: "kept" } } };
    expect(selectDrawnFillValues(held, { idea: { title: "new" } })).toEqual({
      idea: { title: "new", summary: "kept" },
    });
    expect(
      selectDrawnFillValues(held, { idea: { title: "new", outline: ["a", "b"] } }),
    ).toEqual({ idea: { title: "new", summary: "kept", outline: ["a", "b"] } });
  });

  it("an ask that names the INNER key alone places nothing, and says which control exists", async () => {
    const outcome = await recordBoundScreenFill({
      ref: GATE_REF,
      values: { title: "not a control this screen draws" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: {
        resolve: (async () => ({
          kind: "hitl_screen",
          runId: RUN,
          screenRef: SCREEN,
          xRenderer: "setup-field",
          form: IDEA_FORM,
        })) as never,
      },
    });
    expect(outcome).toEqual({ kind: "no-fields", fields: ["idea"] });
    expect(appended).toHaveLength(0);
  });

  it("the fill row the screen can read is written, and nothing is submitted", async () => {
    const outcome = await recordBoundScreenFill({
      ref: GATE_REF,
      values: { idea: "A weekly publishing rhythm beats a burst of posts" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: {
        surface: "run-page",
        resolve: (async () => ({
          kind: "hitl_screen",
          runId: RUN,
          screenRef: SCREEN,
          xRenderer: "setup-field",
          form: IDEA_FORM,
        })) as never,
      },
    });
    expect(outcome).toEqual({ kind: "filled", ref: GATE_REF, applied: ["idea"] });
    // THE KEY THE SCREEN READS. `setupFieldRendererValue` selects
    // `envelope[fieldName]`, so a row keyed anything else is invisible to it.
    expect((appended[0]!.fill as { values: Record<string, unknown> }).values).toEqual({
      idea: { title: "A weekly publishing rhythm beats a burst of posts" },
    });
  });

  it("the multi-field grouped form is untouched — its own names, flat", () => {
    expect(drawnScreenControls(OUTREACH_FORM)).toEqual([
      "offeringCompanyWebsite",
      "callToAction",
      "senderName",
    ]);
    expect(
      selectDrawnFillValues(OUTREACH_FORM, {
        offeringCompanyWebsite: "https://example.test",
        callToAction: "Book a 20-minute demo",
        notAField: "dropped",
      }),
    ).toEqual({
      offeringCompanyWebsite: "https://example.test",
      callToAction: "Book a 20-minute demo",
    });
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — the schedule surface binds the SCHEDULER FORM's own rows.
// ---------------------------------------------------------------------------
describe("the schedule screen binds the scheduler form", () => {
  it("the ref family is disjoint from the gate ref's", () => {
    expect(decodeScheduleFormRef(FORM_REF)).toEqual({ runId: RUN });
    expect(decodeScheduleFormRef(GATE_REF)).toBeNull();
    expect(decodeLifecycleGateRef(FORM_REF)).toBeNull();
  });

  it("the schedule surface offers its form's ref and names no run screen", () => {
    expect(boundScreenClaimForSurface("schedule", RUN, () => "REF")).toEqual({
      screenRunIds: [],
      candidateRefs: ["REF"],
    });
    // Every other surface is byte-for-byte what it was.
    expect(boundScreenClaimForSurface("run-page", RUN)).toEqual({
      screenRunIds: [RUN],
      candidateRefs: [],
    });
    expect(boundScreenClaimForSurface("step-by-step", RUN)).toEqual({
      screenRunIds: [RUN],
      candidateRefs: [],
    });
    // The ARMED tab stays on the run's own screen: the armed form is #2788's.
    expect(boundScreenClaimForSurface("armed-trigger", RUN)).toEqual({
      screenRunIds: [RUN],
      candidateRefs: [],
    });
    expect(boundScreenClaimForSurface("review", RUN)).toEqual({
      screenRunIds: [],
      candidateRefs: [],
    });
  });

  it("resolves to the form's own rows, under the reader's run access", async () => {
    const bound = await resolveBoundReference({ ref: FORM_REF, actorCtx: ACTOR });
    expect(bound.kind).toBe("schedule_form");
    if (bound.kind !== "schedule_form") throw new Error("unreachable");
    expect(Object.keys(bound.form.schema.properties as Record<string, unknown>)).toEqual(
      scheduleFormRowNames(),
    );
    expect(bound.form.schema.properties).toHaveProperty("triggerType");
    expect(bound.form.schema.properties).toHaveProperty("scheduledAt");
    expect(bound.form.schema.properties).toHaveProperty("timezone");
    runReadable = false;
    expect((await resolveBoundReference({ ref: FORM_REF, actorCtx: ACTOR })).kind).toBe(
      "absent",
    );
  });

  it("lends a fill and NO press — the form's own button stays the person's", () => {
    const form = {
      kind: "schedule_form" as const,
      runId: RUN,
      xRenderer: "schedule-form",
      form: { schema: {}, values: {} },
    };
    expect(controlsLentBy(form)).toEqual(["fill"]);
    expect(primaryControlFor(form)).toBeNull();
    expect(grantedControlFor(form)).toBe("fill");
    // The grant vocabulary may name it; the DECIDE vocabulary may not.
    expect(LENT_ACTION_GRANT_CONTROLS).toContain("fill");
    expect(LENT_ACTION_CONTROLS as readonly string[]).not.toContain("fill");
  });

  it("a fill grant can never press anything", () => {
    const claims = mint("fill", FORM_REF).claims;
    for (const control of LENT_ACTION_CONTROLS) {
      expect(
        matchLentActionGrant(claims, { ...PERSON, cardRef: FORM_REF, control }),
      ).toBe(false);
    }
    // It IS the fact the fill road asks for.
    expect(matchLentActionGrantCard(claims, { ...PERSON, cardRef: FORM_REF })).toBe(true);
  });

  it("'tomorrow at 9 in the morning, Berlin time' lands the three rows, nothing submitted", async () => {
    bindFrame("fill", FORM_REF);
    const result = await handleBoundScreenFill(
      {
        ref: FORM_REF,
        values: {
          triggerType: "scheduled",
          scheduledAt: "2026-08-28T09:00",
          timezone: "Europe/Berlin",
        },
      },
      { resolveActor: resolveActor as never },
    );
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.placed).toEqual([
      "triggerType",
      "scheduledAt",
      "timezone",
    ]);
    expect((appended[0]!.fill as { values: Record<string, unknown> }).values).toEqual({
      triggerType: "scheduled",
      scheduledAt: "2026-08-28T09:00",
      timezone: "Europe/Berlin",
    });
  });

  it("a recurring description lands the recurrence rows, and a value the row cannot hold is dropped", async () => {
    bindFrame("fill", FORM_REF);
    const result = await handleBoundScreenFill(
      {
        ref: FORM_REF,
        values: {
          triggerType: "recurring",
          frequency: "weekly",
          weekdays: [1, 3],
          hour: 9,
          minute: 0,
          // Not a value any control on this form offers.
          quarterAnchor: "whenever",
          // Not a row the form draws at all — §VI: "There is no raw cron field".
          cronExpression: "0 9 * * 1",
        },
      },
      { resolveActor: resolveActor as never },
    );
    expect(result.structuredContent.ok).toBe(true);
    expect((appended[0]!.fill as { values: Record<string, unknown> }).values).toEqual({
      triggerType: "recurring",
      frequency: "weekly",
      weekdays: [1, 3],
      hour: 9,
      minute: 0,
    });
  });

  it("an ask that names no row is answered as a question, with the rows listed", async () => {
    bindFrame("fill", FORM_REF);
    const result = await handleBoundScreenFill(
      { ref: FORM_REF, values: { title: "not a row on this form" } },
      { resolveActor: resolveActor as never },
    );
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.fields).toEqual(scheduleFormRowNames());
    expect(appended).toHaveLength(0);
  });

  it("the lent action refuses the scheduler form outright", async () => {
    for (const control of LENT_ACTION_CONTROLS) {
      bindFrame(control, FORM_REF);
      const result = await handleLentAction(
        { ref: FORM_REF, control },
        { resolveActor: resolveActor as never },
      );
      expect(result.structuredContent.ok).toBe(false);
    }
  });

  it("binds the FORM even with the run parked at a screen \u2014 the measured failure", async () => {
    // The run IS parked at the blog-draft-writer's setup gate; the surface in
    // view is the scheduler form. Before the repair the binder minted THAT
    // gate's ref for this surface and the window answered with its fields.
    parkedScreen = {
      runId: RUN,
      reviewTaskId: SCREEN,
      xRenderer: "setup-field",
      inputSchema: IDEA_INNER_SCHEMA,
      values: {},
      fieldName: "idea",
    };
    const surface = boundScreenClaimForSurface("schedule", RUN);
    const binding = await resolveBoundCard({
      claim: {
        candidateRefs: [...surface.candidateRefs],
        focusedRef: null,
        screenRunIds: [...surface.screenRunIds],
      },
      actorCtx: ACTOR,
      countOpenCards: async () => {
        throw new Error("the review counter has no say over a screen");
      },
    });
    expect(binding.kind).toBe("bound");
    if (binding.kind !== "bound") throw new Error("unreachable");
    expect(binding.resolution.kind).toBe("schedule_form");
    expect(binding.controls).toEqual(["fill"]);
    expect(grantedControlFor(binding.resolution)).toBe("fill");
  });

  it("the run page still binds the run's own parked screen", async () => {
    parkedScreen = {
      runId: RUN,
      reviewTaskId: SCREEN,
      xRenderer: "setup-field",
      inputSchema: IDEA_INNER_SCHEMA,
      values: {},
      fieldName: "idea",
    };
    const surface = boundScreenClaimForSurface("run-page", RUN);
    const binding = await resolveBoundCard({
      claim: {
        candidateRefs: [...surface.candidateRefs],
        focusedRef: null,
        screenRunIds: [...surface.screenRunIds],
      },
      actorCtx: ACTOR,
      countOpenCards: async () => {
        throw new Error("the review counter has no say over a screen");
      },
    });
    expect(binding.kind).toBe("bound");
    if (binding.kind !== "bound") throw new Error("unreachable");
    expect(binding.resolution.kind).toBe("hitl_screen");
    expect(binding.controls).toEqual(["fill", "submit"]);
  });

  it("what the rows are holding is the run's own trigger, or nothing at all", () => {
    expect(scheduleFormValues(null)).toEqual({});
    expect(
      scheduleFormValues({
        triggerType: "scheduled",
        scheduledAt: new Date("2026-08-28T09:00:00.000Z"),
        cronExpression: null,
        timezone: "Europe/Berlin",
      } as never),
    ).toEqual({
      triggerType: "scheduled",
      scheduledAt: "2026-08-28T09:00",
      timezone: "Europe/Berlin",
    });
  });
});
