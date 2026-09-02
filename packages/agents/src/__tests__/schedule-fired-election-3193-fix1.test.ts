/**
 * WHAT MAKES A SCHEDULE "FIRED" — the durable record, never the gate stamp
 * (cinatra#3174, fix leg 1 after the first graded proof round).
 *
 * THE ROW THE FIRST ROUND GRADED. Trigger type `immediate`, `released_at`
 * stamped at 15:00:01Z, `last_fired_at` NULL, and the run it gated FAILED
 * without ever starting. The card elected "fired, one-off" from that row and
 * the turn above it therefore said "It ran at the time you set." — of a run
 * that never ran. Section VI gives that reading its words on one condition:
 * "Once it has fired, the card is a reading… A one-time schedule is spent once
 * it fires." A gate that opened over a run that then failed is not a firing.
 *
 * `released_at` IS THE GATE OPENING, NOT THE FIRING. `markTriggerReleasedInDb`
 * stamps it when the release job opens the side-effect gate; the transition
 * table's own `armed->failed` edge ("defensive — failure during arming/release")
 * is the road that leaves it stamped over a run that never ran. So the one-off
 * family reads the gate stamp AND the run's own durable record together, and
 * the recurring family keeps reading its own tick stamp (`lastFiredAt`), which
 * is written once per fire and says nothing about any one run.
 *
 * Pure — no DB, no session, no render.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schedule-fired-election-3193-fix1.test.ts
 */
import { describe, expect, it } from "vitest";

import { scheduleFiredOnce } from "../trigger-schedule-proposal-service";

const NOW = new Date();
const RAN = { status: "completed", startedAt: NOW };
/** The graded run, exactly: it failed, and it never started. */
const NEVER_RAN = { status: "failed", startedAt: null };

describe("a ONE-OFF schedule is spent only when the run it gated actually ran", () => {
  it("is NOT fired when the gate opened over a run that failed without starting", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: NOW,
        lastFiredAt: null,
        run: NEVER_RAN,
      }),
    ).toBe(false);
  });

  it("is NOT fired for the `scheduled` half of the same family either", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "scheduled",
        releasedAt: NOW,
        lastFiredAt: null,
        run: NEVER_RAN,
      }),
    ).toBe(false);
  });

  it("IS fired once the run it gated ran", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: NOW,
        lastFiredAt: null,
        run: RAN,
      }),
    ).toBe(true);
  });

  it("is NOT fired before the gate has opened at all", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "scheduled",
        releasedAt: null,
        lastFiredAt: null,
        run: { status: "armed", startedAt: null },
      }),
    ).toBe(false);
  });

  it("is NOT fired when the run cannot be read — an unknown record is never a firing", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: NOW,
        lastFiredAt: null,
        run: null,
      }),
    ).toBe(false);
  });
});

describe("a RECURRING schedule keeps its own tick stamp, untouched by this change", () => {
  it("is fired on its tick stamp, whatever the defining run did", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: null,
        lastFiredAt: NOW,
        run: NEVER_RAN,
      }),
    ).toBe(true);
  });

  it("is NOT fired before its first tick, even with the gate stamp set", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: NOW,
        lastFiredAt: null,
        run: RAN,
      }),
    ).toBe(false);
  });
});
