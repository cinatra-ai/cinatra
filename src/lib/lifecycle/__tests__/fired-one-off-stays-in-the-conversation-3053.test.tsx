// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE FIRED ONE-OFF'S CARD STAYS IN THE CONVERSATION (cinatra#3044, the eighth
// set's first defect).
// ---------------------------------------------------------------------------
// The ratified drawing, §VI: "One card, five readings, and never a second card.
// The card is drawn once and stays where it is; what changes across its life is
// the floor beneath the rows and whether the rows still take a change." The
// fifth of those readings is "Fired, one-off — the schedule was spent |
// read-only | none at all", and the fired one-off's own example says it in
// prose: "A one-time schedule is spent once it fires, so the rows below are the
// record of it and cannot be changed."
//
// WHAT WAS MEASURED. A run started from a conversation reached its schedule
// moment, the reader confirmed the card's own default row and the run fired —
// and the card was WITHDRAWN from the conversation, leaving the slot to fall
// back to the bare working placeholder.
//
// THIS FILE IS THE CHAIN, in the two links this module owns:
//
//   1. THE REFERENCE CARRIES THE FACT. The schedule moment is opened with a
//      run-scoped reference the server mints and seals; the executor stamps it
//      where — and only where — the run's OWN schedule step opened in a
//      conversation. A reference minted anywhere else carries no stamp.
//   2. THE RESOLVER IS TOLD. The card's resolver hands that stamp to the service
//      on every road it takes a run-addressed reference down — the read and the
//      press alike — so a card a reader can SEE is a card the press reaches.
//
// The service is a double here, and it answers exactly what the real one
// answers: a fired one-off drawn for the run that answered its own schedule
// step, and `absent` for the run that never had one. The service's own half is
// pinned against the real code in
// `packages/agents/src/__tests__/schedule-fired-one-off-stays-a-reading-3053.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  confirmTriggerScheduleProposal: vi.fn(),
  adjustTriggerSchedule: vi.fn(),
  reproposeExpiredSchedule: vi.fn(),
  describeProposalSchedule: () => "Runs right after setup",
  PROPOSAL_REFUSALS: {
    invalid: "That schedule isn't one I can set.",
    notRunnable: "This agent can't be run on this instance.",
  },
}));

const armRunScheduleForActor = vi.fn();
vi.mock("@cinatra-ai/agents/trigger-service", () => ({
  armRunScheduleForActor: (...a: unknown[]) => armRunScheduleForActor(...a),
  updateRunTriggerScheduleForActor: vi.fn(),
  stopRecurringTriggerForActor: vi.fn(),
}));

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ScheduleProposalCard } from "@cinatra-ai/agents/schedule-proposal-card";

import { decodeScheduleRunRef, encodeScheduleRunRef } from "../lifecycle-card-ref";
import {
  decideTriggerScheduleProposal,
  resolveTriggerScheduleProposalCard,
} from "../trigger-schedule-proposal-card";

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

const RUN_ID = "run-3053-conversation";
const READER = { userId: "u-1", orgId: "org-1" };

/** The reference the executor mints when the run's own schedule step opens. */
const STEP_REF = encodeScheduleRunRef({ runId: RUN_ID, fromScheduleStep: true })!;
/** The reference every other minting site produces. */
const PLAIN_REF = encodeScheduleRunRef({ runId: RUN_ID })!;

/** What the real service answers for a spent **Run right after setup**. */
const FIRED_ONE_OFF = {
  phase: "settled" as const,
  runId: RUN_ID,
  agentName: "Q3 cohort sweep",
  triggerType: "immediate" as const,
  scheduleCopy: "Runs right after setup",
  timezone: "UTC",
  schedule: { kind: "immediate" as const },
  released: true,
  arming: false,
  firedOnce: true,
  stopped: false,
  canSave: false,
  superseded: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveProposalForReader.mockResolvedValue({ phase: "absent" });
  // The service's own contract, as a double: the fired one-off is drawn for the
  // run that answered its own schedule step, and for nobody else.
  resolveProposalForRun.mockImplementation(
    async (_runId: string, _actor: unknown, _access: unknown, options?: unknown) =>
      (options as { fromScheduleStep?: boolean } | undefined)?.fromScheduleStep
        ? FIRED_ONE_OFF
        : { phase: "absent" },
  );
  armRunScheduleForActor.mockResolvedValue({ ok: true, runId: RUN_ID, alreadyArmed: false });
});

afterEach(cleanup);

describe("the reference the schedule moment is opened with", () => {
  it("carries the fact that the run's own schedule step opened it", () => {
    expect(decodeScheduleRunRef(STEP_REF)).toEqual({
      runId: RUN_ID,
      fromScheduleStep: true,
    });
  });

  it("carries nothing of the kind when it was minted anywhere else", () => {
    expect(decodeScheduleRunRef(PLAIN_REF)).toEqual({ runId: RUN_ID });
  });

  it("is still sealed — the stamp is not a field a caller can set", () => {
    expect(STEP_REF).not.toContain(RUN_ID);
    expect(decodeScheduleRunRef(`${STEP_REF.slice(0, -2)}xx`)).toBeNull();
  });
});

describe("once it has fired, the card is a reading", () => {
  it("is drawn from the run's own schedule step rather than withdrawn", async () => {
    const card = await resolveTriggerScheduleProposalCard({ ref: STEP_REF, ...READER });

    expect(resolveProposalForRun).toHaveBeenCalledWith(
      RUN_ID,
      READER,
      undefined,
      { fromScheduleStep: true },
    );
    expect(card.state).toEqual({ state: "settled" });
    expect(card.view).not.toBeNull();
    expect(card.view!.phase).toBe("settled");
    if (card.view!.phase !== "settled") return;
    // THE FLOOR: none at all. Neither control is offered on a spent one-off.
    expect(card.view!.canSave).toBe(false);
    expect(card.view!.canCancel).toBe(false);
    expect(card.view!.released).toBe(true);
  });

  it("keeps the refusal for a run that never had a schedule step", async () => {
    const card = await resolveTriggerScheduleProposalCard({ ref: PLAIN_REF, ...READER });

    expect(resolveProposalForRun).toHaveBeenCalledWith(RUN_ID, READER, undefined, {
      fromScheduleStep: false,
    });
    expect(card.view).toBeNull();
  });

  it("takes the same standing to the press, so a drawn card can be acted on", async () => {
    await decideTriggerScheduleProposal({
      ref: STEP_REF,
      op: "confirm",
      userId: READER.userId,
      orgId: READER.orgId,
      role: null,
    });

    expect(resolveProposalForRun).toHaveBeenCalledWith(
      RUN_ID,
      READER,
      undefined,
      { fromScheduleStep: true },
    );
  });
});

describe.each(["chat_thread", "site_widget"] as const)(
  "the reading as it stands on the %s host",
  (host) => {
    it("draws the rows read-only and carries no floor at all", async () => {
      const card = await resolveTriggerScheduleProposalCard({ ref: STEP_REF, ...READER });
      expect(card.view).not.toBeNull();

      // The card resolves itself over its own endpoint on every host; the
      // answer here is the one the resolver above actually produced.
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              kind: "trigger_schedule_proposal",
              state: card.state,
              body: card.view,
              // THE FIRED READING RIDES THE ANSWER, exactly as the endpoint
              // composes it (cinatra#3174 fix leg 1): a one-off's gate stamp is
              // no longer read as its firing on its own, so the reading the
              // producer resolved travels beside the body.
              ...(card.firedOnce ? { firedOnce: true } : {}),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as unknown as typeof fetch;

      const { container } = render(
        <LifecycleCardSurfaceProvider
          host={host}
          auth={host === "site_widget" ? WIDGET_AUTH : undefined}
          frame={host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined}
        >
          <ScheduleProposalCard
            view={{
              viewType: "trigger_schedule_proposal",
              schemaVersion: 1,
              ref: STEP_REF,
            }}
          />
        </LifecycleCardSurfaceProvider>,
      );

      // THE ROWS ARE THE READING — they are drawn, and they are the whole card.
      await waitFor(() => {
        expect(
          container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull();
      });
      // NONE AT ALL: no floor, and so no control to press.
      expect(
        container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
      ).toBeNull();
      expect(container.querySelector("[data-action]")).toBeNull();
      // THE PICKERS ARE GONE, and the assertion says GONE rather than
      // "present but disabled" (a convergence finding). The loop this replaces
      // accepted a drawn-and-disabled picker, and on this reading it iterated an
      // empty set, so it asserted nothing at all. The drawing is literal — "the
      // values still legible, the pickers gone" — so the reading is asserted as
      // the absence of every picker element, which is what would break if the
      // frozen card ever drew one.
      const rows = container.querySelector(
        '[data-conformance-id="schedule-option-rows"]',
      );
      expect(rows).not.toBeNull();
      expect(rows!.querySelectorAll("input, select, textarea").length).toBe(0);
      expect(rows!.querySelectorAll('[role="combobox"]').length).toBe(0);
      // The rows themselves stay drawn, and not one of them is a control any
      // more: "the pickers gone" reaches the ROW as well as the fields inside
      // it (cinatra#3174 fix leg 1). The reading keeps all three rows, drawn as
      // markers and labels, with nothing in the rows to press.
      expect(rows!.querySelectorAll("[data-schedule-option]").length).toBe(3);
      expect(rows!.querySelectorAll("button").length).toBe(0);
      for (const row of rows!.querySelectorAll("[data-schedule-option]")) {
        expect(row.textContent?.length ?? 0).toBeGreaterThan(0);
      }
    });
  },
);
